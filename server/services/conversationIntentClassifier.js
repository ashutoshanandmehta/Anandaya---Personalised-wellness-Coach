/**
 * Conversation Intent Classifier
 *
 * Deterministic, regex-based classifier that runs BEFORE the scheduling flow
 * or LLM to decide what the user is actually doing. Prevents the assistant
 * from getting stuck in scheduling mode when the user asks a question,
 * expresses confusion, or changes direction.
 *
 * Runs in <1ms — safe for every message.
 */

import { resolveTimeZone } from './timeService.js';

// ── Intent types ────────────────────────────────────────────────
export const INTENTS = Object.freeze({
  DIRECT_REMINDER:       'direct_reminder',
  TIMING_RESPONSE:       'timing_response',
  CLARIFICATION:         'clarification_question',
  CONFUSION:             'confusion',
  PLAN_CHANGE:           'plan_change',
  DELEGATE_CHOICE:       'delegate_choice',
  CANCEL_FLOW:           'cancel_flow',
  REMINDER_FAILURE:      'reminder_failure',
  REMINDER_STATUS:       'reminder_status',
  REMINDER_UPDATE:       'reminder_update',
  SCHEDULE_ACCEPTANCE:   'schedule_acceptance',
  GENERAL_CHAT:          'general_chat',
});

// ── Patterns ────────────────────────────────────────────────────

const DIRECT_REMINDER_PATTERNS = [
  /\bremind\s+me\s+to\b/i,
  /\bset\s+(?:a\s+)?(?:reminder|alarm)\s+(?:to|for)\b/i,
  /\bset\s+(?:a\s+)?(?:reminder|alarm)\s+(?:at|in|after|tomorrow|tonight)\b/i,
  /\breminder\s+(?:to|for)\b/i,
  /\bremind\s+me\s+(?:at|in|after|tomorrow|tonight)\b/i,
];

const RELATIVE_TIME = /\b(?:in|after)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)\b/i;
const ABSOLUTE_TIME = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const HAS_TIME = /(?:\b(?:in|after)\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b)/i;

const CLARIFICATION_PATTERNS = [
  /\bwhat\s+(?:is|are|does|do)\b/i,
  /\bwhat(?:'|')s\b/i,
  /\bhow\s+(?:does|do|will|would|can|should)\b/i,
  /\bwhy\s+(?:do|does|should|would|is|are)\b/i,
  /\bcan\s+you\s+explain\b/i,
  /\bwhat\s+do\s+you\s+mean\b/i,
  /\bmeaning\s+of\b/i,
  /\bwhat\s+happens\b/i,
  /\btell\s+me\s+(?:more\s+)?about\b/i,
];

const CONFUSION_PATTERNS = [
  /^\s*\?{1,}\s*$/,                            // just "?" or "??"
  /^\s*(?:huh|what|hm+|um+|eh)\s*\?*\s*$/i,   // "huh?", "what?", "hmm"
  /\bi\s+don(?:'|')t\s+(?:understand|get\s+it)\b/i,
  /\btoo\s+(?:complicated|confusing|much)\b/i,
  /\bwhat\s+(?:are\s+you|do\s+you)\s+(?:asking|saying|talking\s+about)\b/i,
  /^\s*(?:confused|lost)\s*\.?\s*$/i,
  /\bi(?:'|')m\s+(?:confused|lost)\b/i,
];

const PLAN_CHANGE_PATTERNS = [
  /\b(?:leave|skip|forget|drop|stop|cancel|ignore)\s+(?:the\s+)?(?:sleep|water|hydration|exercise|nutrition|habit|screen|stress|walking|stretching|meditation)\b/i,
  /\b(?:instead|rather|switch\s+to|change\s+to|let(?:'|')s\s+do)\b/i,
  /\bdon(?:'|')t\s+(?:do|set|schedule|want)\s+(?:the\s+)?(?:sleep|water|exercise|habit|that)\b/i,
  /\b(?:never\s*mind|forget\s+(?:about\s+)?(?:it|that|this))\b.*\b(?:remind|set|schedule|help)\b/i,
];

