import { v4 as uuidv4 } from 'uuid';
import {
  addHoursUtc,
  getZonedHour,
  nextLocalTimeUtc,
  resolveTimeZone,
} from './timeService.js';
import { buildWarmScheduleOfferText } from './scheduleIntentParser.js';

export const CHECKIN_TYPES = Object.freeze({
  SLEEP_DAILY: 'sleep_daily',
  WATER_2_HOURLY: 'water_2_hourly',
  NUTRITION_MEAL: 'nutrition_meal',
  RECOVERY_DAILY: 'recovery_daily',
  EXERCISE_FOLLOWUP: 'exercise_followup',
  STRESS_DAILY: 'stress_daily',
  HABIT_DAILY: 'habit_daily',
  GENERAL: 'general',
});

const RESPONSE_OPTIONS = ['yes', 'no', 'partially', 'faced_issue'];

export function getProgressDelta(response) {
  if (['yes', 'better', 'improving', 'done'].includes(response)) return 1;
  if (['partially', 'same', 'not_sure'].includes(response)) return 0.5;
  return 0;
}

const TYPE_COPY = {
  [CHECKIN_TYPES.SLEEP_DAILY]: {
    title: 'Sleep check-in',
    cadence: 'daily',
    selfQuestion: 'Shall we check in tomorrow to see how your sleep went?',
    otherQuestion: (name) => `Would you like me to check in tomorrow about ${name}'s sleep target and how rested they seemed?`,
  },
  [CHECKIN_TYPES.WATER_2_HOURLY]: {
    title: 'Hydration check-in',
    cadence: 'every_2_hours',
    selfQuestion: 'Would you like some gentle hydration reminders throughout the day, or just one check-in?',
    otherQuestion: (name) => `Would you like gentle hydration check-ins for ${name} every 2 hours during waking hours, or one daily check-in?`,
  },
  [CHECKIN_TYPES.NUTRITION_MEAL]: {
    title: 'Nutrition check-in',
    cadence: 'meal_based',
    selfQuestion: 'Would you like a quick check-in after your main meal to see how it went?',
    otherQuestion: (name) => `Would you like me to check in after ${name}'s main meal to see whether the nutrition plan felt manageable?`,
  },
  [CHECKIN_TYPES.RECOVERY_DAILY]: {
    title: 'Recovery check-in',
    cadence: 'daily',
    selfQuestion: 'Shall we check in tomorrow to track how your recovery is progressing?',
    otherQuestion: (name) => `Would you like me to check in tomorrow to track whether ${name}'s symptoms, hydration, and food tolerance are improving?`,
  },
  [CHECKIN_TYPES.EXERCISE_FOLLOWUP]: {
    title: 'Exercise check-in',
    cadence: 'after_next_workout_or_daily',
    selfQuestion: 'Would you like me to check in after your next workout to see how it felt?',
    otherQuestion: (name) => `Would you like me to check in after ${name}'s next workout or tomorrow to see how the plan felt?`,
  },
  [CHECKIN_TYPES.STRESS_DAILY]: {
    title: 'Stress check-in',
    cadence: 'daily',
    selfQuestion: 'Shall we check in tomorrow to see how your stress-support step felt?',
    otherQuestion: (name) => `Would you like me to check in tomorrow to see whether ${name}'s stress-support step felt manageable?`,
  },
  [CHECKIN_TYPES.HABIT_DAILY]: {
    title: 'Habit check-in',
    cadence: 'daily',
    selfQuestion: 'Shall we check in tomorrow to see if your habit target felt realistic?',
    otherQuestion: (name) => `Would you like me to check in tomorrow to see whether ${name}'s habit target felt realistic?`,
  },
  [CHECKIN_TYPES.GENERAL]: {
    title: 'Wellness check-in',
    cadence: 'daily',
    selfQuestion: 'Would you like a check-in tomorrow, or would you prefer to reach out on your own?',
    otherQuestion: (name) => `Would you like a check-in tomorrow for ${name}, or would you prefer to reach out only when you need help?`,
  },
};

function normalize(value) {
  return String(value || '').toLowerCase();
}

function isSelfProfile(profile = {}) {
  const relation = normalize(profile.relation || profile.relationToUser);
  return relation === 'self' || relation === 'myself';
}

function relationKind(profile = {}) {
  return isSelfProfile(profile) ? 'self' : 'other';
}

