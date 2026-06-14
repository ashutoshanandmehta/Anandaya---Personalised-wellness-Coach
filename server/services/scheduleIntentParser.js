import { addHoursUtc, formatInTimeZone, nextLocalTimeUtc, resolveTimeZone } from './timeService.js';

export function parseRelativeTime(text, now = new Date()) {
  const match = text.match(/\b(?:in|after)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  let ms = 0;
  if (/^(minutes?|mins?)$/.test(unit)) ms = amount * 60 * 1000;
  else if (/^(hours?|hrs?)$/.test(unit)) ms = amount * 60 * 60 * 1000;

  if (ms <= 0) return null;
  return new Date(now.getTime() + ms).toISOString();
}

const CHECKIN_WORDS = /\b(check(?:-|\s)?in|check sleep|sleep check|follow(?:-|\s)?up)\b/i;
const TIME_WORDS = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const GENERIC_ACCEPTANCE = /\b(yes|yeah|yep|ok|okay|sure|please|schedule it|set it|do it)\b/i;
const SUGGESTION_REQUEST = /\b(suggest|recommend|you decide|not sure|not too early|whatever works|you tell me)\b/i;

function normalize(value) {
  return String(value || '').toLowerCase();
}

function isSelfProfile(profile = {}) {
  const relation = normalize(profile.relation || profile.relationToUser);
  return relation === 'self' || relation === 'myself';
}

function getProfileName(profile = {}) {
  return profile.name || 'this profile';
}

function getFriendlyName(profile = {}) {
  return String(profile.name || '').trim().split(/\s+/)[0] || '';
}

function routineOwner(profile = {}) {
  return isSelfProfile(profile) ? 'your day' : `${getProfileName(profile)}'s day`;
}

function leadWithName(profile = {}, text = '') {
  const name = getFriendlyName(profile);
  if (isSelfProfile(profile) && name) return `${name}, ${text}`;
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '';
}

function getTimeZone({ profile, patientState, offer } = {}) {
  const metadata = offer?.metadata || {};
  return resolveTimeZone(metadata.timezone, offer?.timezone, patientState?.timezone, profile?.timezone);
}

function hasConcreteTiming(message = '') {
  const text = normalize(message);
  return TIME_WORDS.test(text) ||
    /\b(after lunch|after dinner|after breakfast|after i wake|after waking|morning|night|evening|every \d+ hours?|every few hours|from \d{1,2}\s*(?:am|pm)?\s+to\s+\d{1,2})\b/i.test(text);
}

export function isGenericScheduleAcceptance(message = '') {
  const text = normalize(message);
  return GENERIC_ACCEPTANCE.test(text) && !hasConcreteTiming(text) && !SUGGESTION_REQUEST.test(text);
}

export function buildTimingCapturePrompt({ offer, profile } = {}) {
  const type = offer?.type || 'general';
  const owner = routineOwner(profile);

  if (type === 'sleep_daily') {
    return leadWithName(profile, `let's make this fit ${owner}. What time would feel realistic for the sleep reminder? You can say something like "11 PM" or "an hour before I sleep." We can keep it simple and adjust later.`);
  }

  if (type === 'water_2_hourly') {
    return leadWithName(profile, `what window should we keep water reminders inside? You can say something like "10 AM to 8 PM" or "after I wake up until evening."`);
  }

  if (type === 'nutrition_meal') {
    return leadWithName(profile, `when would a meal check-in feel useful? You can say "after lunch," "around dinner," or just a time like "8 PM."`);
  }

  if (type === 'recovery_daily') {
    return leadWithName(profile, `what time would feel easy for a recovery check-in? You can say "morning," "after dinner," or "9 PM."`);
  }

  return leadWithName(profile, `what time would fit ${owner} best for this? You can say it casually — like "8 PM," "after dinner," or "tomorrow morning."`);
}

export function buildWarmScheduleOfferText({ offer, profile } = {}) {
  const owner = routineOwner(profile);

  if (offer?.type === 'sleep_daily') {
    return leadWithName(profile, `should we set a gentle sleep reminder around ${owner}? Tell me when it would actually fit — no need to be exact. 🌙`);
  }

  if (offer?.type === 'water_2_hourly') {
    return leadWithName(profile, `want gentle water reminders through the day? Tell me what hours work, and we'll shape it around ${owner}. 🌊`);
  }

  return leadWithName(profile, `should we set a gentle reminder for this? Just tell me what time feels realistic. 🌿`);
}

export function parseScheduleTimingInput({ message, offer, profile, patientState, previousCapture } = {}) {
  const text = normalize(message);
  const timeZone = getTimeZone({ profile, patientState, offer });

  if (previousCapture?.suggestedItems?.length && /\b(yes|yeah|yep|ok|okay|sure|works|looks good|confirm)\b/i.test(text)) {
    return { status: 'ready', items: previousCapture.suggestedItems, timeZone };
  }

  if (offer?.scheduledFor && offer?.metadata?.timingProvided && isGenericScheduleAcceptance(text)) {
    return {
      status: 'ready',
      items: [{
        ...offer,
        kind: offer.kind || offer.metadata?.kind || 'checkin',
        metadata: {
          ...(offer.metadata || {}),
          kind: offer.kind || offer.metadata?.kind || 'checkin',
          timezone: timeZone,
        },
      }],
      timeZone,
    };
  }

  if (SUGGESTION_REQUEST.test(text)) {
    const suggestedItems = buildSuggestedItems({ offer, profile, patientState, timeZone });
    return {
      status: 'suggested',
      items: suggestedItems,
      reply: buildSuggestionReply(suggestedItems, timeZone),
      timeZone,
    };
  }

  if (isGenericScheduleAcceptance(text)) {
    return {
      status: 'needs_timing',
      reply: buildTimingCapturePrompt({ offer, profile }),
      timeZone,
    };
  }

  const clarification = getClarificationPrompt(text, offer);
  if (clarification) {
    return { status: 'clarify', reply: clarification, timeZone };
  }

  const items = parseItemsFromText({ text, offer, profile, patientState, timeZone });
  if (!items.length) {
    return {
      status: 'needs_timing',
      reply: buildTimingCapturePrompt({ offer, profile }),
      timeZone,
    };
  }

  return { status: 'ready', items, timeZone };
}

function getClarificationPrompt(text, offer = {}) {
  if (/\bafter (?:i )?wake|after waking|after wake up|after i wake up\b/i.test(text)) {
    return 'Sure 🌙 What time do you usually wake up, roughly? We can keep it flexible.';
  }

  if (/\bafter breakfast\b/i.test(text)) {
    return 'Got it. Around what time is breakfast usually?';
  }

  if (/\bafter lunch\b/i.test(text)) {
    return 'Got it. Around what time is lunch usually?';
  }

  if (/\bafter dinner\b/i.test(text)) {
    return 'Got it. Around what time is dinner usually?';
  }

  if (/\bmorning\b/i.test(text) && !TIME_WORDS.test(text)) {
    return 'Sure 🌤 Around what time in the morning feels realistic?';
  }

  if (/\bbefore bed|bedtime\b/i.test(text) && !TIME_WORDS.test(text)) {
    return 'Of course 🌙 What time do you usually sleep, roughly? We’ll use that as our anchor.';
  }

  if (/\bat night|night time|tonight\b/i.test(text) && !TIME_WORDS.test(text)) {
    return 'Got it. Around what time at night would feel useful: 10 PM, 11 PM, 12 AM, or something else?';
  }

  if (/\bevery few hours\b/i.test(text)) {
    return 'Nice. What window should we keep it inside? For example, 10 AM to 8 PM, so it does not poke you at odd hours.';
  }

  if (offer?.type === 'water_2_hourly' && /\bevery \d+ hours?\b/i.test(text) && !/\bfrom\b/i.test(text)) {
    return 'Nice. What window should we keep it inside? For example, 10 AM to 8 PM.';
  }

  return null;
}

function parseItemsFromText({ text, offer, profile, patientState, timeZone }) {
  if (offer?.type === 'water_2_hourly' || /\bwater|hydration\b/i.test(text)) {
    const waterItems = parseWaterItems({ text, offer, timeZone });
    if (waterItems.length) return waterItems;
  }

  const segments = text
    .replace(/\band\b/gi, ',')
    .split(/[,;]+/)
    .map(segment => segment.trim())
    .filter(Boolean);

  const items = [];
  for (const segment of segments) {
    const kind = inferItemKind(segment, offer);
    if (!kind) continue;
    const parsedTime = parseClockTime(segment, kind, timeZone);
    if (!parsedTime) continue;
    items.push(buildScheduleItem({
      kind,
      scheduledFor: parsedTime,
      offer,
      profile,
      patientState,
      sourceText: segment,
      timeZone,
    }));
  }

  if (!items.length && CHECKIN_WORDS.test(text)) {
    const parsedTime = parseClockTime(text, 'sleep_checkin', timeZone);
    if (parsedTime) {
      items.push(buildScheduleItem({
        kind: 'sleep_checkin',
        scheduledFor: parsedTime,
        offer,
        profile,
        patientState,
        sourceText: text,
        timeZone,
      }));
    }
  }

  return dedupeItems(items);
}

function parseWaterItems({ text, offer, timeZone }) {
  const range = text.match(/\bfrom\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to|-)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!range) return [];

  const everyMatch = text.match(/\bevery\s+(\d+)\s*hours?\b/i);
  const intervalHours = Number(everyMatch?.[1] || 2);
  const start = normalizeClock({
    hour: Number(range[1]),
    minute: Number(range[2] || 0),
    ampm: range[3] || 'am',
    context: 'water',
  });
  const end = normalizeClock({
    hour: Number(range[4]),
    minute: Number(range[5] || 0),
    ampm: range[6] || (Number(range[4]) <= 8 ? 'pm' : 'am'),
    context: 'water',
  });

  const avoidWindow = parseAvoidWindow(text);
  const activeWindow = {
    start: `${String(start.hour).padStart(2, '0')}:${String(start.minute).padStart(2, '0')}`,
    end: `${String(end.hour).padStart(2, '0')}:${String(end.minute).padStart(2, '0')}`,
  };
  const items = [];
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  const intervalMinutes = Math.max(intervalHours, 1) * 60;
  const first = nextLocalTimeUtc({ timeZone, hour: start.hour, minute: start.minute });
  const baseFrom = new Date(new Date(first).getTime() - 60_000);

  for (let minutes = startMinutes; minutes <= endMinutes; minutes += intervalMinutes) {
    if (avoidWindow && isInsideWindow(minutes, avoidWindow)) continue;
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const scheduledFor = nextLocalTimeUtc({ from: baseFrom, timeZone, hour, minute });
    items.push(buildScheduleItem({
      kind: 'water_reminder',
      scheduledFor,
      offer: { ...offer, cadence: `every_${intervalHours}_hours` },
      sourceText: text,
      timeZone,
      metadata: {
        intervalHours,
        activeWindow,
        avoidWindow,
      },
    }));
  }

  return items;
}

