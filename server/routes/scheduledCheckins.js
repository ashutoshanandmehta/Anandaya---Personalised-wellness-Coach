import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireProfileOwnership } from '../middleware/profileOwnershipMiddleware.js';
import {
  buildCheckinResponseMessage,
  buildScheduledCheckin,
  getProgressDelta,
} from '../services/checkinPolicy.js';
import {
  addHoursUtc,
  formatInTimeZone,
  getZonedHour,
  nextLocalTimeUtc,
  resolveTimeZone,
} from '../services/timeService.js';
import { buildScheduleConfirmation } from '../services/scheduleIntentParser.js';
import {
  acknowledgeReminderItem,
  buildReminderStatusMessage,
  createScheduledItem,
  dismissReminderItem,
  getRecentReminderRows,
  listReminderItems,
  markDueScheduledItems,
  openScheduledItem,
  safeJson as safeReminderJson,
  serializeReminderItem,
} from '../services/reminderToolService.js';

const router = Router();

// Tiny in-process memo so /reminders and /checkins/notifications polling stops
// hammering SQLite. Per-user (and per-profile) key with a short TTL.
const REMINDER_LIST_TTL_MS = 8_000;
const reminderListCache = new Map();

function getCachedReminderList(cacheKey) {
  const hit = reminderListCache.get(cacheKey);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    reminderListCache.delete(cacheKey);
    return null;
  }
  return hit.value;
}

function setCachedReminderList(cacheKey, value) {
  reminderListCache.set(cacheKey, { value, expiresAt: Date.now() + REMINDER_LIST_TTL_MS });
  if (reminderListCache.size > 5000) {
    // Bound memory growth on a long-lived server.
    const oldest = reminderListCache.keys().next().value;
    if (oldest) reminderListCache.delete(oldest);
  }
}

export function invalidateReminderListCache({ userId, profileId } = {}) {
  if (!userId) {
    reminderListCache.clear();
    return;
  }
  for (const key of reminderListCache.keys()) {
    if (key.startsWith(`${userId}|`) && (!profileId || key.includes(`|${profileId}|`))) {
      reminderListCache.delete(key);
    }
  }
}

const RESPONSE_LABELS = {
  yes: 'Yes',
  no: 'No',
  partially: 'Partially',
  faced_issue: 'Faced an issue',
  better: 'Better',
  same: 'Same',
  worse: 'Worse',
  improving: 'Improving',
  done: 'Done',
  skipped: 'Skipped',
  not_sure: 'Not sure',
};

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

async function insertConversationMessage(db, { userId, profileId, role, content, safetyAction = 'SCHEDULED_CHECKIN' }) {
  const conversationId = await getOrCreateDefaultConversation(db, { userId, profileId });
  await db.run(`
    INSERT INTO messages (id, conversation_id, profile_id, role, content, safety_level, safety_action, safety_domain)
    VALUES (?, ?, ?, ?, ?, 'GREEN', ?, 'WELLNESS')
  `, [uuidv4(), conversationId, profileId, role, content, safetyAction]);
}

function serialize(row) {
  if (!row) return null;
  const metadata = safeJson(row.metadata_json, {});
  const kind = metadata.kind || 'checkin';
  const display = buildNotificationDisplay(row, metadata);
  return {
    id: row.id,
    userId: row.user_id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    goalId: row.goal_id,
    relation: row.relation,
    type: row.type,
    status: row.status,
    scheduledFor: row.scheduled_for,
    deliveredAt: row.delivered_at,
    completedAt: row.completed_at,
    title: row.title,
    pushTitle: row.push_title,
    pushBody: row.push_body,
    inAppTitle: row.in_app_title,
    inAppBody: row.in_app_body,
    kind,
    displayState: display.state,
    canOpen: display.canOpen,
    displayTitle: display.title,
    displayBody: display.body,
    displayMeta: display.meta,
    scheduledTitle: buildScheduledTitle(row, metadata),
    dueTitle: buildDueTitle(row, metadata),
    formattedDueText: formatDueText(row.scheduled_for, metadata.timezone),
    detailedChatMessage: row.detailed_chat_message,
    responseOptions: safeJson(row.response_options_json, []),
    metadata,
    response: row.response,
    issueType: row.issue_type,
    issueNote: row.issue_note,
  };
}

