import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireProfileOwnership } from '../middleware/profileOwnershipMiddleware.js';
import { extractProfileFromChat } from '../services/profileEngine.js';
import { updateProfileContextSummary } from '../services/profileSummaryEngine.js';
import { generateCheckIn } from '../services/checkinEngine.js';
import { answerFromProtocol, answerFromProtocolStream } from '../services/protocolEngine.js';
import { enqueueJob } from '../services/jobQueue.js';
import {
  routeSafety,
  shouldBypassLLM,
  makeSafetyAuditRecord,
} from '../services/deterministicSafetyRouter.js';
import { handleCrisisMessage } from '../services/crisisModeHandler.js';
import { applyPostGenerationFilter } from '../services/postGenerationFilter.js';
import {
  buildCheckinOffer,
  isCheckinOfferDeclined,
} from '../services/checkinPolicy.js';
import {
  buildScheduleConfirmation,
  parseScheduleTimingInput,
} from '../services/scheduleIntentParser.js';
import { classifyIntent, INTENTS, buildConfusionResponse, buildCancelResponse } from '../services/conversationIntentClassifier.js';
import { handleDirectReminder, getRecentReminders, buildReminderFailureResponse } from '../services/directReminderHandler.js';
import {
  buildReminderStatusMessage,
  createScheduledItemsFromOffers,
  updateLatestReminderText,
} from '../services/reminderToolService.js';
import { orchestrateToolAction } from '../services/toolOrchestrator.js';
import { resolveTimeZone } from '../services/timeService.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();
router.use(requireAuth);

const CHAT_HISTORY_TURN_LIMIT = 20;
const CHAT_HISTORY_MESSAGE_LIMIT = CHAT_HISTORY_TURN_LIMIT * 2;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function profileSummarySignature(profile = {}) {
  return stableJson({
    age: profile.age ?? null,
    sex: profile.sex ?? null,
    height: profile.height ?? null,
    weight: profile.weight ?? null,
    category: profile.category ?? null,
    severity: profile.severity ?? null,
    red_flags: profile.red_flags || profile.redFlagsPresent || [],
    conditions: profile.conditions || [],
    allergies: profile.allergies || [],
    medications: profile.medications || [],
    goals: profile.goals || [],
    goals_confirmed: Boolean(profile.goals_confirmed),
    program_duration_days: profile.program_duration_days ?? null,
  });
}

function shouldRefreshProfileSummary({
  previousProfile = {},
  updatedProfile = {},
  stateRow = {},
  safety = {},
  pendingFollowupOffer = null,
}) {
  if (!stateRow?.profile_summary_text) return true;
  if (profileSummarySignature(previousProfile) !== profileSummarySignature(updatedProfile)) return true;
  if ((stateRow?.last_safety_level || null) !== (safety?.level || null)) return true;
  if (safety?.domain && safety.domain !== 'general') return true;
  if (pendingFollowupOffer) return true;
  return false;
}

// Multer config for avatars
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), 'data', 'avatars');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images are allowed'));
  }
});

async function getOrCreateDefaultConversation(db, { userId, profileId }) {
  const existing = await db.get(`
    SELECT id FROM conversations
    WHERE user_id = ? AND profile_id = ? AND type = 'general'
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `, [userId, profileId]);

  if (existing) return existing.id;

  const conversationId = uuidv4();
  await db.run(`
    INSERT INTO conversations (id, user_id, profile_id, type, title)
    VALUES (?, ?, ?, 'general', 'General chat')
  `, [conversationId, userId, profileId]);

  return conversationId;
}

