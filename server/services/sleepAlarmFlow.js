/**
 * sleepAlarmFlow.js — deterministic bedtime/wake-up alarm handling.
 *
 * Pure functions (no DB, no LLM) so the routing and time-parsing logic is
 * unit-testable in isolation. profile.js wires these into the chat route:
 *
 *   Turn 1  user: "yes go ahead with the alarms"   → detect setup, no times yet
 *           → persist pending { type:'sleep_alarm_setup' }, ask for two times
 *   Turn 2  user: "10 PM 6 AM it works"             → parse the pair
 *           → buildSleepAlarmOffers() → createScheduledItemsFromOffers()
 *
 * A successful creation produces two scheduled_checkins rows with
 * metadata.kind = "reminder", cadence = "recurring", a daily cron, and the
 * next occurrence in UTC. Confirmation copy is only emitted AFTER the DB write.
 */

import { nextLocalTimeUtc, resolveTimeZone, DEFAULT_TIME_ZONE } from './timeService.js';

// ── Detection ───────────────────────────────────────────────────

const ALARM_WORD = /\balarms?\b/i;
const BEDTIME_ALARM = /\b(?:bed\s?-?time|lights?\s?-?\s?out|sleep|night)\s+alarms?\b/i;
const WAKEUP_ALARM = /\b(?:wake\s?-?\s?up|morning|get\s?-?up)\s+alarms?\b/i;

// Verbs/affirmations that turn an alarm mention into a setup request.
const SETUP_CUES = /\b(?:set|create|add|schedule|keep|make|put|go\s+ahead|do\s+it|yes|yeah|yep|sure|ok|okay|please|confirm|sounds?\s+good|works?)\b/i;

/**
 * Does this message look like the user wants us to set up alarm(s)?
 * Intentionally broad — false positives are cheap because the caller only
 * uses this to route into the deterministic handler (which never fabricates
 * a confirmation), not to write to the DB.
 *
 * @param {string} message
 * @returns {{ isAlarmSetup: boolean, sleepContext: boolean }}
 */
export function detectAlarmSetupIntent(message) {
  const text = String(message || '');
  const mentionsAlarm = ALARM_WORD.test(text) || BEDTIME_ALARM.test(text) || WAKEUP_ALARM.test(text);
  if (!mentionsAlarm) return { isAlarmSetup: false, sleepContext: false };

  const sleepContext =
    BEDTIME_ALARM.test(text) ||
    WAKEUP_ALARM.test(text) ||
    /\b(?:sleep|bed|wake|bedtime|wake[-\s]?up)\b/i.test(text);

  // A named bedtime/wake-up alarm is itself a setup request; otherwise we need
  // a setup cue ("set", "go ahead", "keep these", "yes", …).
  const isAlarmSetup =
    BEDTIME_ALARM.test(text) || WAKEUP_ALARM.test(text) || SETUP_CUES.test(text);

  return { isAlarmSetup, sleepContext };
}

// ── Time parsing ────────────────────────────────────────────────

// Matches "10 PM", "10pm", "10:30 PM", "6 AM", "06:00", "22:00", and bare "10".
const TIME_TOKEN = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?\b/gi;

function normalizeMeridiem(raw) {
  if (!raw) return null;
  return /p/i.test(raw) ? 'pm' : 'am';
}

/**
 * Resolve one token into a 24h {hour, minute}, using a position hint for the
 * classic bare-number case ("10 6" → bedtime 22:00, wake-up 06:00).
 */
function resolveTime({ hour, minute, meridiem, hint }) {
  let h = hour;
  if (meridiem === 'pm') {
    if (h < 12) h += 12;
  } else if (meridiem === 'am') {
    if (h === 12) h = 0;
  } else {
    // No meridiem. Keep an explicit 24h value (0, or 13–23) as-is. For an
    // ambiguous 1–11 with no minutes, lean on the bedtime/wake-up hint.
    if (h >= 1 && h <= 11) {
      if (hint === 'bedtime') h += 12; // evening
      // hint 'wakeup' or none → keep morning hour as-is
    }
  }
  if (h < 0 || h > 23 || minute < 0 || minute > 59) return null;
  return { hour: h, minute };
}

/**
 * Extract raw, un-hinted time tokens from a message, in order of appearance.
 * @param {string} message
 * @returns {Array<{hour:number, minute:number, meridiem:?string}>}
 */
export function parseTimeTokens(message) {
  const text = String(message || '');
  const tokens = [];
  let m;
  TIME_TOKEN.lastIndex = 0;
  while ((m = TIME_TOKEN.exec(text)) !== null) {
    const hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const meridiem = normalizeMeridiem(m[3]);
    // Skip implausible bare numbers (e.g. "30 days" → 30 is out of range). A
    // bare "0" with no colon/meridiem is almost never a time here.
    if (hour > 23) continue;
    if (hour === 0 && !m[2] && !meridiem) continue;
    tokens.push({ hour, minute, meridiem });
  }
  return tokens;
}