function buildNotificationDisplay(row, metadata = {}) {
  const kind = metadata.kind || 'checkin';

  if (row.status === 'completed') {
    return {
      state: 'completed',
      canOpen: false,
      title: 'Logged 🌿',
      body: 'Updated today.',
      meta: row.completed_at ? `Updated ${formatTime(row.completed_at, metadata.timezone)}` : 'Completed',
    };
  }

  if (row.status === 'missed') {
    return {
      state: 'missed',
      canOpen: false,
      title: 'Missed',
      body: 'This one was not logged.',
      meta: 'Missed',
    };
  }

  if (row.status === 'due' || row.status === 'sent') {
    return {
      state: 'ready',
      canOpen: true,
      title: row.push_title || row.in_app_title || buildDueTitle(row, metadata),
      body: row.push_body || row.in_app_body || (kind === 'reminder' ? 'Tap to view this gentle reminder.' : buildCheckinDueBody(row, metadata)),
      meta: 'Ready',
    };
  }

  return {
    state: 'scheduled',
    canOpen: false,
    title: buildScheduledTitle(row, metadata),
    body: formatDueText(row.scheduled_for, metadata.timezone),
    meta: 'Scheduled',
  };
}

function buildScheduledTitle(row, metadata = {}) {
  const title = row.title || 'Check-in';
  return `${title} scheduled ${titleEmoji(title, metadata)}`;
}

function buildDueTitle(row, metadata = {}) {
  const kind = metadata.kind || 'checkin';
  const profileName = row.profile_name || 'this profile';
  const isSelf = row.relation === 'self';
  const title = row.title || (kind === 'reminder' ? 'Reminder' : 'Check-in');

  if (kind === 'reminder') {
    return isSelf ? `Time for your ${title.toLowerCase()} ${titleEmoji(title, metadata)}` : `Time for ${profileName}'s ${title.toLowerCase()} ${titleEmoji(title, metadata)}`;
  }

  return fallbackCheckinDueTitle({ isSelf, profileName, metadata });
}

function buildCheckinDueBody(row, metadata = {}) {
  const taxonomy = String(metadata.taxonomy || row.category || row.type || '').toLowerCase();
  if (/sleep|wind/.test(taxonomy)) return 'Tap in when you are ready to rate last night.';
  if (/medicine|medication|pill|dose/.test(taxonomy)) return 'Tap to log whether the prescribed reminder happened.';
  if (/water|hydrat/.test(taxonomy)) return 'Tap for a tiny sip report.';
  if (/meal|food|nutrition|cook/.test(taxonomy)) return 'Tap for a quick real-life meal check.';
  if (/recover|symptom|pain|stomach|health/.test(taxonomy)) return 'Tap for a tiny health update.';
  if (/habit|stress|movement/.test(taxonomy)) return 'Tap for a no-judgment progress check.';
  return 'Tap to share a quick update.';
}

function fallbackCheckinDueTitle({ isSelf, profileName, metadata = {} }) {
  const taxonomy = String(metadata.taxonomy || metadata.goalType || metadata.reminderType || '').toLowerCase();
  if (/sleep|wind/.test(taxonomy)) return isSelf ? 'Morning sleep detective moment 🌙' : `Sleep detective moment for ${profileName} 🌙`;
  if (/medicine|medication|pill|dose/.test(taxonomy)) return isSelf ? 'Quick medicine follow-up 💊' : `Medicine follow-up for ${profileName} 💊`;
  if (/water|hydrat/.test(taxonomy)) return isSelf ? 'Sip check, no pressure 💧' : `Sip check for ${profileName} 💧`;
  if (/meal|food|nutrition|cook/.test(taxonomy)) return isSelf ? 'Meal check, real life edition 🍽️' : `Meal check for ${profileName} 🍽️`;
  if (/recover|symptom|pain|stomach|health/.test(taxonomy)) return isSelf ? 'Tiny health check 🙂' : `Tiny health check for ${profileName} 🙂`;
  if (/habit|stress|movement/.test(taxonomy)) return isSelf ? 'Reality check, kindly 😄' : `Reality check for ${profileName} 😄`;
  return isSelf ? 'Tiny progress ping ✨' : `Tiny progress ping for ${profileName} ✨`;
}

