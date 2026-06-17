import { v4 as uuidv4 } from 'uuid';
import { generateJSON, generateMainText } from './ai.js';
import { resolveTimeZone } from './timeService.js';

const RESPONSE_OPTIONS = ['yes', 'no', 'partially', 'faced_issue'];

const TAXONOMY = {
  medicine: {
    emoji: '💊',
    graceMinutes: 3,
    engagementHours: 12,
    title: 'Quick medicine follow-up',
    body: 'Did the prescribed timing happen as planned?',
    question: 'Did the prescribed dose/reminder happen as planned?',
  },
  hydration: {
    emoji: '💧',
    graceMinutes: 10,
    engagementHours: 24,
    title: 'Water check, but make it gentle',
    body: 'Did a few sips make it in?',
    question: 'Were you able to get some water in?',
  },
  nutrition: {
    emoji: '🍽️',
    graceMinutes: 20,
    engagementHours: 24,
    title: 'Meal check-in, no food police',
    body: 'Did the eating plan survive real life?',
    question: 'Were you able to follow the food/meal step?',
  },
  movement: {
    emoji: '🚶',
    graceMinutes: 15,
    engagementHours: 36,
    title: 'Tiny movement check',
    body: 'Did the body get its little nudge?',
    question: 'Were you able to do the movement step?',
  },
  sleep: {
    emoji: '🌙',
    graceMinutes: 15,
    engagementHours: 24,
    title: 'Morning sleep detective moment',
    body: 'How did the sleep plan go?',
    question: 'How did the sleep plan go?',
  },
  winddown: {
    emoji: '🌙',
    graceMinutes: 10,
    engagementHours: 24,
    title: 'Wind-down reality check',
    body: 'Did the night routine get a fighting chance?',
    question: 'Were you able to start winding down?',
  },
  recovery: {
    emoji: '🙂',
    graceMinutes: 30,
    engagementHours: 12,
    title: 'Tiny recovery check',
    body: 'How are things feeling now?',
    question: 'How are things feeling now?',
  },
  stress: {
    emoji: '🫶',
    graceMinutes: 15,
    engagementHours: 36,
    title: 'Small stress check',
    body: 'Did the calming step help even a tiny bit?',
    question: 'Did the stress-support step help?',
  },
  habit: {
    emoji: '😄',
    graceMinutes: 15,
    engagementHours: 36,
    title: 'Quick reality check, no judgment',
    body: 'Did the plan survive real life?',
    question: 'Did the habit plan survive real life?',
  },
  general: {
    emoji: '✨',
    graceMinutes: 10,
    engagementHours: 48,
    title: 'Tiny check-in',
    body: 'How did this go?',
    question: 'How did this go?',
  },
};

export function inferCheckinTaxonomy({ title = '', type = '', metadata = {}, profile = {} } = {}) {
  const text = [
    title,
    type,
    metadata.reminderType,
    metadata.goalType,
    metadata.taxonomy,
    metadata.category,
    profile.category,
    ...(Array.isArray(profile.goals) ? profile.goals : []),
    ...(Array.isArray(profile.conditions) ? profile.conditions : []),
  ].join(' ').toLowerCase();

  if (/medicine|medication|tablet|pill|dose|dosage|prescribed|prescription|mg\b/.test(text)) return 'medicine';
  if (/water|hydrat|drink|sips?/.test(text)) return 'hydration';
  if (/sleep|wake|bedtime|bed|insomnia/.test(text)) return 'sleep';
  if (/wind|screen|phone|night routine|curfew/.test(text)) return 'winddown';
  if (/meal|food|nutrition|breakfast|lunch|dinner|eat|daal|dal|cook/.test(text)) return 'nutrition';
  if (/walk|movement|exercise|workout|stretch|steps|posture/.test(text)) return 'movement';
  if (/stomach|loose motion|diarrhea|vomit|fever|recovery|symptom|ors|sick|illness/.test(text)) return 'recovery';
  if (/stress|anxious|anxiety|calm|breath|mindful|overthink|panic/.test(text)) return 'stress';
  if (/habit|routine|craving|scroll|addiction|masturbation|social media/.test(text)) return 'habit';
  return 'general';
}

export function getTaxonomyPolicy(taxonomy = 'general') {
  return TAXONOMY[taxonomy] || TAXONOMY.general;
}

