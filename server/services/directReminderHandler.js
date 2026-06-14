/**
 * Direct Reminder Handler
 *
 * Fast path for clear, unambiguous one-shot reminders.
 * Bypasses the multi-step offer→accept→timing flow entirely.
 *
 * Flow:
 *   1. Resolve time using server clock
 *   2. Build scheduled record
 *   3. Insert into DB
 *   4. Return success/failure with exact resolved time
 *   5. Build honest confirmation message
 */

import { v4 as uuidv4 } from 'uuid';
import {
  resolveTimeZone,
  nextLocalTimeUtc,
  formatInTimeZone,
  addHoursUtc,
} from './timeService.js';
import { createScheduledItem, getRecentReminderRows } from './reminderToolService.js';

/**
 * Handle a direct reminder request end-to-end.
 *
 * @param {object} params
 * @param {object} params.db              — SQLite database handle
 * @param {string} params.userId          — Current user ID
 * @param {object} params.profile         — Profile row from DB
 * @param {object} params.reminderMeta    — Parsed metadata from intent classifier
 *   { task, timeType, timeValue, isForceTomorrow }
 * @param {string} params.originalMessage — Raw user message
 * @param {string} [params.conversationId] — Conversation ID for message insertion
 * @returns {Promise<{ success: boolean, record?: object, confirmationMessage: string, dueAt?: string, error?: string }>}
 */
export async function handleDirectReminder({
  db,
  userId,
  profile,
  reminderMeta,
  originalMessage,
  conversationId,
}) {
  const timeZone = resolveTimeZone(profile?.timezone);
  const now = new Date();

  // ── 1. Resolve due_at using server clock ──────────────────────
  let dueAt;
  try {
    dueAt = resolveReminderTime({
      timeType: reminderMeta.timeType,
      timeValue: reminderMeta.timeValue,
      isForceTomorrow: reminderMeta.isForceTomorrow,
      timeZone,
      now,
    });
  } catch (err) {
    return {
      success: false,
      confirmationMessage: `I couldn't set that reminder: ${err.message}. Could you try again with a different time?`,
      error: err.message,
    };
  }

  // ── 2. Check if time is in the past ───────────────────────────
  const dueDate = new Date(dueAt);
  if (dueDate <= now) {
    const formattedTime = formatTimeForUser(dueAt, timeZone);
    return {
      success: false,
      confirmationMessage: `${formattedTime} has already passed. Should I set it for tomorrow instead?`,
      error: 'time_in_past',
      dueAt,
      metadata: { suggestedTomorrow: true },
    };
  }

  // ── 3. Build the record ───────────────────────────────────────
  const task = capitalizeFirst(reminderMeta.task || 'your reminder');
  const isSelf = isSelfProfile(profile);
  const record = {
    id: uuidv4(),
    userId,
    profileId: profile.id,
    goalId: null,
    relation: isSelf ? 'self' : 'other',
    type: inferReminderType(reminderMeta.task),
    status: 'scheduled',
    scheduledFor: dueAt,
    title: task,
    pushTitle: `${task} 🌿`,
    pushBody: 'Tap to view this gentle reminder.',
    inAppTitle: `${task} scheduled 🌿`,
    inAppBody: `Scheduled for ${formatTimeForUser(dueAt, timeZone)}.`,
    detailedChatMessage: buildReminderChatMessage(task, isSelf),
    responseOptions: [],
    metadata: {
      kind: 'reminder',
      reminderType: inferReminderType(reminderMeta.task),
      cadence: 'one_time',
      timezone: timeZone,
      sourceText: originalMessage,
      createdAt: now.toISOString(),
      directReminder: true,
    },
  };

  // ── 4. Insert into DB ─────────────────────────────────────────
  try {
    await createScheduledItem(db, record);
  } catch (err) {
    console.error('[DirectReminder] DB insert failed:', err.message);
    return {
      success: false,
      confirmationMessage: "I couldn't save that reminder right now. Please try again in a moment.",
      error: 'db_insert_failed',
    };
  }

  // ── 5. Build honest confirmation ──────────────────────────────
  const formattedTime = formatTimeForUser(dueAt, timeZone);
  const confirmationMessage = buildHonestConfirmation({
    task: reminderMeta.task,
    formattedTime,
    dueAt,
    isSelf,
  });

  return {
    success: true,
    record,
    confirmationMessage,
    dueAt,
  };
}