async function insertMessage(db, {
  conversationId,
  profileId,
  role,
  content,
  safetyLevel = null,
  safetyAction = null,
  safetyDomain = null,
}) {
  await db.run(`
    INSERT INTO messages (id, conversation_id, profile_id, role, content, safety_level, safety_action, safety_domain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [uuidv4(), conversationId, profileId, role, content, safetyLevel, safetyAction, safetyDomain]);
}

function confirmsReturnToNormal(message) {
  const text = String(message || '').toLowerCase();
  if (/\b(no|not|never|unsafe|not safe|not ok|not okay|do not|don't|cant|can't|cannot)\b/.test(text)) {
    return false;
  }
  return /\b(yes|yeah|yep|ok|okay|safe|ready|continue|go ahead|resume)\b/.test(text);
}

const BASIC_DETAILS_PATTERN = /\b(?:age|sex|gender|male|female|other|height|weight|cm|kg|kilogram|years?|yrs?)\b/i;
const CONCERN_SIGNAL_PATTERN = /\b(?:issue|problem|concern|goal|help|sleep|stress|anxiety|anxious|pain|fever|symptom|tired|exhausted|frustrated|sad|depressed|panic|overthink|headache|stomach|diarrhea|vomit|cough|cold|injury|bleed|chest|breath|nutrition|diet|meal|water|hydration|exercise|workout|steps|phone|screen|masturbation|addiction|habit|routine|medicine|medication|period|pregnan)\b/i;
const PLAN_CONSENT_PATTERN = /\b(?:plan|routine|goal|track|tracking|start|begin|try|comfort measures|sounds good|go ahead|do it|let'?s do|i'?ll try)\b/i;
const MEDICAL_ESCALATION_PATTERN = /\b(?:medicine|medication|dose|dosage|prescription|tablet|pill|doctor|physician|severe|persistent|worsening|worse|emergency|chest|breath|faint|fever|blood|pregnan|suicide|self-harm|self harm)\b/i;

function hasProfileValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function hasAnyBasicDetails(profile = {}) {
  return ['age', 'sex', 'height', 'weight'].some(key => hasProfileValue(profile[key]));
}

function gainedBasicDetails(previousProfile = {}, updatedProfile = {}) {
  return ['age', 'sex', 'height', 'weight'].some(key =>
    !hasProfileValue(previousProfile[key]) && hasProfileValue(updatedProfile[key])
  );
}

function hasProfileConcern(profile = {}) {
  const category = String(profile.category || '').trim().toLowerCase();
  return Boolean(
    (category && category !== 'general') ||
    hasProfileValue(profile.severity) ||
    hasProfileValue(profile.goals) ||
    hasProfileValue(profile.conditions) ||
    hasProfileValue(profile.medications)
  );
}

function isBasicDetailsOnlyDay0({ message, currentDay, previousProfile, updatedProfile }) {
  if (Number(currentDay || 0) !== 0) return false;
  if (!BASIC_DETAILS_PATTERN.test(message || '')) return false;
  if (CONCERN_SIGNAL_PATTERN.test(message || '')) return false;
  if (hasProfileConcern(previousProfile) || hasProfileConcern(updatedProfile)) return false;
  return gainedBasicDetails(previousProfile, updatedProfile) || hasAnyBasicDetails(updatedProfile);
}

function isSelfProfileRow(profile = {}) {
  const relation = String(profile.relation || profile.relationToUser || '').trim().toLowerCase();
  return relation === 'self' || relation === 'myself';
}

function buildBasicDetailsReply(profileRow = {}) {
  if (!isSelfProfileRow(profileRow) && profileRow.name) {
    return `Got it, thanks. I've saved ${profileRow.name}'s basic details.\n\nWhat's been going on for ${profileRow.name} lately? You can write it simply; we'll sort it together.`;
  }
  return `Got it, thanks for sharing that. I've saved your basic details.\n\nWhat's been on your mind lately${profileRow.name ? `, ${profileRow.name}` : ''}? You can say it messy; we'll sort it together.`;
}

function parseDbDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const raw = String(value);
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? raw
    : raw.replace(' ', 'T') + 'Z';
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function zonedDateEpoch(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day));
}

function computeDisplayDay(state = {}, structuredProfile = {}) {
  const currentDay = Number(state?.current_day || 0);
  const duration = Number(structuredProfile?.program_duration_days || 0);
  if (!duration && currentDay <= 0) return 0;

  const timeZone = resolveTimeZone(state?.timezone);
  const start = parseDbDate(state?.protocol_start_date) || parseDbDate(state?.created_at) || new Date();
  const startDay = zonedDateEpoch(start, timeZone);
  const today = zonedDateEpoch(new Date(), timeZone);
  const dateDay = Math.max(1, Math.floor((today - startDay) / 86_400_000) + 1);
  const raw = Math.max(currentDay || 1, dateDay);
  return duration ? Math.min(raw, duration) : raw;
}

function displayPhaseForDay(day) {
  if (day <= 0) return 'Intake';
  if (day <= 1) return 'Getting started';
  if (day <= 3) return 'Early awareness';
  if (day <= 7) return 'Building habits';
  return 'Staying consistent';
}

function hasPlanConsentSignal(message = '', profile = {}) {
  if (PLAN_CONSENT_PATTERN.test(message)) return true;
  if (hasProfileValue(profile.goals) && /\b(?:yes|yeah|yep|ok|okay|sure)\b/i.test(message)) return true;
  return false;
}

function shouldAllowProgramDurationPrompt({ message, currentDay, previousProfile, updatedProfile }) {
  if (Number(updatedProfile?.program_duration_days || 0) > 0) return true;
  if (isBasicDetailsOnlyDay0({ message, currentDay, previousProfile, updatedProfile })) return false;

  const concernKnown = hasProfileConcern(previousProfile) ||
    hasProfileConcern(updatedProfile) ||
    CONCERN_SIGNAL_PATTERN.test(message || '');

  return concernKnown && hasPlanConsentSignal(message, updatedProfile);
}

function shouldAllowMedicalDisclaimer({ message, safety }) {
  if (safety?.level && safety.level !== 'GREEN') return true;
  return MEDICAL_ESCALATION_PATTERN.test(message || '');
}

function buildInteractionFilterOptions({
  message,
  currentDay,
  previousProfile,
  updatedProfile,
  safety,
  followupOffer,
}) {
  return {
    followupOffer,
    allowMedicalDisclaimer: shouldAllowMedicalDisclaimer({ message, safety }),
    allowProgramDurationPrompt: shouldAllowProgramDurationPrompt({
      message,
      currentDay,
      previousProfile,
      updatedProfile,
    }),
    allowCheckinConsentPrompt: false,
    emojiMax: safety?.level && safety.level !== 'GREEN' ? 1 : 3,
    emptyFallback: 'Tell me a little more about what is happening, and we will take it one step at a time.',
  };
}

function getBaseScheduleOffer(pendingFollowupOffer = {}) {
  return pendingFollowupOffer.offer || pendingFollowupOffer;
}

function buildPendingScheduleCapture(baseOffer, parseResult = {}) {
  return {
    ...baseOffer,
    phase: 'timing_capture',
    suggestedItems: parseResult.status === 'suggested' ? parseResult.items : baseOffer.suggestedItems,
    lastClarification: parseResult.status === 'clarify' ? parseResult.reply : null,
  };
}