function getScheduleTimeZone({ profile, patientState, updatedProfile, offer } = {}) {
  const metadata = offer?.metadata || {};
  return resolveTimeZone(
    metadata.timezone,
    offer?.timezone,
    patientState?.timezone,
    updatedProfile?.timezone,
    profile?.timezone
  );
}

function nextMorningIso(timeZone, from = new Date()) {
  return nextLocalTimeUtc({ from, timeZone, hour: 9, minute: 0, forceTomorrow: true });
}

function todayEveningOrTomorrowIso(timeZone, from = new Date()) {
  if (getZonedHour(from, timeZone) >= 20) return nextMorningIso(timeZone, from);
  return nextLocalTimeUtc({ from, timeZone, hour: 20, minute: 0 });
}

function inferCheckinType({ message, profile, updatedProfile }) {
  const text = normalize([
    message,
    updatedProfile?.category,
    ...(updatedProfile?.goals || []),
    ...(profile?.goals || []),
  ].join(' '));

  if (/(sleep|bedtime|wake|insomnia|night routine)/.test(text)) return CHECKIN_TYPES.SLEEP_DAILY;
  if (/(water|hydration|drink water|thirst)/.test(text)) return CHECKIN_TYPES.WATER_2_HOURLY;
  if (/(nutrition|meal|diet|food|breakfast|lunch|dinner)/.test(text)) return CHECKIN_TYPES.NUTRITION_MEAL;
  if (/(loose motion|diarrhea|recovery|vomit|fever|symptom|stomach)/.test(text)) return CHECKIN_TYPES.RECOVERY_DAILY;
  if (/(exercise|workout|fitness|walking|steps|strength)/.test(text)) return CHECKIN_TYPES.EXERCISE_FOLLOWUP;
  if (/(stress|overthink|frustrated|anxious|anxiety|calm|mindful|mindfulness|breathing)/.test(text)) return CHECKIN_TYPES.STRESS_DAILY;
  if (/(habit|phone|screen|masturbation|addiction|routine|craving|scrolling|social media)/.test(text)) return CHECKIN_TYPES.HABIT_DAILY;
  return CHECKIN_TYPES.GENERAL;
}

function scheduledForForType(type, timeZone) {
  // Only auto-assign for water (2h from now is reasonable)
  // Everything else should ask the user for a time
  if (type === CHECKIN_TYPES.WATER_2_HOURLY) return addHoursUtc(new Date(), 2);
  return null;
}

function hasExplicitProgramDurationSelection(message = '', updatedProfile = {}) {
  if (!updatedProfile?.program_duration_days) return false;

  const text = normalize(message);
  return (
    /\b\d{1,3}\s*(?:days?|day)\b/.test(text) ||
    /\b(?:one|two|three|four)\s+weeks?\b/.test(text) ||
    /\b(?:for|track|duration|program)\s+\d{1,3}\b/.test(text) ||
    /^\s*\d{1,3}\s*$/.test(text)
  );
}

function hasExplicitCheckinScheduleRequest(message = '') {
  const text = normalize(message);
  const wantsCheckin = /\b(check(?:-|\s)?in|remind|schedule|notification|follow(?:-|\s)?up)\b/.test(text);
  const hasTimeAnchor = /\b(today|tomorrow|morning|evening|tonight|daily|every day|every \d+ hours?)\b/.test(text) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(text);

  return wantsCheckin && hasTimeAnchor;
}

function scheduledForExplicitRequest(message, type, timeZone) {
  const text = normalize(message);
  const clockMatch = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);

  if (clockMatch) {
    let hour = Number(clockMatch[1]);
    const minute = Number(clockMatch[2] || 0);
    const ampm = clockMatch[3];

    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    return nextLocalTimeUtc({ timeZone, hour, minute });
  }

  if (/\b(today|tonight|evening)\b/.test(text)) {
    return todayEveningOrTomorrowIso(timeZone);
  }

  if (/\b(tomorrow|morning)\b/.test(text)) {
    return nextMorningIso(timeZone);
  }

  return scheduledForForType(type, timeZone);
}