function titleEmoji(title = '', metadata = {}) {
  const text = `${title} ${metadata.reminderType || ''}`.toLowerCase();
  if (/sleep|wind/.test(text)) return '🌙';
  if (/water|hydration/.test(text)) return '🌊';
  if (/walk|movement|exercise/.test(text)) return '🚶';
  if (/habit/.test(text)) return '🌱';
  return '🌿';
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

async function markDueCheckins(db, userId) {
  await db.run(`
    UPDATE scheduled_checkins
    SET status = 'due', updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
      AND status = 'scheduled'
      AND datetime(scheduled_for) <= datetime('now')
  `, [userId]);
}

function formatTime(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  return date.toLocaleTimeString('en-IN', {
    timeZone: resolveTimeZone(timeZone),
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDueText(value, timeZone) {
  const zone = resolveTimeZone(timeZone);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Scheduled';

  const now = new Date();
  const dateKey = date.toLocaleDateString('en-CA', { timeZone: zone });
  const todayKey = now.toLocaleDateString('en-CA', { timeZone: zone });
  const tomorrowKey = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: zone });
  const time = date.toLocaleTimeString('en-IN', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
  });

  if (dateKey === todayKey) return `Due today at ${time}`;
  if (dateKey === tomorrowKey) return `Due tomorrow at ${time}`;
  return `Due ${date.toLocaleDateString('en-IN', {
    timeZone: zone,
    day: 'numeric',
    month: 'short',
  })} at ${time}`;
}

function nextMorningIso(timeZone, from = new Date()) {
  return nextLocalTimeUtc({ from, timeZone, hour: 9, minute: 0, forceTomorrow: true });
}

function nextHydrationWindowIso(timeZone, from = new Date()) {
  const nextIso = addHoursUtc(from, 2);
  const nextHour = getZonedHour(new Date(nextIso), timeZone);
  if (nextHour >= 21 || nextHour < 7) {
    return nextLocalTimeUtc({ from, timeZone, hour: 9, minute: 0 });
  }
  return nextIso;
}

async function getNextScheduledCheckin(db, row) {
  return db.get(`
    SELECT scheduled_for
    FROM scheduled_checkins
    WHERE user_id = ?
      AND profile_id = ?
      AND COALESCE(goal_id, '') = COALESCE(?, '')
      AND status IN ('scheduled', 'due', 'sent')
      AND id <> ?
      AND datetime(scheduled_for) >= datetime('now')
    ORDER BY datetime(scheduled_for) ASC
    LIMIT 1
  `, [row.user_id, row.profile_id, row.goal_id, row.id]);
}

function nextRecurringTime(row, metadata) {
  const cadence = metadata?.cadence;
  const timeZone = resolveTimeZone(metadata?.timezone);
  if (row.type === 'water_2_hourly' && cadence === 'every_2_hours') {
    return nextHydrationWindowIso(timeZone);
  }
  if (row.type === 'water_2_hourly' && cadence === 'daily') {
    return nextMorningIso(timeZone);
  }
  if (['daily', 'meal_based', 'after_next_workout_or_daily'].includes(cadence)) {
    return nextMorningIso(timeZone);
  }
  return null;
}

async function maybeScheduleNextCheckin(db, row, { response, issueType, issueNote }) {
  const existingFuture = await getNextScheduledCheckin(db, row);
  if (existingFuture) return existingFuture;

  const metadata = safeJson(row.metadata_json, {});
  const scheduledFor = nextRecurringTime(row, metadata);
  if (!scheduledFor) return null;

  const profile = await db.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', [
    row.profile_id,
    row.user_id,
  ]);
  if (!profile) return null;

  const carryForwardIssue = ['no', 'partially', 'faced_issue'].includes(response)
    ? (issueType || issueNote || response)
    : metadata.carryForwardIssue || null;

  const nextRecord = buildScheduledCheckin({
    userId: row.user_id,
    profile,
    offer: {
      type: row.type,
      title: row.title,
      goalId: row.goal_id,
      cadence: metadata.cadence,
      scheduledFor,
      metadata: {
        ...metadata,
        timezone: resolveTimeZone(metadata?.timezone),
        previousCheckinId: row.id,
        carryForwardIssue,
      },
    },
  });

  await createScheduledItem(db, nextRecord);
  return nextRecord;
}