export async function planEngagementCheckin({
  profile = {},
  patientState = {},
  taxonomy = 'general',
  idleMinutes = 2,
  timeZone,
} = {}) {
  const policy = getTaxonomyPolicy(taxonomy);
  const profileName = profile?.name || 'the profile';
  const structured = patientState?.structured_profile_json
    ? safeJson(patientState.structured_profile_json, {})
    : patientState?.structured_profile || patientState || {};
  const profileSummary = String(patientState?.profile_summary_text || '').trim();
  const concernText = [
    structured.current_concern,
    structured.concern,
    structured.concern_summary,
    structured.category,
    structured.primaryCategory,
    profile.category,
    profile.current_concern,
    profileSummary,
    ...(Array.isArray(structured.goals) ? structured.goals : []),
    ...(Array.isArray(structured.conditions) ? structured.conditions : []),
  ].filter(Boolean).join('; ');

  const fallbackDelay = Math.max(5, Math.min(policy.engagementHours * 60, 45));
  const fallback = {
    shouldSchedule: Boolean(concernText.trim()),
    delayMinutes: fallbackDelay,
    titleHint: `${policy.title} ${policy.emoji}`,
    bodyHint: policy.body,
    cardHint: policy.question,
    reason: 'taxonomy_fallback',
  };

  if (!concernText.trim()) return { ...fallback, shouldSchedule: false, reason: 'no_profile_concern' };

  try {
    const systemInstruction = `You are Anandaya's hidden engagement planner.
Decide whether to schedule one gentle in-app check-in for a profile that has gone quiet.
Return JSON only. Do not write user-facing prose.
The check-in should be warm, friendly, lightly witty when appropriate, and medically safe.
Choose a delay based on concern urgency and usefulness.
For medicine, never mention dosage changes. Only ask if the prescribed/reminder step happened.
Use sparse relevant emoji, 0-1 total in each text field.
JSON shape:
{
  "shouldSchedule": true,
  "delayMinutes": 15,
  "titleHint": "short notification title",
  "bodyHint": "short notification body",
  "cardHint": "one warm in-app check-in question",
  "reason": "short internal reason"
}`;
    const prompt = JSON.stringify({
      profileName,
      relation: profile?.relation || 'self',
      taxonomy,
      idleMinutes,
      timezone: timeZone || resolveTimeZone(patientState?.timezone, profile?.timezone),
      concernText,
      profileSummary,
      basics: {
        age: structured.age || profile.age,
        sex: structured.sex || profile.sex,
      },
    }, null, 2);
    const plan = await generateJSON(systemInstruction, prompt);
    return normalizeEngagementPlan(plan, fallback, taxonomy);
  } catch (error) {
    console.warn('[EngagementPlanner] Planner failed, using fallback:', error.message);
    return normalizeEngagementPlan(fallback, fallback, taxonomy);
  }
}

export async function buildReminderFollowupCheckin({ parentRecord, profile = {} } = {}) {
  if (!parentRecord?.id || parentRecord.metadata?.kind !== 'reminder') return null;
  if (parentRecord.metadata?.skipAutoFollowup) return null;

  const taxonomy = inferCheckinTaxonomy({
    title: parentRecord.title,
    type: parentRecord.type,
    metadata: parentRecord.metadata,
    profile,
  });
  const policy = getTaxonomyPolicy(taxonomy);
  const timeZone = resolveTimeZone(parentRecord.metadata?.timezone, profile?.timezone);
  const scheduledFor = new Date(new Date(parentRecord.scheduledFor).getTime() + policy.graceMinutes * 60_000).toISOString();
  const copy = await buildCheckinCopy({
    source: 'reminder_followup',
    taxonomy,
    profile,
    taskTitle: parentRecord.title,
    timeZone,
  });

  return {
    id: uuidv4(),
    userId: parentRecord.userId,
    profileId: parentRecord.profileId,
    goalId: parentRecord.goalId || null,
    relation: parentRecord.relation,
    type: `${taxonomy}_followup_checkin`,
    status: 'pending_trigger',
    scheduledFor,
    title: copy.title,
    pushTitle: copy.pushTitle,
    pushBody: copy.pushBody,
    inAppTitle: copy.inAppTitle,
    inAppBody: copy.inAppBody,
    detailedChatMessage: copy.detailedChatMessage,
    responseOptions: copy.responseOptions,
    source: 'wellness_chat',
    category: taxonomy,
    channel: 'in_app',
    metadata: {
      kind: 'checkin',
      checkinSource: 'reminder_followup',
      parentReminderId: parentRecord.id,
      hiddenUntilTriggered: true,
      triggerCondition: 'parent_reminder_unopened',
      graceMinutes: policy.graceMinutes,
      tone: 'warm_witty',
      emoji: copy.emoji,
      taxonomy,
      timezone: timeZone,
      createdAt: new Date().toISOString(),
      copyGeneratedAt: copy.generatedAt,
      generatedBy: copy.generatedBy,
    },
  };
}