/**
 * Parse up to two times from a message, in order of appearance.
 * The first maps to bedtime, the second to wake-up. (Convenience wrapper.)
 *
 * @param {string} message
 * @returns {{ bedtime: ?{hour,minute}, wakeup: ?{hour,minute}, count: number }}
 */
export function parseTwoTimes(message) {
  const tokens = parseTimeTokens(message);
  const bedtime = tokens[0] ? resolveTime({ ...tokens[0], hint: 'bedtime' }) : null;
  const wakeup = tokens[1] ? resolveTime({ ...tokens[1], hint: 'wakeup' }) : null;
  return { bedtime, wakeup, count: [bedtime, wakeup].filter(Boolean).length };
}

const WAKE_HINT = /\b(?:wake|morning|get\s?-?up|alarm\s+to\s+wake)\b/i;
const BED_HINT = /\b(?:bed|sleep|lights?-?out|night|bedtime)\b/i;

/**
 * Full deterministic plan from a free-text message: tokenize, label each time
 * (bedtime vs wake-up), and build ready-to-insert offers.
 *
 * - Two+ times  → first is bedtime, second is wake-up.
 * - One time    → labelled by keyword ("wake-up alarm at 6am" → wake-up),
 *                 defaulting to bedtime when ambiguous.
 *
 * @param {object} params
 * @param {string} params.message
 * @param {string} [params.timezone]
 * @param {Date}   [params.from]
 * @returns {{ offers: object[], bedtime: ?object, wakeup: ?object, count: number }}
 */
export function planSleepAlarms({ message, timezone, from = new Date() } = {}) {
  const tokens = parseTimeTokens(message);
  if (tokens.length === 0) return { offers: [], bedtime: null, wakeup: null, count: 0 };

  let bedtime = null;
  let wakeup = null;

  if (tokens.length >= 2) {
    bedtime = resolveTime({ ...tokens[0], hint: 'bedtime' });
    wakeup = resolveTime({ ...tokens[1], hint: 'wakeup' });
  } else {
    const wantsWake = WAKE_HINT.test(message) && !BED_HINT.test(message);
    if (wantsWake) {
      wakeup = resolveTime({ ...tokens[0], hint: 'wakeup' });
    } else {
      bedtime = resolveTime({ ...tokens[0], hint: 'bedtime' });
    }
  }

  const offers = buildSleepAlarmOffers({ timezone, bedtime, wakeup, from });
  return { offers, bedtime, wakeup, count: offers.length };
}

// ── Offer building ──────────────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0');
}

function makeAlarmOffer({ tz, time, title, reminderType, from }) {
  const scheduledFor = nextLocalTimeUtc({ from, timeZone: tz, hour: time.hour, minute: time.minute });
  return {
    kind: 'reminder',
    cadence: 'recurring',
    title,
    scheduledFor,
    responseOptions: [],
    metadata: {
      kind: 'reminder',
      cadence: 'recurring',
      timezone: tz,
      // Daily at the resolved local hour/minute.
      cron: `${time.minute} ${time.hour} * * *`,
      reminderType,
      skipAutoFollowup: true,
      localTime: `${pad2(time.hour)}:${pad2(time.minute)}`,
    },
  };
}

/**
 * Build offer objects (the shape consumed by buildScheduledCheckin /
 * createScheduledItemsFromOffers) for a bedtime + wake-up alarm pair.
 *
 * @param {object} params
 * @param {string} [params.timezone]
 * @param {?{hour,minute}} params.bedtime
 * @param {?{hour,minute}} params.wakeup
 * @param {Date} [params.from]
 * @returns {Array<object>} offers (0, 1, or 2)
 */
export function buildSleepAlarmOffers({ timezone, bedtime, wakeup, from = new Date() } = {}) {
  const tz = resolveTimeZone(timezone || DEFAULT_TIME_ZONE);
  const offers = [];
  if (bedtime) {
    offers.push(makeAlarmOffer({ tz, time: bedtime, title: 'Bedtime alarm', reminderType: 'sleep', from }));
  }
  if (wakeup) {
    offers.push(makeAlarmOffer({ tz, time: wakeup, title: 'Wake-up alarm', reminderType: 'wake', from }));
  }
  return offers;
}

/**
 * Human-readable "10:00 PM" for confirmation copy.
 */
export function formatLocalClock({ hour, minute }) {
  const mer = hour >= 12 ? 'PM' : 'AM';
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${pad2(minute)} ${mer}`;
}