function shouldOfferCheckin({ message, patientState, updatedProfile, safety }) {
  if (!updatedProfile || safety?.level === 'RED' || safety?.level === 'ORANGE') return false;

  const previousProfile = safeJson(patientState?.structured_profile_json) || {};
  const hadNoProgram = !previousProfile.program_duration_days;
  const nowHasProgram = Boolean(updatedProfile.program_duration_days);
  const newlySelectedDuration = nowHasProgram &&
    (!previousProfile.program_duration_days ||
      Number(previousProfile.program_duration_days) !== Number(updatedProfile.program_duration_days)) &&
    hasExplicitProgramDurationSelection(message, updatedProfile);

  return (hadNoProgram && newlySelectedDuration) || hasExplicitCheckinScheduleRequest(message);
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

export function buildCheckinOffer({ message, profile, patientState, updatedProfile, rawReply, safety }) {
  if (!shouldOfferCheckin({ message, patientState, updatedProfile, rawReply, safety })) return null;

  const type = inferCheckinType({ message, profile, updatedProfile });
  const copy = TYPE_COPY[type] || TYPE_COPY[CHECKIN_TYPES.GENERAL];
  const profileName = profile?.name || 'this profile';
  const relation = relationKind(profile);
  const explicitCheckinRequest = hasExplicitCheckinScheduleRequest(message);
  const oneTime = explicitCheckinRequest && !updatedProfile?.program_duration_days;
  const question = oneTime
    ? (relation === 'self'
        ? 'We can set that check-in. Should we schedule it?'
        : `We can set that check-in for ${profileName}. Should we schedule it?`)
    : buildWarmScheduleOfferText({ offer: { ...copy, type }, profile });
  const timeZone = getScheduleTimeZone({ profile, patientState, updatedProfile });
  const scheduledFor = explicitCheckinRequest
    ? scheduledForExplicitRequest(message, type, timeZone)
    : null;
  const cadence = oneTime ? 'one_time' : copy.cadence;

  return {
    type,
    cadence,
    scheduledFor,
    timezone: timeZone,
    title: copy.title,
    question,
    reason: oneTime
      ? 'The user asked for a specific check-in.'
      : 'A tracked plan duration was confirmed, so a follow-up could help track progress.',
    responseOptions: RESPONSE_OPTIONS,
    metadata: {
      goalType: updatedProfile?.category || type,
      protocolDay: patientState?.current_day || 0,
      cadence,
      timezone: timeZone,
      timingProvided: explicitCheckinRequest,
    },
  };
}

export function isCheckinOfferAccepted(message = '') {
  const text = normalize(message);
  if (/\b(no|not now|don't|do not|skip|later maybe)\b/.test(text)) return false;
  return /\b(yes|yeah|yep|ok|okay|sure|please|schedule|check in|remind|daily|every 2 hours|tomorrow)\b/.test(text);
}

export function isCheckinOfferDeclined(message = '') {
  return /\b(no|not now|don't|do not|skip|no thanks|later maybe)\b/i.test(message);
}

export function buildScheduledCheckin({ userId, profile, offer }) {
  const type = offer?.type && TYPE_COPY[offer.type] ? offer.type : CHECKIN_TYPES.GENERAL;
  const copy = TYPE_COPY[type] || TYPE_COPY[CHECKIN_TYPES.GENERAL];
  const profileName = profile?.name || 'this profile';
  const relation = relationKind(profile);
  const isSelf = relation === 'self';
  const timeZone = getScheduleTimeZone({ profile, offer });
  const metadata = {
    ...(offer?.metadata || {}),
    kind: offer?.kind || offer?.metadata?.kind || 'checkin',
    cadence: offer?.cadence || copy.cadence,
    timezone: timeZone,
  };
  const isReminder = metadata.kind === 'reminder';
  const scheduledFor = type === CHECKIN_TYPES.WATER_2_HOURLY && offer?.cadence === 'daily'
    ? nextMorningIso(timeZone)
    : (offer?.scheduledFor || scheduledForForType(type, timeZone));
  const title = offer?.title || copy.title;
  const detailedChatMessage = offer?.detailedChatMessage ||
    (isReminder ? `${title} 🌿\n\nA gentle reminder for the plan you set.` : buildDetailedChatMessage({ type, profileName, isSelf }));
  const responseOptions = Array.isArray(offer?.responseOptions)
    ? offer.responseOptions
    : (isReminder ? [] : RESPONSE_OPTIONS);

  return {
    id: uuidv4(),
    userId,
    profileId: profile.id,
    goalId: offer?.goalId || null,
    relation,
    type,
    status: 'scheduled',
    scheduledFor,
    title,
    pushTitle: isReminder ? `${title} 🌿` : (isSelf ? 'Tiny progress ping ✨' : `Tiny progress ping for ${profileName} ✨`),
    pushBody: isReminder ? 'Tap to view this gentle reminder.' : 'Tap to share a quick update.',
    inAppTitle: isReminder ? `${title} scheduled 🌿` : `${title} scheduled 🌙`,
    inAppBody: isReminder ? 'Scheduled around your day.' : 'It will be ready at the scheduled time.',
    detailedChatMessage,
    responseOptions,
    metadata,
  };
}

function buildDetailedChatMessage({ type, profileName, isSelf }) {
  if (type === CHECKIN_TYPES.WATER_2_HOURLY) {
    return isSelf
      ? 'Sip check, no pressure 💧\n\nHave you taken a glass of water since the last check-in?'
      : `Sip check for ${profileName} 💧\n\nHas ${profileName} taken a glass of water since the last check-in?`;
  }

  if (type === CHECKIN_TYPES.SLEEP_DAILY) {
    return isSelf
      ? 'Morning sleep detective moment 🌙\n\nDid you follow your sleep target last night?'
      : `Sleep detective moment for ${profileName} 🌙\n\nDid ${profileName} follow the sleep target last night?`;
  }

  if (type === CHECKIN_TYPES.RECOVERY_DAILY) {
    return 'Tiny health check 🙂\n\nAre symptoms improving, the same, or worse today?';
  }

  if (type === CHECKIN_TYPES.NUTRITION_MEAL) {
    return isSelf
      ? 'Meal check, real life edition 🍽️\n\nDid the meal plan feel manageable today?'
      : `Meal check for ${profileName} 🍽️\n\nDid the meal plan feel manageable for ${profileName} today?`;
  }

  if (type === CHECKIN_TYPES.STRESS_DAILY) {
    return isSelf
      ? 'Tiny stress reset check 🫶\n\nDid you try the stress-support step today?'
      : `Tiny stress reset check for ${profileName} 🫶\n\nDid ${profileName} try the stress-support step today?`;
  }

  if (type === CHECKIN_TYPES.HABIT_DAILY) {
    return isSelf
      ? 'Reality check, kindly 😄\n\nWere you able to follow the habit target today?'
      : `Reality check for ${profileName} 😄\n\nWas ${profileName} able to follow the habit target today?`;
  }

  return isSelf
    ? 'Tiny progress ping ✨\n\nWere you able to follow the plan today?'
    : `Tiny progress ping for ${profileName} ✨\n\nWas ${profileName} able to follow the plan today?`;
}

export function buildCheckinResponseMessage({ checkin, response, hasFutureCheckin = false }) {
  const type = checkin?.type || CHECKIN_TYPES.GENERAL;
  const nextLine = hasFutureCheckin
    ? '\n\nI will take an update on this in your next scheduled check-in.'
    : '';

  if (['better', 'improving', 'done'].includes(response)) {
    return `Good, logged 🌿\n\nThat is useful progress data. Keep the next step gentle and realistic.${nextLine}`;
  }

  if (['same', 'not_sure'].includes(response)) {
    return `Logged 🌿\n\nNo need to force a conclusion. We can watch the pattern and keep the next step simple.${nextLine}`;
  }

  if (response === 'worse') {
    return 'Thanks for telling me. Logged.\n\nIf this feels severe, worsening quickly, or unsafe, please consider contacting a qualified healthcare professional or trusted adult now.';
  }

  if (response === 'skipped') {
    return `No worries, logged.\n\nWhat got in the way?\n\n[Forgot] [Busy] [Too hard] [Routine did not fit] [Other]${nextLine}`;
  }

  if (response === 'yes') {
    if (type === CHECKIN_TYPES.WATER_2_HOURLY) {
      return 'Nice, logged.\n\nNext quick question: did the reminder help, or did you remember on your own?\n\n[Reminder helped] [Remembered myself] [Still hard]';
    }
    if (type === CHECKIN_TYPES.SLEEP_DAILY) {
      return 'Great, logged.\n\nNext check: did you also follow the screen-time target before bed?\n\n[Yes] [Partially] [No]';
    }
    if (type === CHECKIN_TYPES.NUTRITION_MEAL) {
      return 'Good, logged.\n\nDid the meal feel manageable, or should we make the next one simpler?\n\n[Manageable] [Too much] [Need simpler plan]';
    }
    if (type === CHECKIN_TYPES.RECOVERY_DAILY) {
      return 'Logged.\n\nAre things improving, the same, or worse compared with the last check-in?\n\n[Improving] [Same] [Worse]';
    }
    return 'Logged.\n\nWhat felt easiest about following the plan today?';
  }

  if (response === 'no') {
    if (type === CHECKIN_TYPES.SLEEP_DAILY) {
      return `No worries, logged.\n\nWhat got in the way last night?\n\n[Phone use] [Work or study] [Could not sleep] [Stress] [Other]${nextLine}`;
    }
    if (type === CHECKIN_TYPES.NUTRITION_MEAL) {
      return `No worries, logged.\n\nWhat got in the way?\n\n[Skipped meal] [Too busy] [Food unavailable] [Did not feel hungry] [Other]${nextLine}`;
    }
    if (type === CHECKIN_TYPES.WATER_2_HOURLY) {
      return `No worries, logged.\n\nWhat got in the way?\n\n[Forgot] [Was busy] [Did not feel like it] [Not feeling well] [Other]${nextLine}`;
    }
    return `No worries, logged.\n\nWhat got in the way?\n\n[Forgot] [Busy] [Too hard] [Routine did not fit] [Other]${nextLine}`;
  }

  if (response === 'partially') {
    if (type === CHECKIN_TYPES.SLEEP_DAILY) {
      return `Partial progress is still useful data.\n\nWhat part did not go as planned?\n\n[Slept late] [Used phone] [Woke up late] [Could not fall asleep] [Other]${nextLine}`;
    }
    if (type === CHECKIN_TYPES.WATER_2_HOURLY) {
      return `Partial still counts. Logged as progress, not perfection.\n\nWhat stopped it from being fully done?\n\n[Forgot midway] [Was busy] [Target was too much] [Did not feel well] [Other]${nextLine}`;
    }
    return `Partial progress logged.\n\nWhat worked, and what did not?\n\n[Forgot midway] [Busy] [Target too much] [Did not feel well] [Other]${nextLine}`;
  }

  if (type === CHECKIN_TYPES.RECOVERY_DAILY) {
    return 'Thanks for telling me. What issue came up?\n\n[Symptoms worsened] [Fever] [Severe weakness] [Could not eat or drink] [Other]\n\nIf symptoms feel severe or unsafe, please do not wait for the next check-in. Consider contacting a qualified healthcare professional or trusted adult now.';
  }

  if (type === CHECKIN_TYPES.SLEEP_DAILY) {
    return `Thanks for telling me. What issue came up?\n\n[Stress] [Noise] [Could not fall asleep] [Late work or study] [Other]${nextLine}`;
  }

  if (type === CHECKIN_TYPES.WATER_2_HOURLY) {
    return `Thanks for telling me. What issue came up?\n\n[Felt unwell] [Could not access water] [Forgot] [Routine did not fit] [Other]${nextLine}`;
  }

  return `Thanks for telling me. What issue came up?\n\n[Felt unwell] [Routine did not fit] [Too hard] [Access problem] [Other]${nextLine}`;
}

export async function insertScheduledCheckin(db, record) {
  const metadata = record.metadata || {};
  const category = record.category || metadata.category || metadata.goalType || metadata.reminderType || record.type || null;
  await db.run(`
    INSERT INTO scheduled_checkins (
      id, user_id, profile_id, goal_id, relation, type, status, scheduled_for,
      title, push_title, push_body, in_app_title, in_app_body, detailed_chat_message,
      response_options_json, metadata_json, source, category, channel, series_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.id,
    record.userId,
    record.profileId,
    record.goalId,
    record.relation,
    record.type,
    record.status,
    record.scheduledFor,
    record.title,
    record.pushTitle,
    record.pushBody,
    record.inAppTitle,
    record.inAppBody,
    record.detailedChatMessage,
    JSON.stringify(record.responseOptions),
    JSON.stringify(metadata),
    record.source || metadata.source || 'wellness_chat',
    category,
    record.channel || metadata.channel || 'in_app',
    record.seriesId || metadata.seriesId || null,
  ]);

  return record;
}