export async function buildStandaloneCheckinRecord({
  userId,
  profile,
  title,
  dueAt,
  timeZone,
  sourceText = '',
  source = 'tool_orchestrator',
} = {}) {
  const taxonomy = inferCheckinTaxonomy({ title, metadata: { sourceText }, profile });
  const copy = await buildCheckinCopy({
    source: 'standalone',
    taxonomy,
    profile,
    taskTitle: title,
    timeZone,
  });

  return {
    id: uuidv4(),
    userId,
    profileId: profile.id,
    goalId: null,
    relation: isSelfProfile(profile) ? 'self' : 'other',
    type: `${taxonomy}_standalone_checkin`,
    status: 'scheduled',
    scheduledFor: dueAt,
    title: copy.title,
    pushTitle: copy.pushTitle,
    pushBody: copy.pushBody,
    inAppTitle: copy.inAppTitle,
    inAppBody: copy.inAppBody,
    detailedChatMessage: copy.detailedChatMessage,
    responseOptions: copy.responseOptions,
    source: 'wellness_chat',
    category: taxonomy,
    channel: 'in_app',
    metadata: {
      kind: 'checkin',
      checkinSource: 'standalone',
      tone: 'warm_witty',
      emoji: copy.emoji,
      taxonomy,
      timezone: timeZone,
      sourceText,
      plannerSource: source,
      createdAt: new Date().toISOString(),
      copyGeneratedAt: copy.generatedAt,
      generatedBy: copy.generatedBy,
    },
  };
}

export async function buildEngagementCheckinRecord({
  userId,
  profile,
  patientState = {},
  taxonomy = 'general',
  scheduledFor = new Date().toISOString(),
  engagementPlan = {},
} = {}) {
  const timeZone = resolveTimeZone(patientState?.timezone, profile?.timezone);
  const copy = await buildCheckinCopy({
    source: 'engagement',
    taxonomy,
    profile,
    taskTitle: engagementPlan?.titleHint || engagementPlan?.bodyHint || 'progress update',
    timeZone,
    plannerHints: engagementPlan,
  });
  const isFuture = new Date(scheduledFor).getTime() > Date.now() + 1000;

  return {
    id: uuidv4(),
    userId,
    profileId: profile.id,
    goalId: null,
    relation: isSelfProfile(profile) ? 'self' : 'other',
    type: `${taxonomy}_engagement_checkin`,
    status: isFuture ? 'scheduled' : 'due',
    scheduledFor,
    title: copy.title,
    pushTitle: copy.pushTitle,
    pushBody: copy.pushBody,
    inAppTitle: copy.inAppTitle,
    inAppBody: copy.inAppBody,
    detailedChatMessage: copy.detailedChatMessage,
    responseOptions: copy.responseOptions,
    source: 'wellness_chat',
    category: taxonomy,
    channel: 'in_app',
    metadata: {
      kind: 'checkin',
      checkinSource: 'engagement',
      triggerCondition: 'profile_progress_inactive',
      plannerReason: engagementPlan?.reason || null,
      plannedDelayMinutes: engagementPlan?.delayMinutes || null,
      tone: 'warm_witty',
      emoji: copy.emoji,
      taxonomy,
      timezone: timeZone,
      createdAt: new Date().toISOString(),
      copyGeneratedAt: copy.generatedAt,
      generatedBy: copy.generatedBy,
    },
  };
}