async function saveAssistantAndReturn(db, res, {
  conversationId,
  profileId,
  reply,
  safety,
  mode,
  extra = {},
}) {
  await insertMessage(db, {
    conversationId,
    profileId,
    role: 'assistant',
    content: reply,
    safetyLevel: safety.level,
    safetyAction: mode,
    safetyDomain: safety.domain,
  });

  return res.json({
    reply,
    assistantMessage: reply,
    mode,
    safety,
    ui: null,
    ...extra,
  });
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(item => String(item || '').trim())
    .filter(Boolean)
  )];
}

function goalKey(value) {
  return String(value || '').trim().toLowerCase();
}

function getRemovedGoals(previous = [], next = []) {
  const nextKeys = new Set(normalizeList(next).map(goalKey));
  return normalizeList(previous).filter(goal => !nextKeys.has(goalKey(goal)));
}

async function cleanupRemovedGoals(db, { userId, profileId, removedGoals, remainingGoals }) {
  if (!removedGoals.length) return;

  const activeStatuses = ['scheduled', 'due', 'sent', 'missed'];
  const removedKeys = removedGoals.map(goalKey);
  const placeholders = removedKeys.map(() => '?').join(',');

  const matchingGoalRows = placeholders
    ? await db.all(`
        SELECT id FROM goals
        WHERE user_id = ?
          AND profile_id = ?
          AND LOWER(title) IN (${placeholders})
      `, [userId, profileId, ...removedKeys])
    : [];
  const goalIds = matchingGoalRows.map(row => row.id);

  if (goalIds.length) {
    const idPlaceholders = goalIds.map(() => '?').join(',');
    await db.run(`
      UPDATE scheduled_checkins
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
        AND profile_id = ?
        AND goal_id IN (${idPlaceholders})
        AND status IN (${activeStatuses.map(() => '?').join(',')})
    `, [userId, profileId, ...goalIds, ...activeStatuses]);

    await db.run(`
      UPDATE goal_progress
      SET status = 'deleted', next_checkin_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
        AND profile_id = ?
        AND goal_id IN (${idPlaceholders})
    `, [userId, profileId, ...goalIds]);

    await db.run(`
      UPDATE goals
      SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
        AND profile_id = ?
        AND id IN (${idPlaceholders})
    `, [userId, profileId, ...goalIds]);
  }

  for (const removedGoal of removedGoals) {
    const pattern = `%${goalKey(removedGoal)}%`;
    await db.run(`
      UPDATE scheduled_checkins
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
        AND profile_id = ?
        AND status IN (${activeStatuses.map(() => '?').join(',')})
        AND (
          LOWER(title) LIKE ?
          OR LOWER(in_app_title) LIKE ?
          OR LOWER(metadata_json) LIKE ?
        )
    `, [userId, profileId, ...activeStatuses, pattern, pattern, pattern]);

    await db.run(`
      UPDATE reminders
      SET enabled = 0, updated_at = CURRENT_TIMESTAMP
      WHERE profile_id = ?
        AND enabled = 1
        AND LOWER(title) LIKE ?
    `, [profileId, pattern]);
  }

  if (!remainingGoals.length) {
    await db.run(`
      UPDATE scheduled_checkins
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
        AND profile_id = ?
        AND status IN (${activeStatuses.map(() => '?').join(',')})
    `, [userId, profileId, ...activeStatuses]);

    await db.run(`
      UPDATE reminders
      SET enabled = 0, updated_at = CURRENT_TIMESTAMP
      WHERE profile_id = ?
        AND enabled = 1
        AND COALESCE(source, '') != 'prescription'
    `, [profileId]);

    await db.run(`
      UPDATE goal_progress
      SET status = 'deleted', next_checkin_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
        AND profile_id = ?
    `, [userId, profileId]);
  }
}

// ── Profile CRUD ───────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const profiles = await db.all('SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json(profiles);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load profiles' });
  }
});

