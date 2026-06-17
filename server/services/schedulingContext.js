/**
 * Detects when a conversation is *about scheduling* even though the user's
 * message uses no explicit "remind me" phrasing.
 *
 * The model frequently proposes reminders/times during coaching (a wind-down
 * time, a "Reminder summary" table) and then treats a casual "yes" or a bare
 * time as confirmation. Those turns must reach the structured tool orchestrator
 * (so a real row is written) instead of the free LLM (which fabricates a
 * confirmation). This module provides pure, testable detection for that.
 */

const TIME_TOKEN =
  /\b\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\bat\s+\d{1,2}\b/i;

const SCHEDULE_WORD =
  /\b(reminder|check[-\s]?in|wind[-\s]?down|bed\s?time|wake[-\s]?up|schedule|nudge|alarm|routine)\b/i;

const AFFIRMATION =
  /^(?:\s*(?:yes|yeah|yep|yup|sure|ok|okay|correct|right|perfect|confirm(?:ed)?|sounds?\s+good|that\s+works|go\s+ahead|do\s+it|all\s+good|looks?\s+good))\b/i;

/** True when the previous assistant turn proposed a schedule with a concrete time. */
export function assistantProposedSchedule(lastAssistantContent = '') {
  const text = String(lastAssistantContent || '');
  return SCHEDULE_WORD.test(text) && TIME_TOKEN.test(text);
}

/** True when the user's message contains a clock time. */
export function messageHasTime(message = '') {
  return TIME_TOKEN.test(String(message || ''));
}

/** True when the user's message opens with an affirmation ("yes", "sounds good"…). */
export function messageIsAffirmation(message = '') {
  return AFFIRMATION.test(String(message || '').trim());
}

/**
 * The combined signal used for routing. A conversational scheduling turn is one
 * where the assistant just proposed a schedule AND the user responded with a
 * time or an affirmation — i.e. they're accepting/specifying a reminder without
 * ever saying "remind me".
 */
export function detectConversationalSchedulingTurn({ message = '', history = [] } = {}) {
  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
  if (!assistantProposedSchedule(lastAssistant)) return false;
  return messageHasTime(message) || messageIsAffirmation(message);
}