export async function buildCheckinCopy({
  source,
  taxonomy,
  profile = {},
  taskTitle = '',
  timeZone,
  plannerHints = {},
} = {}) {
  const policy = getTaxonomyPolicy(taxonomy);
  const profileName = profile?.name || 'you';
  const isSelf = isSelfProfile(profile);
  const owner = isSelf ? 'you' : profileName;
  const fallback = buildFallbackCopy({ source, taxonomy, policy, profileName, owner, isSelf, taskTitle });
  const profileContext = buildProfileContext(profile);

  try {
    const systemInstruction = `You are Anandaya's main wellness companion writing a stored check-in copy set.
Return plain text, not JSON. Keep it warm, catchy, lightly witty, and not clinical.
The copy will be saved in the database now and shown later in the notification bell at the scheduled time.
Do not include button labels or bracketed choices like [Yes] [No].
Do not suggest medication dosage changes. For medicine, only ask whether the prescribed/reminder step happened.
Use 0-1 relevant emoji total per field; do not use 🌿 unless supplied.
Format exactly:
TITLE: ...
BODY: ...
CARD: ...`;
    const prompt = `Profile name: ${profileName}
Relation: ${profile?.relation || 'self'}
Check-in source: ${source}
Taxonomy: ${taxonomy}
Task/context: ${taskTitle}
Profile context: ${profileContext}
Due timezone: ${timeZone || 'Asia/Kolkata'}
Emoji: ${policy.emoji}
Planner title hint: ${plannerHints?.titleHint || 'none'}
Planner body hint: ${plannerHints?.bodyHint || 'none'}
Planner card hint: ${plannerHints?.cardHint || 'none'}
Fallback title: ${fallback.title}
Fallback body: ${fallback.body}
Fallback card: ${fallback.card}

Write as if we are gently inviting the person back to update progress. Make it easy to tap, not formal.`;
    const text = await generateMainText(systemInstruction, prompt, 0.45);
    const parsed = parseCopyText(text);
    if (parsed?.title && parsed?.body && parsed?.card && !/temporarily unavailable/i.test(text)) {
      return toCopyPayload({
        ...fallback,
        title: limitText(parsed.title, 80),
        body: limitText(parsed.body, 140),
        card: parsed.card,
        generatedBy: 'main_llm',
      });
    }
  } catch (error) {
    console.warn('[CheckinCopy] LLM polish failed:', error.message);
  }

  return toCopyPayload({ ...fallback, generatedBy: 'template' });
}

function buildFallbackCopy({ source, taxonomy, policy, profileName, owner, isSelf, taskTitle }) {
  const emoji = policy.emoji;
  const label = cleanTaskLabel(taskTitle);
  const ownerText = isSelf ? 'you' : profileName;

  if (taxonomy === 'medicine') {
    return {
      emoji,
      title: isSelf ? `Quick medicine follow-up ${emoji}` : `Medicine follow-up for ${profileName} ${emoji}`,
      body: 'Did the prescribed timing happen as planned?',
      card: `${isSelf ? 'Quick medicine follow-up' : `Quick medicine follow-up for ${profileName}`} ${emoji}\n\nDid the prescribed dose/reminder happen as planned?`,
    };
  }

  if (taxonomy === 'recovery') {
    return {
      emoji,
      title: `Tiny recovery check for ${ownerText} ${emoji}`,
      body: source === 'engagement' ? 'How are things feeling now?' : `Did ${label} happen okay?`,
      card: `${isSelf ? 'Tiny recovery check' : `Tiny recovery check for ${profileName}`} ${emoji}\n\nHow are things feeling now?`,
      responseOptions: ['better', 'same', 'worse', 'faced_issue'],
    };
  }

  if (taxonomy === 'sleep') {
    return {
      emoji,
      title: `Morning sleep detective moment ${emoji}`,
      body: 'How did last night go?',
      card: `${isSelf ? 'Sleep detective moment' : `Sleep check for ${profileName}`} ${emoji}\n\nHow did the sleep plan go?`,
    };
  }

  if (taxonomy === 'hydration') {
    return {
      emoji,
      title: `Water check, but make it gentle ${emoji}`,
      body: 'Did a few sips make it in?',
      card: `${isSelf ? 'Water check' : `Water check for ${profileName}`} ${emoji}\n\nDid a few sips make it in?`,
    };
  }

  if (taxonomy === 'habit') {
    return {
      emoji,
      title: `Quick reality check, no judgment ${emoji}`,
      body: 'Did the plan survive real life?',
      card: `${isSelf ? 'Reality check, no judgment' : `Reality check for ${profileName}`} ${emoji}\n\nDid the plan survive real life?`,
    };
  }

  if (taxonomy === 'nutrition') {
    return {
      emoji,
      title: `Meal check-in, no food police ${emoji}`,
      body: 'Did the eating plan survive real life?',
      card: `${isSelf ? 'Meal check-in' : `Meal check-in for ${profileName}`} ${emoji}\n\nDid the eating plan survive real life?`,
    };
  }

  return {
    emoji,
    title: `${policy.title} ${emoji}`,
    body: policy.body,
    card: `${isSelf ? policy.title : `${policy.title} for ${profileName}`} ${emoji}\n\n${policy.question}`,
  };
}