const CANCEL_PATTERNS = [
  /^\s*(?:no|nope|nah|stop|cancel|don(?:'|')t|nevermind|never\s*mind)\s*\.?\s*$/i,
  /\bdon(?:'|')t\s+(?:do|set|schedule|want)\s+(?:this|that|it|any(?:thing)?)\b/i,
  /\bcancel\s+(?:this|that|it|the\s+(?:reminder|schedule|check-?in))\b/i,
  /\bstop\s+(?:this|that|it|asking|scheduling)\b/i,
  /\bno\s+(?:thanks|thank\s+you|reminders?|check-?ins?|schedule)\b/i,
  /\bforget\s+(?:it|this|that|about\s+it)\s*\.?\s*$/i,
];

const DELEGATE_PATTERNS = [
  /\byou\s+(?:decide|choose|pick|suggest|tell\s+me)\b/i,
  /\bwhatever\s+(?:works|you\s+think|is\s+best)\b/i,
  /\bnot\s+sure\b/i,
  /\bsuggest\s+(?:a\s+)?(?:time|schedule|something)\b/i,
  /\brecommend\b/i,
  /\byou\s+tell\s+me\b/i,
  /\bi\s+don(?:'|')t\s+know\s+(?:what|when)\b/i,
  /\bup\s+to\s+you\b/i,
];

const REMINDER_FAILURE_PATTERNS = [
  /\bdidn(?:'|')t\s+(?:get|receive|see|hear)\s+(?:a\s+|any\s+|the\s+)?(?:reminder|notification|alert|nudge)\b/i,
  /\bno\s+(?:reminder|notification|alert)\s+(?:came|arrived|showed|appeared)\b/i,
  /\b(?:reminder|notification)\s+(?:didn(?:'|')t|did\s+not|never)\s+(?:come|arrive|show|appear|work|fire)\b/i,
  /\b(?:still\s+)?waiting\s+for\s+(?:the\s+)?(?:reminder|notification)\b/i,
  /\b\d+\s*(?:minutes?|mins?|hours?)\s+(?:passed|over|gone|ago)\b.*\b(?:no|didn(?:'|')t|not|never)\b/i,
  /\bmissed\s+(?:the\s+)?reminder\b/i,
  /\breminder\s+(?:is\s+)?(?:not\s+working|broken|failed)\b/i,
];

const REMINDER_STATUS_PATTERNS = [
  /\b(?:is|are)\s+there\s+any\s+(?:active\s+)?(?:reminders?|check-?ins?|notifications?)\s+(?:set|scheduled|active)?\b/i,
  /\b(?:what|which|show|list|tell\s+me|check|see)\s+(?:are\s+)?(?:my\s+|the\s+|active\s+)?(?:reminders?|check-?ins?|notifications?|schedule)\b/i,
  /\b(?:do\s+i\s+have|have\s+we\s+set|check\s+if\s+i\s+have|check\s+for\s+any)\s+(?:any\s+)?(?:reminders?|check-?ins?|notifications?)\b/i,
  /\b(?:did\s+you|have\s+you)\s+(?:set|schedule|scheduled)\s+(?:the\s+|a\s+|any\s+)?(?:reminder|check-?in|notification)\b/i,
  /\b(?:reminders?|check-?ins?|notifications?)\s+(?:set|scheduled|active|pending)\s*\??\s*$/i,
  /\bwhat(?:'|')?s\s+(?:on\s+)?(?:my\s+|the\s+)?schedule\b/i,
];