// ── Time resolution ─────────────────────────────────────────────

function resolveReminderTime({ timeType, timeValue, isForceTomorrow, timeZone, now }) {
  if (timeType === 'relative') {
    if (!timeValue?.ms || timeValue.ms <= 0) {
      throw new Error('the time amount needs to be more than zero');
    }
    // Relative time: add offset to current server time
    return new Date(now.getTime() + timeValue.ms).toISOString();
  }

  if (timeType === 'absolute') {
    return nextLocalTimeUtc({
      from: now,
      timeZone,
      hour: timeValue.hour,
      minute: timeValue.minute || 0,
      forceTomorrow: isForceTomorrow,
    });
  }

  throw new Error("I couldn't understand the time");
}

// ── Confirmation message ────────────────────────────────────────

function buildHonestConfirmation({ task, formattedTime, dueAt, isSelf }) {
  // Calculate how far away
  const msUntil = new Date(dueAt).getTime() - Date.now();
  const minutesUntil = Math.round(msUntil / 60_000);

  let timeDescription;
  if (minutesUntil <= 1) {
    timeDescription = `at ${formattedTime} (about a minute from now)`;
  } else if (minutesUntil < 60) {
    timeDescription = `at ${formattedTime} (about ${minutesUntil} minutes from now)`;
  } else {
    timeDescription = `at ${formattedTime}`;
  }

  // Honest wording — no "you'll get a notification" since no Web Push
  return `Done. I'll remind you ${formatReminderTaskForConfirmation(task)} here in the app ${timeDescription}. 🌿`;
}

// ── Helper functions ────────────────────────────────────────────

function formatTimeForUser(isoString, timeZone) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'the scheduled time';
  return date.toLocaleTimeString('en-IN', {
    timeZone: resolveTimeZone(timeZone),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function isSelfProfile(profile = {}) {
  const rel = String(profile.relation || '').toLowerCase();
  return rel === 'self' || rel === 'myself';
}

function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatReminderTaskForConfirmation(task = '') {
  const clean = String(task || '').trim().toLowerCase();
  if (!clean) return 'about this';
  if (/^(make|take|drink|eat|call|message|start|stop|check|prepare|buy|go|do)\b/.test(clean)) {
    return `to ${clean}`;
  }
  return `about ${clean}`;
}

function inferReminderType(task = '') {
  const t = task.toLowerCase();
  if (/water|hydrat|drink/.test(t)) return 'water_reminder';
  if (/medicine|medication|tablet|pill|prescribed/.test(t)) return 'medicine_reminder';
  if (/walk|exercise|stretch|move|posture/.test(t)) return 'movement_reminder';
  if (/sleep|bed|wind|screen/.test(t)) return 'winddown_reminder';
  if (/eat|food|meal|snack/.test(t)) return 'nutrition_reminder';
  if (/breath|calm|meditat|stress/.test(t)) return 'stress_reminder';
  return 'general_reminder';
}

function buildReminderChatMessage(task, isSelf) {
  return `**${task}** 🌿\n\nA gentle reminder for the task you set. No pressure — just a nudge.`;
}

/**
 * Look up recent reminders for a profile to help diagnose delivery failures.
 */
export async function getRecentReminders(db, { profileId, limit = 5 }) {
  return getRecentReminderRows(db, { profileId, limit });
}

/**
 * Build a response for a reminder failure report.
 */
export function buildReminderFailureResponse(recentReminders = []) {
  if (!recentReminders.length) {
    return "I don't see any recent reminders for you. Would you like me to set one up?";
  }

  const latest = recentReminders[0];
  const title = latest.title || 'reminder';
  const status = latest.status;

  if (status === 'scheduled') {
    return `Sorry about that. Your "${title}" reminder is still in the queue but hasn't fired yet. If this page stays open, you should see it when it's due. Would you like me to set a new one?`;
  }

  if (status === 'due') {
    return `Your "${title}" reminder is marked as due but it looks like the notification didn't show properly. Please check the notification bell at the top. I'll make sure future reminders are more visible.`;
  }

  if (status === 'completed') {
    return `Your "${title}" reminder was already marked as completed. If you didn't see it, it may have arrived while the page wasn't open. Right now, reminders only appear when you have the app open in your browser.`;
  }

  return `Sorry, that reminder should have reached you. Right now, reminders appear in the app when this page is open. Please go ahead and do it now — I'll check reminder status before confirming future ones.`;
}