async function updateProgress(db, row, response) {
  const scopeKey = `${row.profile_id}:${row.goal_id || 'general'}`;
  const existing = await db.get('SELECT * FROM goal_progress WHERE scope_key = ?', [scopeKey]);
  const total = await db.get(`
    SELECT COUNT(*) AS count
    FROM scheduled_checkins
    WHERE profile_id = ?
      AND COALESCE(goal_id, '') = COALESCE(?, '')
  `, [row.profile_id, row.goal_id]);
  const next = await getNextScheduledCheckin(db, row);
  const delta = getProgressDelta(response);
  const streak = response === 'yes'
    ? (existing?.streak || 0) + 1
    : response === 'partially'
      ? (existing?.streak || 0)
      : 0;

  const completed = (existing?.completed_checkins || 0) + (['yes', 'better', 'improving', 'done'].includes(response) ? 1 : 0);
  const partial = (existing?.partial_checkins || 0) + (['partially', 'same', 'not_sure'].includes(response) ? 1 : 0);
  const missed = (existing?.missed_checkins || 0) + (['no', 'skipped'].includes(response) ? 1 : 0);
  const issues = (existing?.issue_checkins || 0) + (['faced_issue', 'worse'].includes(response) ? 1 : 0);
  const score = (Number(existing?.score) || 0) + delta;

  if (existing) {
    await db.run(`
      UPDATE goal_progress
      SET total_scheduled_checkins = ?,
          completed_checkins = ?,
          partial_checkins = ?,
          missed_checkins = ?,
          issue_checkins = ?,
          score = ?,
          streak = ?,
          last_checkin_at = CURRENT_TIMESTAMP,
          next_checkin_at = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      total.count,
      completed,
      partial,
      missed,
      issues,
      score,
      streak,
      next?.scheduled_for || null,
      existing.id,
    ]);
  } else {
    await db.run(`
      INSERT INTO goal_progress (
        id, scope_key, user_id, profile_id, goal_id, total_scheduled_checkins,
        completed_checkins, partial_checkins, missed_checkins, issue_checkins,
        score, streak, last_checkin_at, next_checkin_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    `, [
      uuidv4(),
      scopeKey,
      row.user_id,
      row.profile_id,
      row.goal_id,
      total.count,
      completed,
      partial,
      missed,
      issues,
      score,
      streak,
      next?.scheduled_for || null,
    ]);
  }

  return db.get('SELECT * FROM goal_progress WHERE scope_key = ?', [scopeKey]);
}

async function recordIssueIfNeeded(db, row, response, issueType, issueNote, assistantMessage) {
  if (!['no', 'partially', 'faced_issue', 'worse', 'skipped'].includes(response)) return;

  await db.run(`
    INSERT INTO checkin_issues (
      id, checkin_id, profile_id, goal_id, issue_type, user_note,
      suggestion_given, carry_forward_to_next_checkin
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `, [
    uuidv4(),
    row.id,
    row.profile_id,
    row.goal_id,
    issueType || response,
    issueNote || null,
    assistantMessage,
  ]);
}

router.get('/checkins/notifications', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await listReminderItems(db, {
      userId: req.user.id,
      status: 'visible',
      limit: 30,
    });

    res.json(rows);
  } catch (error) {
    console.error('[Scheduled Checkins List]', error);
    res.status(500).json({ error: 'Failed to load check-ins' });
  }
});

router.get('/reminders', requireAuth, async (req, res) => {
  try {
    const profileId = req.query.profileId || null;
    const status = req.query.status || 'visible';
    const limit = parseInt(req.query.limit || '30', 10);
    const cacheKey = `${req.user.id}|${profileId || '*'}|${status}|${limit}`;

    const cached = getCachedReminderList(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    const db = await getDb();
    if (profileId) {
      const profile = await db.get('SELECT id FROM profiles WHERE id = ? AND user_id = ?', [
        profileId,
        req.user.id,
      ]);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
    }

    const rows = await listReminderItems(db, {
      userId: req.user.id,
      profileId,
      status,
      limit,
    });

    setCachedReminderList(cacheKey, rows);
    res.setHeader('X-Cache', 'MISS');
    res.json(rows);
  } catch (error) {
    console.error('[Reminders List]', error);
    res.status(500).json({ error: 'Failed to load reminders' });
  }
});

router.get('/reminders/status', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const profileId = req.query.profileId;
    if (!profileId) return res.status(400).json({ error: 'profileId is required' });

    const profile = await db.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', [
      profileId,
      req.user.id,
    ]);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const assistantMessage = await buildReminderStatusMessage(db, {
      userId: req.user.id,
      profileId,
      profile,
      query: req.query.query || '',
    });

    const reminders = await listReminderItems(db, {
      userId: req.user.id,
      profileId,
      status: 'active',
      limit: 8,
      markDue: true,
    });

    res.json({ assistantMessage, reminders });
  } catch (error) {
    console.error('[Reminders Status]', error);
    res.status(500).json({ error: 'Failed to get reminder status' });
  }
});

router.post('/reminders/:reminderId/acknowledge', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const item = await acknowledgeReminderItem(db, {
      userId: req.user.id,
      itemId: req.params.reminderId,
    });
    if (!item) return res.status(404).json({ error: 'Reminder not found' });
    invalidateReminderListCache({ userId: req.user.id });
    res.json(item);
  } catch (error) {
    console.error('[Reminder Acknowledge]', error);
    res.status(500).json({ error: 'Failed to acknowledge reminder' });
  }
});

router.post('/reminders/:reminderId/dismiss', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const item = await dismissReminderItem(db, {
      userId: req.user.id,
      itemId: req.params.reminderId,
    });
    if (!item) return res.status(404).json({ error: 'Reminder not found' });
    invalidateReminderListCache({ userId: req.user.id });
    res.json(item);
  } catch (error) {
    console.error('[Reminder Dismiss]', error);
    res.status(500).json({ error: 'Failed to dismiss reminder' });
  }
});

// Recent reminders for a profile (used to diagnose delivery failures)
router.get('/profiles/:profileId/reminders/recent', requireAuth, requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await getRecentReminderRows(db, {
      userId: req.user.id,
      profileId: req.params.profileId,
      limit: parseInt(req.query.limit || '5', 10),
    });

    res.json(rows.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status,
      scheduledFor: row.scheduled_for,
      deliveredAt: row.delivered_at,
      shownAt: row.shown_at,
      acknowledgedAt: row.acknowledged_at,
      completedAt: row.completed_at,
      metadata: safeJson(row.metadata_json, {}),
      createdAt: row.created_at,
    })));
  } catch (error) {
    console.error('[Recent Reminders]', error);
    res.status(500).json({ error: 'Failed to load recent reminders' });
  }
});

router.get('/profiles/:profileId/checkins/progress', requireAuth, requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.all(`
      SELECT gp.*, g.title AS goal_title
      FROM goal_progress gp
      LEFT JOIN goals g ON g.id = gp.goal_id
      WHERE gp.user_id = ?
        AND gp.profile_id = ?
        AND gp.status != 'deleted'
      ORDER BY gp.updated_at DESC
    `, [req.user.id, req.params.profileId]);

    res.json(rows.map(row => ({
      id: row.id,
      goalId: row.goal_id,
      goalTitle: row.goal_title || 'Check-ins',
      totalScheduledCheckins: row.total_scheduled_checkins,
      completedCheckins: row.completed_checkins,
      partialCheckins: row.partial_checkins,
      missedCheckins: row.missed_checkins,
      issueCheckins: row.issue_checkins,
      score: row.score,
      streak: row.streak,
      lastCheckinAt: row.last_checkin_at,
      nextCheckinAt: row.next_checkin_at,
      currentDay: row.current_day,
      status: row.status,
    })));
  } catch (error) {
    console.error('[Scheduled Checkins Progress]', error);
    res.status(500).json({ error: 'Failed to load check-in progress' });
  }
});

router.post('/profiles/:profileId/scheduled-checkins', requireAuth, requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const profile = await db.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', [
      req.params.profileId,
      req.user.id,
    ]);

    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const offer = req.body.offer || req.body;
    if (!offer?.scheduledFor) {
      return res.status(400).json({
        error: 'Timing is needed before scheduling.',
        assistantMessage: 'I’m close, just need one tiny detail 🌿 What time should I use for this?',
      });
    }

    const record = buildScheduledCheckin({
      userId: req.user.id,
      profile,
      offer,
    });

    await createScheduledItem(db, record);
    await db.run(
      'UPDATE patient_states SET pending_followup_offer_json = NULL WHERE profile_id = ?',
      [req.params.profileId]
    );

    if (req.body.userMessage) {
      await insertConversationMessage(db, {
        userId: req.user.id,
        profileId: req.params.profileId,
        role: 'user',
        content: req.body.userMessage,
        safetyAction: 'ACCEPT_CHECKIN',
      });
    }

    const reply = buildScheduleConfirmation({ records: [record], profile });
    await insertConversationMessage(db, {
      userId: req.user.id,
      profileId: req.params.profileId,
      role: 'assistant',
      content: reply,
      safetyAction: 'SCHEDULE_CHECKIN',
    });

    res.status(201).json({ checkin: record, reply, assistantMessage: reply });
  } catch (error) {
    console.error('[Scheduled Checkins Create]', error);
    res.status(500).json({ error: 'Failed to schedule check-in' });
  }
});

router.post('/scheduled-checkins/:checkinId/open', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const opened = await openScheduledItem(db, {
      userId: req.user.id,
      itemId: req.params.checkinId,
    });

    if (opened.error === 'not_found') return res.status(404).json({ error: 'Check-in not found' });

    if (opened.error === 'not_due') {
      return res.status(409).json({
        error: 'This item is scheduled but not due yet.',
        checkin: opened.item,
      });
    }

    if (opened.shouldInsertMessage && opened.row) {
      await insertConversationMessage(db, {
        userId: req.user.id,
        profileId: opened.row.profile_id,
        role: 'assistant',
        content: opened.row.detailed_chat_message,
      });
    }

    res.json(opened.item);
  } catch (error) {
    console.error('[Scheduled Checkins Open]', error);
    res.status(500).json({ error: 'Failed to open check-in' });
  }
});

router.post('/scheduled-checkins/:checkinId/respond', requireAuth, async (req, res) => {
  try {
    const { response, issueType = null, issueNote = null } = req.body;
    const allowed = ['yes', 'no', 'partially', 'faced_issue', 'better', 'same', 'worse', 'improving', 'done', 'skipped', 'not_sure'];
    if (!allowed.includes(response)) {
      return res.status(400).json({ error: 'Invalid check-in response' });
    }

    const db = await getDb();
    const row = await db.get(
      'SELECT * FROM scheduled_checkins WHERE id = ? AND user_id = ?',
      [req.params.checkinId, req.user.id]
    );

    if (!row) return res.status(404).json({ error: 'Check-in not found' });
    if (['completed', 'missed', 'cancelled'].includes(row.status)) {
      return res.json({
        success: true,
        status: row.status,
        response: row.response,
        assistantMessage: 'This check-in has already been logged.',
      });
    }

    const status = ['no', 'skipped'].includes(response) ? 'missed' : 'completed';
    await db.run(`
      UPDATE scheduled_checkins
      SET status = ?,
          response = ?,
          issue_type = ?,
          issue_note = ?,
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [status, response, issueType, issueNote, row.id]);

    const future = await maybeScheduleNextCheckin(db, row, { response, issueType, issueNote });
    const assistantMessage = buildCheckinResponseMessage({
      checkin: row,
      response,
      hasFutureCheckin: Boolean(future),
    });

    await recordIssueIfNeeded(db, row, response, issueType, issueNote, assistantMessage);
    const progress = await updateProgress(db, row, response);
    await insertConversationMessage(db, {
      userId: req.user.id,
      profileId: row.profile_id,
      role: 'user',
      content: RESPONSE_LABELS[response] || response,
      safetyAction: 'CHECKIN_RESPONSE_SELECTION',
    });
    await insertConversationMessage(db, {
      userId: req.user.id,
      profileId: row.profile_id,
      role: 'assistant',
      content: assistantMessage,
      safetyAction: 'CHECKIN_RESPONSE',
    });

    res.json({
      success: true,
      status,
      response,
      assistantMessage,
      progress: progress ? {
        totalScheduledCheckins: progress.total_scheduled_checkins,
        completedCheckins: progress.completed_checkins,
        partialCheckins: progress.partial_checkins,
        missedCheckins: progress.missed_checkins,
        issueCheckins: progress.issue_checkins,
        score: progress.score,
        streak: progress.streak,
        nextCheckinAt: progress.next_checkin_at,
      } : null,
    });
  } catch (error) {
    console.error('[Scheduled Checkins Respond]', error);
    res.status(500).json({ error: 'Failed to save check-in response' });
  }
});

export default router;