function toCopyPayload(copy) {
  const emoji = copy.emoji || '✨';
  const responseOptions = copy.responseOptions || RESPONSE_OPTIONS;
  const title = sanitizeCheckinText(copy.title, emoji, 90);
  const body = sanitizeCheckinText(copy.body, emoji, 150);
  const card = sanitizeCheckinText(copy.card, emoji, 600, { allowNewlines: true });
  return {
    emoji,
    title,
    pushTitle: title,
    pushBody: body,
    inAppTitle: title,
    inAppBody: body,
    detailedChatMessage: card,
    responseOptions,
    generatedAt: new Date().toISOString(),
    generatedBy: copy.generatedBy || 'template',
  };
}

function parseCopyText(text = '') {
  const title = text.match(/^TITLE:\s*(.+)$/im)?.[1]?.trim();
  const body = text.match(/^BODY:\s*(.+)$/im)?.[1]?.trim();
  const card = text.match(/^CARD:\s*([\s\S]+)$/im)?.[1]?.trim();
  if (!title || !body || !card) return null;
  return { title, body, card };
}

function normalizeEngagementPlan(plan = {}, fallback = {}, taxonomy = 'general') {
  const policy = getTaxonomyPolicy(taxonomy);
  const rawDelay = Number(plan?.delayMinutes);
  const maxDelay = taxonomy === 'recovery' || taxonomy === 'medicine' ? 180 : 720;
  const minDelay = taxonomy === 'medicine' ? 3 : 5;
  const delayMinutes = Number.isFinite(rawDelay)
    ? Math.max(minDelay, Math.min(Math.round(rawDelay), maxDelay))
    : fallback.delayMinutes;

  return {
    shouldSchedule: plan?.shouldSchedule !== false && fallback.shouldSchedule !== false,
    delayMinutes,
    titleHint: limitText(plan?.titleHint || fallback.titleHint || `${policy.title} ${policy.emoji}`, 90),
    bodyHint: limitText(plan?.bodyHint || fallback.bodyHint || policy.body, 150),
    cardHint: limitText(plan?.cardHint || fallback.cardHint || policy.question, 400),
    reason: limitText(plan?.reason || fallback.reason || 'engagement_planner', 120),
  };
}

function safeJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function isSelfProfile(profile = {}) {
  const rel = String(profile.relation || profile.relationToUser || '').trim().toLowerCase();
  return rel === 'self' || rel === 'myself';
}

function buildProfileContext(profile = {}) {
  const structured = profile.structured_profile || profile.structuredProfile || profile.patientState?.structured_profile || {};
  const values = [
    structured.category || profile.category ? `category=${structured.category || profile.category}` : '',
    structured.severity || profile.severity ? `severity=${structured.severity || profile.severity}` : '',
    Array.isArray(structured.goals) && structured.goals.length ? `goals=${structured.goals.slice(0, 3).join(', ')}` : '',
    Array.isArray(structured.conditions) && structured.conditions.length ? `conditions=${structured.conditions.slice(0, 3).join(', ')}` : '',
    Array.isArray(structured.medications) && structured.medications.length ? `medicines=${structured.medications.slice(0, 2).join(', ')}` : '',
  ].filter(Boolean);

  return values.length ? values.join('; ') : 'No extra profile context available.';
}

function cleanTaskLabel(value = '') {
  return String(value || 'the step')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function limitText(value = '', max = 120) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trim()}…` : clean;
}

function sanitizeCheckinText(value = '', emoji = '✨', max = 160, { allowNewlines = false } = {}) {
  const lineBreakToken = '__CHECKIN_LINE_BREAK__';
  let clean = String(value || '')
    .replace(/^\s*(?:\[[^\]]+\]\s*){2,}$/gm, '')
    .replace(/\s*,?\s*\bbaby\b\s*,?/gi, ' ')
    .replace(/\b(?:clinical assessment|required configuration|invalid format|compliance)\b/gi, '')
    .replace(/\n/g, allowNewlines ? lineBreakToken : ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  const emojiPattern = /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?/gu;
  let usedEmoji = false;
  clean = clean.replace(emojiPattern, (match) => {
    if (match === emoji && !usedEmoji) {
      usedEmoji = true;
      return match;
    }
    return '';
  });

  clean = clean
    .replace(new RegExp(lineBreakToken, 'g'), '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return limitText(clean, max);
}