router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const { name, relation, relation_other } = req.body;
    if (!name || !relation) return res.status(400).json({ error: 'Name and relation are required' });

    const photoPath = req.file ? `/api/profiles/avatars/${req.file.filename}` : null;

    // Deterministic initials and colors
    const initials = name.substring(0, 2).toUpperCase();
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];
    const charCodeSum = name.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const color = colors[charCodeSum % colors.length];

    const db = await getDb();
    const profileId = uuidv4();

    await db.exec('BEGIN TRANSACTION');
    try {
      await db.run(`
        INSERT INTO profiles (id, user_id, name, relation, relation_other, photo_path, avatar_initials, avatar_color)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [profileId, req.user.id, name, relation, relation_other, photoPath, initials, color]);

      await db.run(`
        INSERT INTO patient_states (id, profile_id, current_day)
        VALUES (?, ?, ?)
      `, [uuidv4(), profileId, 0]);

      // Set as active
      await db.run(`
        INSERT INTO active_profile_preferences (id, user_id, last_active_profile_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET last_active_profile_id = ?, updated_at = CURRENT_TIMESTAMP
      `, [uuidv4(), req.user.id, profileId, profileId]);

      await db.exec('COMMIT');
      res.json({ success: true, profileId });
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }
  } catch (error) {
    console.error('[Create Profile]', error);
    res.status(500).json({ error: 'Failed to create profile' });
  }
});

router.post('/:profileId/activate', requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const { profileId } = req.params;
    await db.run(`
      INSERT INTO active_profile_preferences (id, user_id, last_active_profile_id)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_active_profile_id = ?, updated_at = CURRENT_TIMESTAMP
    `, [uuidv4(), req.user.id, profileId, profileId]);
    res.json({ success: true });
  } catch (error) {
    console.error('[Activate Profile]', error);
    res.status(500).json({ error: 'Failed to activate profile' });
  }
});

router.put('/:profileId', requireProfileOwnership, async (req, res) => {
  try {
    const {
      name,
      relation,
      relation_other,
      age,
      sex,
      height,
      weight,
      category,
      severity,
      red_flags,
      conditions,
      allergies,
      medications,
      goals,
      program_duration_days,
      goals_confirmed,
    } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const { profileId } = req.params;

    // Deterministic initials and colors
    const initials = name.substring(0, 2).toUpperCase();
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];
    const charCodeSum = name.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const color = colors[charCodeSum % colors.length];

    const db = await getDb();
    await db.exec('BEGIN TRANSACTION');
    try {
      await db.run(`
        UPDATE profiles 
        SET name = ?,
            relation = COALESCE(?, relation),
            relation_other = ?,
            avatar_initials = ?,
            avatar_color = ?,
            updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `, [name, relation || null, relation === 'Other' ? relation_other : null, initials, color, profileId]);

      const stateRow = await db.get('SELECT structured_profile_json FROM patient_states WHERE profile_id = ?', [profileId]);
      const currentStructured = stateRow && stateRow.structured_profile_json
        ? JSON.parse(stateRow.structured_profile_json)
        : {};
      const nextGoals = normalizeList(goals);
      const removedGoals = getRemovedGoals(currentStructured.goals, nextGoals);

      const updatedStructured = {
        ...currentStructured,
        age: age ? parseInt(age) : null,
        sex: sex || null,
        height: height || null,
        weight: weight || null,
        category: category || null,
        severity: severity || null,
        red_flags: normalizeList(red_flags),
        conditions: normalizeList(conditions),
        allergies: normalizeList(allergies),
        medications: normalizeList(medications),
        goals: nextGoals,
        program_duration_days: program_duration_days ? parseInt(program_duration_days, 10) : null,
        goals_confirmed: Boolean(goals_confirmed && nextGoals.length)
      };

      await cleanupRemovedGoals(db, {
        userId: req.user.id,
        profileId,
        removedGoals,
        remainingGoals: nextGoals,
      });

      await db.run(`
        UPDATE patient_states 
        SET structured_profile_json = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE profile_id = ?
      `, [JSON.stringify(updatedStructured), profileId]);

      await db.exec('COMMIT');
      res.json({ success: true });
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }
  } catch (error) {
    console.error('[Update Profile]', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

router.delete('/:profileId', requireProfileOwnership, async (req, res) => {
  try {
    const { profileId } = req.params;
    const db = await getDb();

    await db.exec('BEGIN TRANSACTION');
    try {
      await db.run('DELETE FROM active_profile_preferences WHERE last_active_profile_id = ?', [profileId]);
      await db.run('DELETE FROM profiles WHERE id = ?', [profileId]);

      const nextProfile = await db.get('SELECT id FROM profiles WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [req.user.id]);
      if (nextProfile) {
        await db.run(`
          INSERT INTO active_profile_preferences (id, user_id, last_active_profile_id)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET last_active_profile_id = ?, updated_at = CURRENT_TIMESTAMP
        `, [uuidv4(), req.user.id, nextProfile.id, nextProfile.id]);
      }

      await db.exec('COMMIT');
      res.json({ success: true, nextProfileId: nextProfile ? nextProfile.id : null });
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }
  } catch (error) {
    console.error('[Delete Profile]', error);
    res.status(500).json({ error: 'Failed to delete profile' });
  }
});


// Securely serve avatars
router.get('/avatars/:filename', (req, res) => {
  const filePath = path.join(process.cwd(), 'data', 'avatars', req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Avatar not found' });
  }
});

// ── State & Onboarding ─────────────────────────────────────────

router.get('/:profileId/state', requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const state = await db.get('SELECT * FROM patient_states WHERE profile_id = ?', [req.params.profileId]);
    let structuredProfile = {};
    if (state && state.structured_profile_json) {
      structuredProfile = JSON.parse(state.structured_profile_json);
      state.structured_profile = structuredProfile;
    }
    if (state) {
      const displayDay = computeDisplayDay(state, structuredProfile);
      state.display_day = displayDay;
      state.displayDay = displayDay;
      state.display_phase = displayPhaseForDay(displayDay);
      state.displayPhase = state.display_phase;
      state.programDurationDays = Number(structuredProfile?.program_duration_days || 0) || null;
    }
    res.json(state || {});
  } catch (error) {
    res.status(500).json({ error: 'Failed to load patient state' });
  }
});

// Removed manual onboarding parse route; extraction is now implicit during chat.

// ── Check-ins ──────────────────────────────────────────────────

router.get('/:profileId/checkins', requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const checkins = await db.all('SELECT * FROM checkins WHERE profile_id = ? ORDER BY created_at ASC', [req.params.profileId]);
    
    res.json(checkins.map(c => ({
      ...c,
      questions: JSON.parse(c.questions_json),
      answers: c.answers_json ? JSON.parse(c.answers_json) : null
    })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to load checkins' });
  }
});

router.post('/:profileId/checkin', requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const { profileId } = req.params;
    
    const state = await db.get('SELECT * FROM patient_states WHERE profile_id = ?', [profileId]);
    const profile = state && state.structured_profile_json ? JSON.parse(state.structured_profile_json) : {};
    const day = state ? state.current_day : 1;

    // Get previous check-ins for context
    const checkinsRaw = await db.all('SELECT * FROM checkins WHERE profile_id = ? ORDER BY created_at ASC', [profileId]);
    const checkInHistory = checkinsRaw.map(c => ({
      day: c.day,
      phaseName: c.phase,
      questions: JSON.parse(c.questions_json)
    }));

    // Check if check-in for current day already exists to prevent duplicates
    if (checkInHistory.some(c => c.day === day)) {
       return res.json({ success: true, message: 'Check-in already generated for today' });
    }

    const checkIn = await generateCheckIn(profile, day, checkInHistory);
    const conversationId = await getOrCreateDefaultConversation(db, {
      userId: req.user.id,
      profileId,
    });
    
    await db.exec('BEGIN TRANSACTION');
    try {
      await db.run(`
        INSERT INTO checkins (id, profile_id, day, phase, questions_json)
        VALUES (?, ?, ?, ?, ?)
      `, [uuidv4(), profileId, day, checkIn.phaseName, JSON.stringify(checkIn.questions)]);

      // Also add check-in to message history for context
      await insertMessage(db, {
        conversationId,
        profileId,
        role: 'assistant',
        content: `Daily Check-in (Day ${day}):\n\n${checkIn.questions}`,
      });

      // Advance day
      await db.run('UPDATE patient_states SET current_day = current_day + 1 WHERE profile_id = ?', [profileId]);

      await db.exec('COMMIT');
      res.json(checkIn);
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }
  } catch (error) {
    console.error('[Check-in]', error);
    res.status(500).json({ error: 'Failed to generate check-in' });
  }
});

// ── Chat ───────────────────────────────────────────────────────

router.get('/:profileId/messages', requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    // Return last 50 messages
    const messages = await db.all(
      'SELECT role, content, created_at FROM messages WHERE profile_id = ? ORDER BY created_at ASC LIMIT 50', 
      [req.params.profileId]
    );
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

router.post('/:profileId/chat', requireProfileOwnership, async (req, res) => {
  try {
    // 1. Validate message.
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const db = await getDb();
    const { profileId } = req.params;
    const userId = req.user.id;
    const conversationId = await getOrCreateDefaultConversation(db, { userId, profileId });

    // 2. Load profile row from `profiles`.
    const profileRow = await db.get('SELECT * FROM profiles WHERE id = ?', [profileId]);

    // 3. Load full patient state row.
    let stateRow = await db.get('SELECT * FROM patient_states WHERE profile_id = ?', [profileId]);
    let currentMode = (stateRow && stateRow.safety_mode) || 'normal';

    // 4. Merge structured profile JSON with identity profile fields.
    const structuredProfile = (stateRow && stateRow.structured_profile_json)
      ? JSON.parse(stateRow.structured_profile_json)
      : {};
    const profile = { ...profileRow, ...structuredProfile };

    // 5. Load previous message history.
    const recentMessages = await db.all(`
      SELECT role, content FROM messages 
      WHERE profile_id = ? 
      ORDER BY created_at DESC LIMIT ?
    `, [profileId, CHAT_HISTORY_MESSAGE_LIMIT]);
    const history = recentMessages.reverse().map(m => ({
      role: m.role === 'model' ? 'assistant' : m.role,
      content: m.content,
    }));

    // 6. Save current user message.
    await insertMessage(db, {
      conversationId,
      profileId,
      role: 'user',
      content: message,
    });

    // 7. Run routeSafety unconditionally (always, even in crisis mode).
    const safety = routeSafety({
      message,
      profile,
      config: {
        emergencyNumberLabel: '112 (National Emergency Number)',
        offerMapsForRed: true,
        offerMapsForOrange: true,
      },
    });

    // 8. Save safety audit event.
    const auditRecord = makeSafetyAuditRecord({ userId, profileId, message, route: safety });
    await db.run(`
      INSERT INTO safety_events (id, user_id, profile_id, message_preview, level, action, domain, reasons_json, matched_rules_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [auditRecord.id, auditRecord.userId, auditRecord.profileId, auditRecord.messagePreview,
        auditRecord.level, auditRecord.action, auditRecord.domain,
        auditRecord.reasonsJson, auditRecord.matchedRulesJson, auditRecord.createdAt]);

    const pendingFollowupOffer = stateRow?.pending_followup_offer_json
      ? JSON.parse(stateRow.pending_followup_offer_json)
      : null;

    // ── Intent Classifier ────────────────────────────────────────────
    const intentResult = classifyIntent({
      message,
      hasPendingOffer: Boolean(pendingFollowupOffer),
      pendingOffer: pendingFollowupOffer,
      patientState: stateRow,
    });
    
    // Safety check - do not bypass crisis modes
    const isCrisisMode = safety.level === 'RED' || safety.level === 'ORANGE';
    const keepPendingOffer = pendingFollowupOffer && intentResult.intent === INTENTS.CLARIFICATION;

    if (!isCrisisMode) {
      let toolTurn = null;
      try {
        toolTurn = await orchestrateToolAction({
          db,
          userId,
          profileId,
          profile: profileRow,
          patientState: stateRow,
          history,
          message,
          conversationId,
          pendingFollowupOffer,
        });
      } catch (toolError) {
        console.error('[ToolOrchestrator] Non-fatal chat preflight failed:', {
          message: toolError?.message,
          stack: toolError?.stack,
          profileId,
          intent: intentResult?.intent,
        });

        const schedulerIntents = new Set([
          INTENTS.DIRECT_REMINDER,
          INTENTS.REMINDER_UPDATE,
          INTENTS.REMINDER_STATUS,
          INTENTS.REMINDER_FAILURE,
          INTENTS.TIMING_RESPONSE,
          INTENTS.SCHEDULE_ACCEPTANCE,
          INTENTS.DELEGATE_CHOICE,
        ]);

        if (schedulerIntents.has(intentResult.intent)) {
          return saveAssistantAndReturn(db, res, {
            conversationId,
            profileId,
            reply: "I understood that, but I couldn't save or check the schedule just now. Please try once more in a moment.",
            safety,
            mode: 'tool_preflight_failed',
          });
        }
      }

      if (toolTurn?.handled) {
        if (toolTurn.extra?.pendingToolAction) {
          await db.run(
            'UPDATE patient_states SET pending_followup_offer_json = ?, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ?',
            [JSON.stringify({
              type: 'tool_action',
              phase: 'clarification',
              toolAction: toolTurn.extra.pendingToolAction,
              createdAt: new Date().toISOString(),
            }), profileId]
          );
        } else if (pendingFollowupOffer) {
          await db.run('UPDATE patient_states SET pending_followup_offer_json = NULL WHERE profile_id = ?', [profileId]);
        }

        return saveAssistantAndReturn(db, res, {
          conversationId,
          profileId,
          reply: toolTurn.reply,
          safety,
          mode: toolTurn.mode,
          extra: toolTurn.extra || {},
        });
      }
    }

    if (!isCrisisMode && false) {
      // 1. Direct Reminder Fast Path
      if (intentResult.intent === INTENTS.DIRECT_REMINDER) {
        const directResult = await handleDirectReminder({
          db,
          userId,
          profile: profileRow,
          reminderMeta: intentResult.metadata,
          originalMessage: message,
          conversationId,
        });

        if (pendingFollowupOffer) {
          await db.run('UPDATE patient_states SET pending_followup_offer_json = NULL WHERE profile_id = ?', [profileId]);
        }

        return saveAssistantAndReturn(db, res, {
          conversationId,
          profileId,
          reply: directResult.confirmationMessage,
          safety,
          mode: directResult.success ? 'direct_reminder_scheduled' : 'direct_reminder_failed',
          extra: directResult.success ? { scheduledCheckins: [directResult.record], dueAt: directResult.dueAt } : {},
        });
      }

      // 2. Correct latest active reminder text from saved DB records
      if (intentResult.intent === INTENTS.REMINDER_UPDATE) {
        const updateResult = await updateLatestReminderText(db, {
          userId,
          profileId,
          correction: intentResult.metadata,
          originalMessage: message,
        });

        return saveAssistantAndReturn(db, res, {
          conversationId,
          profileId,
          reply: updateResult.assistantMessage,
          safety,
          mode: updateResult.success ? 'reminder_updated' : 'reminder_update_failed',
          extra: updateResult.success ? { reminder: updateResult.item } : {},
        });
      }

      // 3. Reminder/check-in status from saved DB records
      if (intentResult.intent === INTENTS.REMINDER_STATUS) {
        const reply = await buildReminderStatusMessage(db, {
          userId,
          profileId,
          profile: profileRow,
          query: message,
        });

        return saveAssistantAndReturn(db, res, {
          conversationId,
          profileId,
          reply,
          safety,
          mode: 'reminder_status_answered',
        });
      }

      // 4. Reminder Failure
      if (intentResult.intent === INTENTS.REMINDER_FAILURE) {
        const recentReminders = await getRecentReminders(db, { profileId, limit: 3 });
        const reply = buildReminderFailureResponse(recentReminders);
        
        return saveAssistantAndReturn(db, res, {
          conversationId,
          profileId,
          reply,
          safety,
          mode: 'reminder_failure_handled',
        });
      }

      // 5. Clarification or Confusion (during scheduling)
      if (pendingFollowupOffer && (intentResult.intent === INTENTS.CLARIFICATION || intentResult.intent === INTENTS.CONFUSION)) {
        if (intentResult.intent === INTENTS.CONFUSION) {
           const reply = buildConfusionResponse(pendingFollowupOffer);
           return saveAssistantAndReturn(db, res, {
             conversationId, profileId, reply, safety, mode: 'scheduling_confusion_handled',
           });
        }
        // For clarification, let it fall through to LLM, keepPendingOffer is set to true
      }

      // 6. Cancel Flow
      if (pendingFollowupOffer && intentResult.intent === INTENTS.CANCEL_FLOW) {
        await db.run('UPDATE patient_states SET pending_followup_offer_json = NULL WHERE profile_id = ?', [profileId]);
        const reply = buildCancelResponse();
        return saveAssistantAndReturn(db, res, {
          conversationId, profileId, reply, safety, mode: 'scheduling_cancelled',
        });
      }

      // 7. Plan Change
      if (pendingFollowupOffer && intentResult.intent === INTENTS.PLAN_CHANGE) {
        await db.run('UPDATE patient_states SET pending_followup_offer_json = NULL WHERE profile_id = ?', [profileId]);
        // Fall through to LLM to handle new plan
      }

      // 8. Timing Response or Schedule Acceptance
      if (pendingFollowupOffer && (intentResult.intent === INTENTS.TIMING_RESPONSE || intentResult.intent === INTENTS.SCHEDULE_ACCEPTANCE || intentResult.intent === INTENTS.DELEGATE_CHOICE)) {
        
        if (intentResult.intent === INTENTS.SCHEDULE_ACCEPTANCE && !intentResult.metadata.hasTiming && !pendingFollowupOffer.timingProvided) {
          const reply = isSelfProfileRow(profileRow) && profileRow.name
            ? `${profileRow.name.split(/\s+/)[0]}, what time would fit your day best for this? You can say it casually, like "8 PM" or "after dinner."`
            : `What time would fit ${profileRow.name ? `${profileRow.name}'s day` : 'the day'} best for this? You can say it casually, like "8 PM" or "after dinner."`;
          return saveAssistantAndReturn(db, res, {
            conversationId, profileId, reply, safety, mode: 'schedule_timing_needed',
            extra: { pendingSchedule: true },
          });
        }

        const baseOffer = getBaseScheduleOffer(pendingFollowupOffer);
        const parseResult = parseScheduleTimingInput({
          message,
          offer: baseOffer,
          profile: profileRow,
          patientState: stateRow,
          previousCapture: pendingFollowupOffer,
        });

        if (parseResult.status === 'ready') {
          const scheduledRecords = await createScheduledItemsFromOffers(db, {
            userId,
            profile: profileRow,
            offers: parseResult.items,
          });

          await db.run('UPDATE patient_states SET pending_followup_offer_json = NULL WHERE profile_id = ?', [profileId]);

          const reply = buildScheduleConfirmation({ records: scheduledRecords, profile: profileRow });
          return saveAssistantAndReturn(db, res, {
            conversationId,
            profileId,
            reply,
            safety,
            mode: 'schedule_confirmed',
            extra: { scheduledCheckins: scheduledRecords },
          });
        }

        const pendingCapture = buildPendingScheduleCapture(baseOffer, parseResult);
        await db.run(
          'UPDATE patient_states SET pending_followup_offer_json = ?, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ?',
          [JSON.stringify(pendingCapture), profileId]
        );

        return saveAssistantAndReturn(db, res, {
          conversationId,
          profileId,
          reply: parseResult.reply,
          safety,
          mode: parseResult.status === 'suggested' ? 'schedule_suggested' : 'schedule_timing_needed',
          extra: { pendingSchedule: true },
        });
      }
    }

    // If support mode asked for one final confirmation, let a safe affirmative return to normal chat.
    if (
      currentMode === 'post_crisis_support' &&
      stateRow?.pending_safety_action === 'return_to_normal' &&
      (safety.level === 'GREEN' || safety.level === 'YELLOW') &&
      confirmsReturnToNormal(message)
    ) {
      const reply = 'Okay. We can return to your wellness setup now. I’ll keep things gentle and practical.';

      await db.run(`
        UPDATE patient_states
        SET safety_mode = 'normal',
            pending_safety_action = NULL,
            safety_mode_started_at = NULL,
            last_safety_level = ?
        WHERE profile_id = ?
      `, [safety.level, profileId]);

      await db.run(`
        INSERT INTO safety_mode_transitions (id, profile_id, from_mode, to_mode, reason)
        VALUES (?, ?, ?, ?, ?)
      `, [uuidv4(), profileId, currentMode, 'normal', 'User confirmed they feel safe enough to continue']);

      await insertMessage(db, {
        conversationId,
        profileId,
        role: 'assistant',
        content: reply,
        safetyLevel: safety.level,
        safetyAction: 'RETURN_TO_NORMAL',
        safetyDomain: safety.domain,
      });

      stateRow = {
        ...stateRow,
        safety_mode: 'normal',
        pending_safety_action: null,
        safety_mode_started_at: null,
        last_safety_level: safety.level,
      };
      currentMode = 'normal';

      return res.json({
        reply,
        assistantMessage: reply,
        mode: 'normal_resumed',
        safety,
        ui: null,
      });
    }

    // ── CRISIS MODE ROUTING ──────────────────────────────────────────────────────

    // 9a. If already in crisis mode OR new RED mental_health_crisis → use crisisModeHandler
    const isExistingCrisis = currentMode === 'crisis_active' || currentMode === 'post_crisis_support';
    const isNewRedCrisis = safety.level === 'RED' && safety.domain === 'mental_health_crisis' && currentMode === 'normal';

    if (isExistingCrisis || isNewRedCrisis) {
      // For new crises, first set state to crisis_active so handler gets right mode
      const effectiveStateRow = isNewRedCrisis
        ? { ...stateRow, safety_mode: 'crisis_active' }
        : stateRow;

      const crisisResult = handleCrisisMessage({
        message,
        stateRow: effectiveStateRow,
        safety,
        profile,
      });

      const { nextMode, pendingTransition, reply, templateId, detectedIntent, updatedTemplateHistory, ui } = crisisResult;

      // Debug log
      console.log('[CHAT SAFETY FLOW]', {
        profileId,
        safetyModeBefore: currentMode,
        safetyLevel: safety.level,
        safetyDomain: safety.domain,
        detectedIntent,
        selectedTemplateId: templateId,
        selectedHandler: 'crisisModeHandler',
        nextSafetyMode: nextMode,
        pendingTransition: pendingTransition || null,
        llmCalled: false,
      });

      // Persist template history
      await db.run(
        'UPDATE patient_states SET crisis_template_history_json = ? WHERE profile_id = ?',
        [JSON.stringify(updatedTemplateHistory), profileId]
      );

      // Handle state transitions
      const modeChanged = nextMode !== currentMode || isNewRedCrisis;
      if (modeChanged) {
        const fromMode = isNewRedCrisis ? 'normal' : currentMode;
        await db.run(`
          UPDATE patient_states 
          SET safety_mode = ?, last_safety_level = 'RED', safety_mode_started_at = CURRENT_TIMESTAMP
          WHERE profile_id = ?
        `, [nextMode, profileId]);

        await db.run(`
          INSERT INTO safety_mode_transitions (id, profile_id, from_mode, to_mode, reason)
          VALUES (?, ?, ?, ?, ?)
        `, [uuidv4(), profileId, fromMode, nextMode,
            isNewRedCrisis ? 'Triggered RED mental_health_crisis' : `Intent: ${detectedIntent}`]);
      }

      // If pending transition to normal, update pending_safety_action
      if (pendingTransition === 'normal') {
        await db.run(
          "UPDATE patient_states SET pending_safety_action = 'return_to_normal' WHERE profile_id = ?",
          [profileId]
        );
      }

      // Save assistant message
      await insertMessage(db, {
        conversationId,
        profileId,
        role: 'assistant',
        content: reply,
        safetyLevel: 'RED',
        safetyAction: 'CRISIS_MODE',
        safetyDomain: 'mental_health_crisis',
      });

      return res.json({
        reply,
        assistantMessage: reply,
        mode: 'safety_bypass',
        safety: { ...safety, level: 'RED', domain: 'mental_health_crisis' },
        ui: ui || null,
      });
    }

    // ── NON-CRISIS SAFETY BYPASS (ORANGE or non-mental-health RED) ───────────────

    // 9b. Other safety bypasses
    if (shouldBypassLLM(safety)) {
      console.log('[CHAT SAFETY FLOW]', {
        profileId,
        safetyModeBefore: currentMode,
        safetyLevel: safety.level,
        safetyDomain: safety.domain,
        selectedHandler: 'safetyBypass',
        llmCalled: false,
      });

      await insertMessage(db, {
        conversationId,
        profileId,
        role: 'assistant',
        content: safety.userMessage,
        safetyLevel: safety.level,
        safetyAction: safety.action,
        safetyDomain: safety.domain,
      });

      return res.json({
        reply: safety.userMessage,
        assistantMessage: safety.userMessage,
        mode: 'safety_bypass',
        safety,
        ui: safety.ui || null,
      });
    }

    // ── LLM PATH (GREEN / YELLOW) ─────────────────────────────────────────────
    const historyForExtraction = [...history, { role: 'user', content: message }];
    
    // We defer `extractProfileFromChat` and `updateProfileContextSummary` to the background.
    // For this turn, we just use the previous structuredProfile for the prompt.
    const stateForLLM = {
      ...stateRow,
      structured_profile_json: JSON.stringify(structuredProfile),
      current_day: stateRow?.current_day || 0,
      profile_summary_text: stateRow?.profile_summary_text || '',
    };

    console.log('[CHAT SAFETY FLOW]', {
      profileId,
      safetyModeBefore: currentMode,
      safetyLevel: safety.level,
      selectedHandler: 'llm_stream',
    });

    // Send SSE Headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let fullReply = '';
    let followupOffer = null;

    try {
      // 1. Get the stream
      const { stream, slotName } = await answerFromProtocolStream({
        question: message,
        profile: profileRow,
        history,
        patientState: stateForLLM,
        safety,
      });

      // 2. We can concurrently compute the check-in offer using the old profile
      const offerPromise = buildCheckinOffer({
        message,
        profile: profileRow,
        patientState: stateForLLM,
        updatedProfile: structuredProfile, // Use existing profile for offer
        rawReply: '', // Won't be available
        safety,
      }).catch(err => {
        console.error('[CheckinOffer] Failed:', err);
        return null;
      });

      // 3. Pump the stream
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || '';
        if (text) {
          fullReply += text;
          res.write(`event: token\ndata: ${JSON.stringify({ delta: text })}\n\n`);
        }
      }

      followupOffer = await offerPromise;

      // 4. Send Metadata and end stream
      const uiActions = followupOffer ? [{ type: 'show_checkin_offer', offer: followupOffer }] : [];
      res.write(`event: metadata\ndata: ${JSON.stringify({ uiActions, mode: 'llm_answer', safety, slotName })}\n\n`);
      res.write(`event: done\ndata: {}\n\n`);
      res.end();

    } catch (streamErr) {
      console.error('[Chat] Stream error:', streamErr);
      res.write(`event: error\ndata: ${JSON.stringify({ message: "Response interrupted. Please tap retry." })}\n\n`);
      res.end();
      return; // Do not save partial corrupted message
    }

    // ── Background & Persistence Phase ─────────────────────────
    await insertMessage(db, {
      conversationId,
      profileId,
      role: 'assistant',
      content: fullReply,
      safetyLevel: safety.level,
      safetyAction: safety.action,
      safetyDomain: safety.domain,
    });

    const offerToSave = followupOffer || (keepPendingOffer ? pendingFollowupOffer : null);
    if (offerToSave) {
      await db.run(
        `UPDATE patient_states SET pending_followup_offer_json = ? WHERE profile_id = ?`,
        [JSON.stringify(offerToSave), profileId]
      );
    }

    // Enqueue the heavy extraction/summarization job
    let newDay = stateRow?.current_day || 0;
    if (newDay === 0 && structuredProfile.program_duration_days) newDay = 1;

    await enqueueJob('update_profile_summary', {
      profileId,
      conversationId,
      historyForExtraction,
      oldStructuredProfile: structuredProfile,
      newDay,
    });

  } catch (error) {
    console.error('[Chat]', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

export default router;