const REMINDER_UPDATE_PATTERNS = [
  /\b(?:rewrite|correct|fix|update|change|edit)\s+(?:it|that|the\s+(?:reminder|task|title))\b/i,
  /\b(?:it's|it is|should be|make it)\s+.+?\s+(?:not|instead of)\s+.+/i,
  /\bchange\s+.+?\s+to\s+.+/i,
  /\bnot\s+.+?,?\s+(?:it'?s|it is|make it|use)\s+.+/i,
];

const SCHEDULE_ACCEPTANCE_PATTERNS = [
  /\b(?:yes|yeah|yep|ok|okay|sure|please|absolutely|definitely|go\s+ahead)\b/i,
];

const SCHEDULE_ACCEPTANCE_BOOSTERS = [
  /\bschedule\b/i,
  /\bset\s+it\b/i,
  /\bdo\s+it\b/i,
  /\bgo\s+ahead\b/i,
  /\bsounds?\s+good\b/i,
  /\blooks?\s+good\b/i,
  /\bworks?\s+for\s+me\b/i,
  /\bthat(?:'|')s?\s+(?:fine|good|great|perfect)\b/i,
  /\bconfirm\b/i,
];

const TIMING_PATTERNS = [
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
  /\bevery\s+(?:day|morning|evening|night|\d+\s*hours?)\b/i,
  /\bdaily\b/i,
  /\b(?:morning|afternoon|evening|tonight|tomorrow)\b/i,
  /\bbefore\s+(?:bed|sleep|i\s+sleep)\b/i,
  /\bafter\s+(?:dinner|lunch|breakfast|waking|i\s+wake)\b/i,
  /\b(?:in|after)\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\b/i,
];

// ── Classifier ──────────────────────────────────────────────────

/**
 * Classify a user message into an intent.
 *
 * @param {object} params
 * @param {string} params.message            — The user's raw message
 * @param {boolean} params.hasPendingOffer    — Whether a scheduling offer is pending
 * @param {object}  [params.pendingOffer]     — The pending offer object (if any)
 * @param {object}  [params.patientState]     — Current patient state
 * @returns {{ intent: string, confidence: number, metadata: object }}
 */
export function classifyIntent({ message, hasPendingOffer = false, pendingOffer = null, patientState = null }) {
  const text = (message || '').trim();
  if (!text) return result(INTENTS.GENERAL_CHAT, 0.5);

  const lower = text.toLowerCase();

  // ── 1. Confusion (highest priority — short, lost messages) ─────
  if (CONFUSION_PATTERNS.some(p => p.test(text))) {
    return result(INTENTS.CONFUSION, 0.95);
  }

  // ── 2. Reminder failure report ─────────────────────────────────
  if (REMINDER_FAILURE_PATTERNS.some(p => p.test(text))) {
    return result(INTENTS.REMINDER_FAILURE, 0.95);
  }

  // ── 2c. Correction to latest active reminder ───────────────────
  if (REMINDER_UPDATE_PATTERNS.some(p => p.test(text))) {
    return result(INTENTS.REMINDER_UPDATE, 0.9, parseReminderCorrection(text));
  }

  // ── 2d. Reminder/check-in status questions ─────────────────────
  if (REMINDER_STATUS_PATTERNS.some(p => p.test(text))) {
    return result(INTENTS.REMINDER_STATUS, 0.95);
  }

  // ── 3. Cancel flow ─────────────────────────────────────────────
  // Only if a pending offer exists, otherwise "no" might be an answer to something else
  if (hasPendingOffer && CANCEL_PATTERNS.some(p => p.test(text))) {
    return result(INTENTS.CANCEL_FLOW, 0.9);
  }

  // ── 4. Direct reminder (clear task + time) ─────────────────────
  const directReminder = checkDirectReminder(text);
  if (directReminder) {
    return result(INTENTS.DIRECT_REMINDER, 0.95, directReminder);
  }

  // ── 5. Plan change (mid-flow direction switch) ─────────────────
  if (hasPendingOffer && PLAN_CHANGE_PATTERNS.some(p => p.test(text))) {
    // Check if the plan change also contains a new direct reminder
    const embedded = checkDirectReminder(text.replace(/^.*?(?:instead|rather|,)\s*/i, ''));
    return result(INTENTS.PLAN_CHANGE, 0.9, { embeddedReminder: embedded });
  }

  // ── 6. Clarification question ──────────────────────────────────
  if (CLARIFICATION_PATTERNS.some(p => p.test(text))) {
    // Don't classify as clarification if message also has clear timing
    if (!HAS_TIME.test(text)) {
      return result(INTENTS.CLARIFICATION, 0.9);
    }
  }

  // ── 7. Delegate choice ("you decide") ──────────────────────────
  if (DELEGATE_PATTERNS.some(p => p.test(text))) {
    return result(INTENTS.DELEGATE_CHOICE, 0.9);
  }

  // ── 8. Schedule acceptance ("yes, schedule it") ────────────────
  if (hasPendingOffer) {
    const isAcceptance = SCHEDULE_ACCEPTANCE_PATTERNS.some(p => p.test(text));
    const hasBoosters = SCHEDULE_ACCEPTANCE_BOOSTERS.some(p => p.test(text));
    const isShort = text.split(/\s+/).length <= 6;

    if (isAcceptance && (hasBoosters || isShort)) {
      // Check if they also provided timing
      const hasTiming = HAS_TIME.test(text);
      return result(INTENTS.SCHEDULE_ACCEPTANCE, 0.9, { hasTiming });
    }
  }

  // ── 9. Timing response (during scheduling) ────────────────────
  if (hasPendingOffer && TIMING_PATTERNS.some(p => p.test(text))) {
    return result(INTENTS.TIMING_RESPONSE, 0.85);
  }

  // ── 10. Standalone cancel (not during a pending offer) ─────────
  if (!hasPendingOffer && CANCEL_PATTERNS.some(p => p.test(text))) {
    // Just "no" or "stop" without any context — treat as general chat
    return result(INTENTS.GENERAL_CHAT, 0.5);
  }

  // ── 11. Default to general chat ────────────────────────────────
  return result(INTENTS.GENERAL_CHAT, 0.5);
}

// ── Helpers ──────────────────────────────────────────────────────

function result(intent, confidence, metadata = {}) {
  return { intent, confidence, metadata };
}

function parseReminderCorrection(text) {
  const raw = String(text || '').trim();
  const normalized = raw.replace(/\s+/g, ' ');

  const itsNot = normalized.match(/\b(?:it's|it is|should be|make it)\s+["']?(.+?)["']?\s+(?:not|instead of)\s+["']?(.+?)["']?\.?$/i);
  if (itsNot) {
    return {
      newText: cleanCorrectionText(itsNot[1]),
      oldText: cleanCorrectionText(itsNot[2]),
    };
  }

  const changeTo = normalized.match(/\bchange\s+["']?(.+?)["']?\s+to\s+["']?(.+?)["']?\.?$/i);
  if (changeTo) {
    return {
      oldText: cleanCorrectionText(changeTo[1]),
      newText: cleanCorrectionText(changeTo[2]),
    };
  }

  const rewriteIts = normalized.match(/\b(?:rewrite|correct|fix|update|edit)\s+(?:it|that|the\s+(?:reminder|task|title))[^,.;:]*[,.;:]?\s*(?:it's|it is|to|as)\s+["']?(.+?)["']?(?:\s+not\s+["']?(.+?)["']?)?\.?$/i);
  if (rewriteIts) {
    return {
      newText: cleanCorrectionText(rewriteIts[1]),
      oldText: cleanCorrectionText(rewriteIts[2]),
    };
  }

  const notBut = normalized.match(/\bnot\s+["']?(.+?)["']?,?\s+(?:it's|it is|make it|use)\s+["']?(.+?)["']?\.?$/i);
  if (notBut) {
    return {
      oldText: cleanCorrectionText(notBut[1]),
      newText: cleanCorrectionText(notBut[2]),
    };
  }

  return { rawCorrection: raw };
}

function cleanCorrectionText(value = '') {
  return String(value || '')
    .replace(/^the\s+/i, '')
    .replace(/\b(?:please|pls)\b/gi, '')
    .replace(/[.。]+$/g, '')
    .trim();
}

/**
 * Check if message is a clear direct reminder request with identifiable task + time.
 * Returns metadata with parsed task/time or null if not a direct reminder.
 */
function checkDirectReminder(text) {
  if (!DIRECT_REMINDER_PATTERNS.some(p => p.test(text))) return null;

  // Must have some form of time reference
  const hasRelativeTime = RELATIVE_TIME.test(text);
  const hasAbsoluteTime = ABSOLUTE_TIME.test(text);
  if (!hasRelativeTime && !hasAbsoluteTime) return null;

  // Extract task — everything between "remind me to" and the time reference
  let task = null;
  const taskMatch = text.match(/\bremind\s+me\s+to\s+(.+?)(?:\s+(?:in|after|at|tomorrow|tonight)\b)/i);
  if (taskMatch) {
    task = taskMatch[1].trim();
  } else {
    const setAfterTimeMatch = text.match(/\bset\s+(?:a\s+)?(?:reminder|alarm)\b.*?\b(?:for|to)\s+(.+?)\s*$/i);
    if (setAfterTimeMatch) {
      task = setAfterTimeMatch[1]
        .replace(/\b(?:tomorrow|today|tonight)\b/gi, '')
        .replace(/\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, '')
        .replace(/\b(?:in|after)\s+\d+\s*(?:minutes?|mins?|hours?|hrs?|seconds?|secs?)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Try: "remind me to drink water" (task is everything after "remind me to")
    const simpleMatch = text.match(/\bremind\s+me\s+to\s+(.+)/i);
    if (!task && simpleMatch) {
      // Remove time portion from end
      task = simpleMatch[1]
        .replace(/\b(?:in|after)\s+\d+\s*(?:minutes?|mins?|hours?|hrs?|seconds?|secs?)\b.*$/i, '')
        .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b.*$/i, '')
        .replace(/\btomorrow\b.*$/i, '')
        .replace(/\btonight\b.*$/i, '')
        .trim();
    }
  }

  // Extract time
  let timeType = null;
  let timeValue = null;

  if (hasRelativeTime) {
    const match = text.match(RELATIVE_TIME);
    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    let ms = 0;
    if (/^(minutes?|mins?)$/.test(unit)) ms = amount * 60 * 1000;
    else if (/^(hours?|hrs?)$/.test(unit)) ms = amount * 60 * 60 * 1000;
    else if (/^(seconds?|secs?)$/.test(unit)) ms = amount * 1000;
    timeType = 'relative';
    timeValue = { amount, unit, ms };
  } else if (hasAbsoluteTime) {
    const match = text.match(ABSOLUTE_TIME);
    let hour = parseInt(match[1], 10);
    const minute = parseInt(match[2] || '0', 10);
    const ampm = match[3].toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    timeType = 'absolute';
    timeValue = { hour, minute };
  }

  if (!task && !timeValue) return null;

  return {
    task: task || 'your reminder',
    timeType,
    timeValue,
    isForceTomorrow: /\btomorrow\b/i.test(text),
  };
}

/**
 * Build a simplified "confusion" response that doesn't repeat the original prompt.
 */
export function buildConfusionResponse(pendingOffer) {
  if (!pendingOffer) {
    return "Sorry, I made that sound clunky. What's been on your mind? You can say it simply, and we'll sort it together.";
  }

  const title = pendingOffer.title || 'reminder';
  return `Sorry, I made that harder than it needed to be. Let's keep it to one thing for now: when should the ${title.toLowerCase()} fit into your day? You can say something like "8 PM" or "after dinner."`;
}

/**
 * Build a response for when the user cancels a flow.
 */
export function buildCancelResponse() {
  return "No problem at all. We can skip that. What should we focus on instead?";
}