function isInsideWindow(minutes, window) {
  if (!window) return false;
  const [startHour, startMinute] = window.start.split(':').map(Number);
  const [endHour, endMinute] = window.end.split(':').map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return minutes >= start && minutes < end;
}

function parseAvoidWindow(text) {
  const avoid = text.match(/\b(?:not|don't|dont|avoid)[^0-9]*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to|-)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!avoid) return null;
  const start = normalizeClock({ hour: Number(avoid[1]), minute: Number(avoid[2] || 0), ampm: avoid[3] || 'pm', context: 'avoid' });
  const end = normalizeClock({ hour: Number(avoid[4]), minute: Number(avoid[5] || 0), ampm: avoid[6] || 'pm', context: 'avoid' });
  return {
    start: `${String(start.hour).padStart(2, '0')}:${String(start.minute).padStart(2, '0')}`,
    end: `${String(end.hour).padStart(2, '0')}:${String(end.minute).padStart(2, '0')}`,
  };
}

function inferItemKind(segment, offer = {}) {
  if (/\bcaffeine|coffee|tea\b/i.test(segment)) return 'caffeine_reminder';
  if (/\bwind|wind-down|screen|phone|bedtime|sleep around|sleep at\b/i.test(segment)) return 'winddown_reminder';
  if (/\bwater|hydration\b/i.test(segment)) return 'water_reminder';
  if (/\bmedicine|medication|tablet|pill|prescribed\b/i.test(segment)) return 'medicine_reminder';
  if (/\bwalk|exercise|stretch|mobility|move|posture\b/i.test(segment)) return 'movement_reminder';
  if (/\bsymptom|fever|temperature|stomach|loose motion|diarrhea\b/i.test(segment)) return 'symptom_checkin';
  if (/\bpain|ache|soreness\b/i.test(segment)) return 'pain_checkin';
  if (/\bmeal|lunch|dinner|nutrition|food\b/i.test(segment)) return 'nutrition_checkin';
  if (/\bstress|breathing|calm|mindful\b/i.test(segment)) return 'stress_checkin';
  if (/\bhabit|phone|screen|craving|routine\b/i.test(segment)) return 'habit_checkin';
  if (/\brecovery|symptom|health\b/i.test(segment)) return 'recovery_checkin';
  if (CHECKIN_WORDS.test(segment)) return offer?.type === 'sleep_daily' ? 'sleep_checkin' : 'general_checkin';
  if (offer?.type === 'sleep_daily' && TIME_WORDS.test(segment)) return 'sleep_checkin';
  return null;
}

function parseClockTime(text, kind, timeZone) {
  const match = text.match(TIME_WORDS);
  if (!match) return null;
  const clock = normalizeClock({
    hour: Number(match[1]),
    minute: Number(match[2] || 0),
    ampm: match[3],
    context: kind,
  });

  return nextLocalTimeUtc({
    timeZone,
    hour: clock.hour,
    minute: clock.minute,
    forceTomorrow: /\btomorrow\b/i.test(text),
  });
}

function normalizeClock({ hour, minute = 0, ampm, context }) {
  let normalizedHour = hour;
  const marker = normalize(ampm);

  if (marker === 'pm' && normalizedHour < 12) normalizedHour += 12;
  if (marker === 'am' && normalizedHour === 12) normalizedHour = 0;

  if (!marker) {
    if (/caffeine|water|avoid/.test(context) && normalizedHour >= 1 && normalizedHour <= 8) normalizedHour += 12;
    if (/winddown|night/.test(context) && normalizedHour >= 6 && normalizedHour <= 11) normalizedHour += 12;
    if (/winddown/.test(context) && normalizedHour === 12) normalizedHour = 0;
    if (/checkin|sleep_checkin/.test(context) && normalizedHour >= 1 && normalizedHour <= 11) {
      normalizedHour = normalizedHour;
    }
  }

  return { hour: normalizedHour, minute };
}

function buildScheduleItem({ kind, scheduledFor, offer = {}, profile = {}, patientState = {}, sourceText = '', timeZone, metadata = {} }) {
  const base = itemCopy(kind, profile);
  const itemKind = kind.endsWith('_reminder') ? 'reminder' : 'checkin';
  const type = kind === 'sleep_checkin'
    ? 'sleep_daily'
    : kind === 'water_reminder'
      ? 'water_2_hourly'
      : offer.type || 'general';

  return {
    kind: itemKind,
    type,
    title: base.title,
    scheduledFor,
    timezone: timeZone,
    cadence: offer.cadence || (itemKind === 'reminder' ? 'one_time' : 'daily'),
    detailedChatMessage: base.message,
    responseOptions: itemKind === 'checkin' ? base.responseOptions : [],
    metadata: {
      ...(offer.metadata || {}),
      ...metadata,
      kind: itemKind,
      reminderType: kind,
      sourceText,
      timezone: timeZone,
      protocolDay: patientState?.current_day || 0,
    },
  };
}

function itemCopy(kind, profile = {}) {
  const name = getProfileName(profile);
  const self = isSelfProfile(profile);
  const owner = self ? 'your' : `${name}'s`;

  const copy = {
    caffeine_reminder: {
      title: 'Caffeine reminder',
      message: `Gentle caffeine reminder 🌿\n\nThis is ${owner} caffeine cutoff nudge. Keep it realistic and easy to follow.`,
    },
    winddown_reminder: {
      title: 'Wind-down reminder',
      message: `Wind-down time 🌙\n\nA gentle nudge to start the screen-free wind-down routine.`,
    },
    water_reminder: {
      title: 'Water reminder',
      message: `Water reminder 🌊\n\nA small hydration nudge. No pressure, just a gentle pause.`,
    },
    medicine_reminder: {
      title: 'Medicine reminder',
      message: self
        ? 'Medicine reminder 🌿\n\nA gentle reminder for the medicine timing you provided. Follow only the prescription or clinician instructions you already have.'
        : `Medicine reminder for ${name} 🌿\n\nA gentle reminder for the medicine timing you provided. Follow only the prescription or clinician instructions already given.`,
    },
    movement_reminder: {
      title: 'Movement reminder',
      message: `Movement reminder 🚶\n\nA gentle nudge to move, stretch, or take the planned walk.`,
    },
    symptom_checkin: {
      title: 'Symptom check-in',
      message: self
        ? 'Tiny symptom check 🙂\n\nHow are the symptoms right now?'
        : `Tiny symptom check for ${name} 🙂\n\nHow are ${name}'s symptoms right now?`,
      responseOptions: ['better', 'same', 'worse', 'faced_issue'],
    },
    pain_checkin: {
      title: 'Pain check-in',
      message: self
        ? 'Tiny pain check 🙂\n\nHow is the pain right now?'
        : `Tiny pain check for ${name} 🙂\n\nHow is ${name}'s pain right now?`,
      responseOptions: ['better', 'same', 'worse', 'faced_issue'],
    },
    nutrition_checkin: {
      title: 'Nutrition check-in',
      message: self
        ? 'Meal check, real life edition 🍽️\n\nDid the meal plan feel manageable today?'
        : `Meal check for ${name} 🍽️\n\nDid the meal plan feel manageable for ${name} today?`,
      responseOptions: ['yes', 'no', 'partially', 'faced_issue'],
    },
    stress_checkin: {
      title: 'Stress check-in',
      message: self
        ? 'Tiny stress reset check 🫶\n\nDid you try the stress-support step today?'
        : `Tiny stress reset check for ${name} 🫶\n\nDid ${name} try the stress-support step today?`,
      responseOptions: ['yes', 'no', 'partially', 'faced_issue'],
    },
    habit_checkin: {
      title: 'Habit check-in',
      message: self
        ? 'Reality check, kindly 😄\n\nWere you able to follow the habit target today?'
        : `Reality check for ${name} 😄\n\nWas ${name} able to follow the habit target today?`,
      responseOptions: ['yes', 'no', 'partially', 'faced_issue'],
    },
    recovery_checkin: {
      title: 'Recovery check-in',
      message: 'Tiny health check 🙂\n\nAre symptoms improving, the same, or worse today?',
      responseOptions: ['improving', 'same', 'worse', 'faced_issue'],
    },
    sleep_checkin: {
      title: 'Sleep check-in',
      message: self
        ? 'Morning sleep detective moment 🌙\n\nDid you follow your sleep target last night?'
        : `Sleep detective moment for ${name} 🌙\n\nDid ${name} follow the sleep target last night?`,
      responseOptions: ['yes', 'no', 'partially', 'faced_issue'],
    },
    general_checkin: {
      title: 'Wellness check-in',
      message: self
        ? 'Tiny progress ping ✨\n\nWere you able to follow the plan today?'
        : `Tiny progress ping for ${name} ✨\n\nWas ${name} able to follow the plan today?`,
      responseOptions: ['yes', 'no', 'partially', 'faced_issue'],
    },
  };

  return copy[kind] || copy.general_checkin;
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.metadata?.reminderType}:${item.scheduledFor}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSuggestedItems({ offer, profile, patientState, timeZone }) {
  if (offer?.type === 'sleep_daily') {
    return [
      buildScheduleItem({ kind: 'winddown_reminder', scheduledFor: nextLocalTimeUtc({ timeZone, hour: 23, minute: 0 }), offer, profile, patientState, sourceText: 'suggested wind-down', timeZone }),
      buildScheduleItem({ kind: 'sleep_checkin', scheduledFor: nextLocalTimeUtc({ timeZone, hour: 9, minute: 0, forceTomorrow: true }), offer, profile, patientState, sourceText: 'suggested sleep check-in', timeZone }),
    ];
  }

  if (offer?.type === 'water_2_hourly') {
    return [buildScheduleItem({
      kind: 'water_reminder',
      scheduledFor: addHoursUtc(new Date(), 2),
      offer: { ...offer, cadence: 'every_2_hours' },
      profile,
      patientState,
      sourceText: 'suggested water reminder',
      timeZone,
    })];
  }

  return [buildScheduleItem({
    kind: 'general_checkin',
    scheduledFor: nextLocalTimeUtc({ timeZone, hour: 20, minute: 0 }),
    offer,
    profile,
    patientState,
    sourceText: 'suggested check-in',
    timeZone,
  })];
}

function buildSuggestionReply(items, timeZone) {
  const lines = items.map(item => `- **${item.title.toLowerCase()}**: ${formatScheduleTime(item.scheduledFor, timeZone)}`);
  return `Based on what you told me, we could start with:\n\n${lines.join('\n')}\n\nDo these feel realistic, or should we shift them around?`;
}

export function buildScheduleConfirmation({ records, profile } = {}) {
  const timeZone = records?.[0]?.metadata?.timezone || records?.[0]?.timezone;
  const lines = (records || [])
    .map(record => `- **${String(record.title || 'Reminder').toLowerCase()}**: ${formatScheduleTime(record.scheduledFor, timeZone)}`);
  const name = getFriendlyName(profile);
  const owner = routineOwner(profile);
  const doneLead = isSelfProfile(profile) && name ? `Done, ${name}` : 'Done';

  const intro = lines.length === 1
    ? `${doneLead} 🌿 We’ve got this set around ${owner}.`
    : `${doneLead} 🌿 We’ve got these set around ${owner}:`;

  return `${intro}\n\n${lines.join('\n')}\n\nWhen each one is due, it’ll show up here in the app.`;
}

export function formatScheduleTime(value, timeZone) {
  return formatInTimeZone(value, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
