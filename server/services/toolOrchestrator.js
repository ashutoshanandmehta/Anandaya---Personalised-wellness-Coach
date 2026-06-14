import { v4 as uuidv4 } from 'uuid';
import { generateJSON, generateText } from './ai.js';
import {
  createScheduledItem,
  listReminderItems,
  buildReminderStatusMessage,
  updateLatestReminderText,
  updateReminderItem,
  cancelReminderItem,
  formatDueText,
} from './reminderToolService.js';
import {
  resolveTimeZone,
  localDateTimeToUtcIso,
  formatInTimeZone,
} from './timeService.js';
import { buildStandaloneCheckinRecord } from './checkinEngagementEngine.js';
import { classifyIntent, INTENTS } from './conversationIntentClassifier.js';
import { handleDirectReminder } from './directReminderHandler.js';

const TOOL_ACTIONS = new Set([
  'respond',
  'ask_clarification',
  'create_reminder',
  'update_reminder',
  'cancel_reminder',
  'list_reminders',
  'create_checkin',
  'update_checkin',
  'cancel_checkin',
]);

const SIDE_EFFECT_ACTIONS = new Set([
  'create_reminder',
  'update_reminder',
  'cancel_reminder',
  'create_checkin',
  'update_checkin',
  'cancel_checkin',
]);

export async function orchestrateToolAction({
  db,
  userId,
  profileId,
  profile = {},
  patientState = {},
  history = [],
  message = '',
  conversationId = null,
  pendingFollowupOffer = null,
} = {}) {
  const timeZone = resolveTimeZone(patientState?.timezone, profile?.timezone);
  const activeItems = await listReminderItems(db, {
    userId,
    profileId,
    status: 'active',
    limit: 8,
  });

  const medPolicy = detectMedicationPolicyIssue(message);
  if (medPolicy.blocked) {
    await auditToolAction(db, {
      userId,
      profileId,
      action: 'medication_policy_block',
      validation: { success: true },
      normalizedParams: medPolicy,
    });
    return {
      handled: true,
      mode: 'medication_policy_clarification',
      reply: medPolicy.reply,
      extra: {},
    };
  }

  const planner = await planToolAction({
    message,
    profile,
    patientState,
    history,
    activeItems,
    pendingFollowupOffer,
    timeZone,
  });

  let action = normalizeAction(planner.action);
  action = mergePendingToolAction(action, pendingFollowupOffer);
  let source = planner.source || 'llm_planner';

  if (!action || action.action === 'respond') {
    const fallback = classifyFallback({
      message,
      pendingFollowupOffer,
      patientState,
    });
    if (!fallback) {
      await auditToolAction(db, {
        userId,
        profileId,
        action: action?.action || 'respond',
        validation: { success: true, handled: false },
        normalizedParams: action || {},
        toolResult: { handled: false },
      });
      return { handled: false };
    }
    action = fallback;
    action = mergePendingToolAction(action, pendingFollowupOffer);
    source = 'deterministic_fallback';
  }

  if (action.action === 'ask_clarification') {
    const reply = action.clarificationQuestion || buildMissingFieldsReply(action, profile);
    await auditToolAction(db, {
      userId,
      profileId,
      action: action.action,
      validation: { success: true, missingFields: action.missingFields || [] },
      normalizedParams: action,
      toolResult: { success: false, needsClarification: true },
    });
    return {
      handled: true,
      mode: 'tool_clarification',
      reply,
      extra: { pendingToolAction: sanitizeForClient(action) },
    };
  }

  const validation = validateAction(action);
  if (!validation.success) {
    const reply = validation.reply || buildMissingFieldsReply(action, profile);
    await auditToolAction(db, {
      userId,
      profileId,
      action: action.action,
      validation,
      normalizedParams: action,
      toolResult: { success: false, needsClarification: true },
    });
    return {
      handled: true,
      mode: 'tool_validation_clarification',
      reply,
      extra: { pendingToolAction: sanitizeForClient(action) },
    };
  }

  const toolResult = await executeToolAction({
    db,
    userId,
    profileId,
    profile,
    action,
    source,
    message,
    conversationId,
    timeZone,
  });

  await auditToolAction(db, {
    userId,
    profileId,
    action: action.action,
    validation,
    normalizedParams: action,
    toolResult,
  });

  if (!toolResult.handled) return { handled: false };

  const reply = await buildFinalToolReply({
    action,
    toolResult,
    profile,
    timeZone,
  });

  return {
    handled: true,
    mode: toolResult.mode || `tool_${action.action}`,
    reply,
    extra: toolResult.extra || {},
  };
}

async function planToolAction({
  message,
  profile,
  patientState,
  history,
  activeItems,
  pendingFollowupOffer,
  timeZone,
}) {
  const context = buildPlannerContext({
    message,
    profile,
    patientState,
    history,
    activeItems,
    pendingFollowupOffer,
    timeZone,
  });

  const systemInstruction = `You are an internal tool planner for a health/wellness app.
Return exactly one JSON object. Do not write user-facing prose unless action is ask_clarification.

Your job:
- Decide whether the user wants a reminder/check-in tool action, status lookup, update, cancel, or ordinary chat.
- Use profile context, recent chat, active reminders, timezone, and current local date/time.
- If the user wants ordinary coaching or health conversation, return {"action":"respond"} so the main wellness engine can answer.
- If a tool action is missing required fields, return {"action":"ask_clarification", "missingFields":[...], "clarificationQuestion":"..."}.
- If the user asks to "check", "check in", "ask later how X is", or follow up on a symptom/habit/state, prefer create_checkin, not create_reminder.
- Use create_reminder for action nudges ("do/take/drink/cook/start this at time"). Use create_checkin for progress/status questions ("how is stomach", "did sleep improve", "ask whether it happened").
- Never pretend a side effect happened. You only plan; backend executes.
- For medication dosage: do not recommend or decide dosage. If updating medication reminder text includes a dosage change, set medicationContext.dosageChange=true. If the user clearly says doctor/prescription/clinician instructed it, set clinicianConfirmed=true; otherwise ask for confirmation first.

Allowed actions:
respond, ask_clarification, create_reminder, update_reminder, cancel_reminder, list_reminders, create_checkin, update_checkin, cancel_checkin.

Output schema:
{
  "action": "one allowed action",
  "kind": "reminder|checkin|null",
  "title": "short task/reminder title or null",
  "localDateTime": "YYYY-MM-DD HH:mm or null",
  "relativeTime": {"amount": number, "unit": "minutes|hours|days"} or null,
  "timezone": "${timeZone}",
  "targetId": "existing reminder id if unambiguous or null",
  "targetDescription": "text target if any or null",
  "update": {"title": string|null, "localDateTime": string|null, "oldText": string|null, "newText": string|null},
  "confirmationNeeded": boolean,
  "missingFields": [],
  "clarificationQuestion": string|null,
  "medicationContext": {"involvesMedication": boolean, "dosageChange": boolean, "clinicianConfirmed": boolean, "needsClinicianConfirmation": boolean},
  "reason": "brief internal reason"
}

Timing rules:
- Convert "tomorrow at 9 AM" to an exact localDateTime using currentLocalDate.
- For "9 AM tomorrow", use 09:00.
- For "kal 9 bje", use tomorrow 09:00 unless context strongly implies night.
- For "raat 9 bje"/"night 9", use 21:00.
- If the time is vague like "night", ask one clarification.
- If the task is clear but time missing, ask one warm clarification.
- If update target is ambiguous across multiple active reminders, ask which one.

Tone for clarificationQuestion: warm, short, natural.`;

  try {
    const planned = await generateJSON(systemInstruction, JSON.stringify(context, null, 2));
    return { ...planned, source: 'llm_planner' };
  } catch (error) {
    console.warn('[ToolOrchestrator] LLM planner failed:', error.message);
    return { action: 'respond', source: 'planner_failed', error: error.message };
  }
}

function buildPlannerContext({
  message,
  profile,
  patientState,
  history,
  activeItems,
  pendingFollowupOffer,
  timeZone,
}) {
  const now = new Date();
  const currentLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now).replace(',', '');

  return {
    currentUtc: now.toISOString(),
    currentLocalDateTime: currentLocal,
    timezone: timeZone,
    userMessage: message,
    profile: {
      id: profile?.id,
      name: profile?.name,
      relation: profile?.relation,
      summary: patientState?.profile_summary_text || null,
      structuredProfile: safeJson(patientState?.structured_profile_json, {}),
    },
    recentMessages: (history || []).slice(-8),
    activeReminders: (activeItems || []).map(item => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      status: item.status,
      scheduledFor: item.scheduledFor,
      formattedDueText: item.formattedDueText,
      displayState: item.displayState,
    })),
    pendingFollowupOffer: pendingFollowupOffer || null,
  };
}

function normalizeAction(raw = {}) {
  const actionName = String(raw?.action || '').trim().toLowerCase();
  if (!TOOL_ACTIONS.has(actionName)) return null;

  return {
    action: actionName,
    kind: normalizeKind(raw.kind),
    title: cleanTitle(raw.title),
    localDateTime: normalizeLocalDateTime(raw.localDateTime),
    relativeTime: normalizeRelativeTime(raw.relativeTime),
    timezone: resolveTimeZone(raw.timezone),
    targetId: stringOrNull(raw.targetId),
    targetDescription: stringOrNull(raw.targetDescription),
    update: normalizeUpdate(raw.update),
    confirmationNeeded: Boolean(raw.confirmationNeeded),
    missingFields: Array.isArray(raw.missingFields) ? raw.missingFields.map(String).filter(Boolean) : [],
    clarificationQuestion: stringOrNull(raw.clarificationQuestion),
    medicationContext: {
      involvesMedication: Boolean(raw.medicationContext?.involvesMedication),
      dosageChange: Boolean(raw.medicationContext?.dosageChange),
      clinicianConfirmed: Boolean(raw.medicationContext?.clinicianConfirmed),
      needsClinicianConfirmation: Boolean(raw.medicationContext?.needsClinicianConfirmation),
    },
    reason: stringOrNull(raw.reason),
  };
}

function mergePendingToolAction(action, pendingFollowupOffer) {
  if (!action || pendingFollowupOffer?.type !== 'tool_action' || !pendingFollowupOffer.toolAction) {
    return action;
  }

  const pending = normalizeAction(pendingFollowupOffer.toolAction);
  if (!pending) return action;

  const compatible =
    action.action === pending.action ||
    (pending.missingFields || []).length > 0 ||
    action.action === 'ask_clarification';

  if (!compatible) return action;

  return {
    ...pending,
    ...action,
    action: action.action === 'ask_clarification' ? pending.action : action.action,
    kind: action.kind || pending.kind,
    title: action.title || pending.title,
    localDateTime: action.localDateTime || pending.localDateTime,
    relativeTime: action.relativeTime || pending.relativeTime,
    targetId: action.targetId || pending.targetId,
    targetDescription: action.targetDescription || pending.targetDescription,
    update: {
      ...(pending.update || {}),
      ...(action.update || {}),
    },
    missingFields: [],
    clarificationQuestion: action.clarificationQuestion,
  };
}

function validateAction(action = {}) {
  if (!TOOL_ACTIONS.has(action.action)) {
    return { success: false, missingFields: ['action'] };
  }

  if (
    action.medicationContext?.involvesMedication &&
    action.medicationContext?.dosageChange &&
    !action.medicationContext?.clinicianConfirmed &&
    SIDE_EFFECT_ACTIONS.has(action.action)
  ) {
    return {
      success: false,
      missingFields: ['clinician_confirmation'],
      reply: "I can update the reminder text, but I need one quick check first: is this dosage exactly from a doctor or prescription? I won't change medication dosage based on my own suggestion.",
    };
  }

  if (action.action === 'create_reminder' || action.action === 'create_checkin') {
    const missing = [];
    if (!action.title) missing.push('title');
    if (!action.localDateTime && !action.relativeTime && action._fallbackIntent !== INTENTS.DIRECT_REMINDER) missing.push('time');
    if (missing.length) {
      return { success: false, missingFields: missing };
    }
  }

  if (action.action === 'update_reminder' || action.action === 'update_checkin') {
    const hasUpdate = action.update?.title || action.update?.localDateTime || action.update?.newText || action.localDateTime || action.title;
    if (!hasUpdate) return { success: false, missingFields: ['update_details'] };
  }

  return { success: true };
}

async function executeToolAction({
  db,
  userId,
  profileId,
  profile,
  action,
  source,
  message,
  conversationId,
  timeZone,
}) {
  if (action.action === 'list_reminders') {
    const reply = await buildReminderStatusMessage(db, { userId, profileId, profile, query: message });
    return {
      handled: true,
      success: true,
      mode: 'tool_list_reminders',
      reply,
      extra: {},
    };
  }

  if (action.action === 'create_reminder' || action.action === 'create_checkin') {
    if (action._fallbackIntent === INTENTS.DIRECT_REMINDER) {
      const directResult = await handleDirectReminder({
        db,
        userId,
        profile,
        reminderMeta: action._fallbackMetadata,
        originalMessage: message,
        conversationId,
      });
      return {
        handled: true,
        success: directResult.success,
        mode: directResult.success ? 'tool_reminder_created' : 'tool_reminder_create_failed',
        action: action.action,
        record: directResult.record,
        item: directResult.record ? {
          id: directResult.record.id,
          title: directResult.record.title,
          kind: directResult.record.metadata?.kind || 'reminder',
          scheduledFor: directResult.record.scheduledFor,
          formattedDueText: formatDueText(directResult.record.scheduledFor, timeZone),
        } : null,
        reply: directResult.success ? null : directResult.confirmationMessage,
        extra: directResult.success ? { scheduledCheckins: [directResult.record], dueAt: directResult.dueAt } : {},
      };
    }

    const dueAt = resolveActionDueAt(action, timeZone);
    if (!dueAt) {
      return clarificationResult(action, 'What time should I use for this? You can say it casually, like “tomorrow at 9 AM” or “after 30 minutes.”');
    }

    if (new Date(dueAt).getTime() <= Date.now()) {
      return clarificationResult(action, 'That time has already passed. Should I set it for tomorrow instead?');
    }

    const kind = action.action === 'create_checkin' ? 'checkin' : 'reminder';
    const duplicate = await findLikelyDuplicate(db, {
      userId,
      profileId,
      title: action.title,
      dueAt,
      kind,
    });
    if (duplicate) {
      return {
        handled: true,
        success: true,
        mode: kind === 'checkin' ? 'tool_checkin_already_exists' : 'tool_reminder_already_exists',
        action: action.action,
        item: duplicate,
        reply: `This is already saved 🌿\n\n**${duplicate.title}**\n${duplicate.formattedDueText || formatDueText(duplicate.scheduledFor, timeZone)}`,
        extra: { reminder: duplicate },
      };
    }

    const record = await buildScheduledRecord({
      userId,
      profile,
      title: action.title,
      dueAt,
      kind,
      timeZone,
      sourceText: message,
      source,
    });

    await createScheduledItem(db, record);
    return {
      handled: true,
      success: true,
      mode: kind === 'checkin' ? 'tool_checkin_created' : 'tool_reminder_created',
      action: action.action,
      record,
      item: {
        id: record.id,
        title: record.title,
        kind,
        scheduledFor: dueAt,
        formattedDueText: formatDueText(dueAt, timeZone),
        emoji: record.metadata?.emoji,
      },
      extra: { scheduledCheckins: [record], dueAt },
    };
  }

  if (action.action === 'update_reminder' || action.action === 'update_checkin') {
    if (source === 'deterministic_fallback' && action._fallbackIntent === INTENTS.REMINDER_UPDATE) {
      const updateResult = await updateLatestReminderText(db, {
        userId,
        profileId,
        correction: action._fallbackMetadata,
        originalMessage: message,
      });
      return {
        handled: true,
        success: updateResult.success,
        mode: updateResult.success ? 'tool_reminder_updated' : 'tool_reminder_update_failed',
        item: updateResult.item,
        reply: updateResult.assistantMessage,
        extra: updateResult.success ? { reminder: updateResult.item } : {},
      };
    }

    const dueAt = action.update?.localDateTime || action.localDateTime
      ? resolveActionDueAt({ ...action, localDateTime: action.update?.localDateTime || action.localDateTime }, timeZone)
      : null;
    const title = action.update?.title || buildReplacementTitle(action.update) || action.title;

    const updateResult = await updateReminderItem(db, {
      userId,
      profileId,
      itemId: action.targetId,
      title,
      scheduledFor: dueAt,
      timeZone,
      sourceText: message,
    });

    return {
      handled: true,
      success: updateResult.success,
      mode: updateResult.success ? 'tool_reminder_updated' : 'tool_reminder_update_failed',
      item: updateResult.item,
      reply: updateResult.assistantMessage,
      extra: updateResult.success ? { reminder: updateResult.item } : {},
    };
  }

  if (action.action === 'cancel_reminder' || action.action === 'cancel_checkin') {
    const cancelResult = await cancelReminderItem(db, {
      userId,
      profileId,
      itemId: action.targetId,
      targetText: action.targetDescription,
      reason: 'user_cancelled_via_tool',
    });
    return {
      handled: true,
      success: cancelResult.success,
      needsClarification: cancelResult.needsClarification,
      mode: cancelResult.success ? 'tool_reminder_cancelled' : 'tool_reminder_cancel_failed',
      item: cancelResult.item,
      items: cancelResult.items,
      reply: cancelResult.assistantMessage,
      extra: cancelResult.success ? { reminder: cancelResult.item } : {},
    };
  }

  return { handled: false };
}

function classifyFallback({ message, pendingFollowupOffer, patientState }) {
  const intent = classifyIntent({
    message,
    hasPendingOffer: Boolean(pendingFollowupOffer),
    pendingOffer: pendingFollowupOffer,
    patientState,
  });

  if (intent.intent === INTENTS.DIRECT_REMINDER) {
    return {
      action: 'create_reminder',
      kind: 'reminder',
      title: intent.metadata?.task || null,
      timezone: resolveTimeZone(patientState?.timezone),
      _fallbackIntent: intent.intent,
      _fallbackMetadata: intent.metadata,
    };
  }

  if (intent.intent === INTENTS.REMINDER_UPDATE) {
    return {
      action: 'update_reminder',
      kind: 'reminder',
      update: {
        title: null,
        localDateTime: null,
        oldText: intent.metadata?.oldText || null,
        newText: intent.metadata?.newText || null,
      },
      timezone: resolveTimeZone(patientState?.timezone),
      _fallbackIntent: intent.intent,
      _fallbackMetadata: intent.metadata,
    };
  }

  if (intent.intent === INTENTS.REMINDER_STATUS) {
    return { action: 'list_reminders', kind: null, timezone: resolveTimeZone(patientState?.timezone) };
  }

  if (intent.intent === INTENTS.REMINDER_FAILURE) {
    return {
      action: 'ask_clarification',
      clarificationQuestion: null,
      _fallbackIntent: intent.intent,
      _fallbackMetadata: intent.metadata,
    };
  }

  return null;
}

async function findLikelyDuplicate(db, { userId, profileId, title, dueAt, kind }) {
  const items = await listReminderItems(db, {
    userId,
    profileId,
    status: 'active',
    limit: 20,
  });
  const targetTitle = normalizeComparableTitle(title);
  const targetTime = new Date(dueAt).getTime();
  if (!targetTitle || !Number.isFinite(targetTime)) return null;

  return items.find(item => {
    if (item.kind !== kind) return false;
    if (normalizeComparableTitle(item.title) !== targetTitle) return false;
    const itemTime = new Date(item.scheduledFor).getTime();
    return Number.isFinite(itemTime) && Math.abs(itemTime - targetTime) <= 5 * 60_000;
  }) || null;
}

async function buildFinalToolReply({ action, toolResult, profile, timeZone }) {
  if (toolResult.reply) {
    return enforceTrustInvariant(toolResult.reply, toolResult);
  }

  const fallback = buildDeterministicToolReply({ action, toolResult, profile, timeZone });
  if (!toolResult.success) return enforceTrustInvariant(fallback, toolResult);

  const systemInstruction = `You write final user-facing messages for a reminder/check-in tool.
Be warm, concise, and friendly. Use the profile name naturally if it helps.
You must only mention exact details present in TOOL_RESULT.
You may say scheduled/updated/cancelled only if TOOL_RESULT.success is true.
Use at most one gentle emoji.`;

  const prompt = JSON.stringify({
    profile: { name: profile?.name, relation: profile?.relation },
    action,
    toolResult: summarizeToolResult(toolResult, timeZone),
    fallback,
  }, null, 2);

  try {
    const reply = await generateText(systemInstruction, prompt, 0.35);
    if (!reply || /temporarily unavailable/i.test(reply)) return fallback;
    return enforceTrustInvariant(reply.trim(), toolResult) || fallback;
  } catch {
    return fallback;
  }
}

function buildDeterministicToolReply({ action, toolResult, timeZone }) {
  if (!toolResult.success) {
    if (toolResult.needsClarification) {
      return toolResult.reply || 'I can do that. I just need one more detail first.';
    }
    return toolResult.reply || "I understood that, but I couldn't save the change in the schedule. Can we try once more?";
  }

  if (action.action === 'create_reminder' || action.action === 'create_checkin') {
    const item = toolResult.item;
    const label = item.kind === 'checkin' ? 'check-in' : 'reminder';
    const emoji = item.emoji || (item.kind === 'checkin' ? '✨' : '🌿');
    return `Done ${emoji} I’ve scheduled the ${label}: **${item.title}**\n\n${item.formattedDueText || formatDueText(item.scheduledFor, timeZone)}. It’ll show in the bell when it’s due.`;
  }

  if (action.action === 'list_reminders') return toolResult.reply;

  if (action.action === 'update_reminder' || action.action === 'update_checkin') {
    const item = toolResult.item;
    return `Done 🌿 I updated it to: **${item?.title || 'the reminder'}**\n\n${item?.formattedDueText || ''}`.trim();
  }

  if (action.action === 'cancel_reminder' || action.action === 'cancel_checkin') {
    return `Cancelled it 🌿`;
  }

  return toolResult.reply || 'Done 🌿';
}

function enforceTrustInvariant(reply = '', toolResult = {}) {
  if (toolResult.success) return reply;
  return String(reply || '')
    .replace(/\b(?:i(?:'|’)ve|i have|we(?:'|’)ve|we have)\s+(?:set|scheduled|updated|cancelled|saved)\b/gi, "I understood")
    .replace(/\b(?:set|scheduled|updated|cancelled|saved)\s+(?:successfully|it)\b/gi, 'not saved yet')
    .trim();
}

function resolveActionDueAt(action, fallbackTimeZone) {
  const timeZone = resolveTimeZone(action.timezone, fallbackTimeZone);
  if (action.localDateTime) {
    return localDateTimeToUtcIso({ localDateTime: action.localDateTime, timeZone });
  }

  if (action.relativeTime?.amount && action.relativeTime?.unit) {
    const amount = Number(action.relativeTime.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = String(action.relativeTime.unit).toLowerCase();
    const ms = unit.startsWith('minute') ? amount * 60_000
      : unit.startsWith('hour') ? amount * 3_600_000
        : unit.startsWith('day') ? amount * 86_400_000
          : null;
    return ms ? new Date(Date.now() + ms).toISOString() : null;
  }

  if (action._fallbackIntent === INTENTS.DIRECT_REMINDER) return null;
  return null;
}

async function buildScheduledRecord({ userId, profile, title, dueAt, kind, timeZone, sourceText, source }) {
  if (kind === 'checkin') {
    return buildStandaloneCheckinRecord({
      userId,
      profile,
      title,
      dueAt,
      timeZone,
      sourceText,
      source,
    });
  }

  const isSelf = isSelfProfile(profile);
  const clean = titleCase(cleanTitle(title) || (kind === 'checkin' ? 'Check-in' : 'Reminder'));
  const reminderType = inferReminderType(clean);
  const emoji = titleEmoji(clean, reminderType);

  return {
    id: uuidv4(),
    userId,
    profileId: profile.id,
    goalId: null,
    relation: isSelf ? 'self' : 'other',
    type: kind === 'checkin' ? 'general_checkin' : reminderType,
    status: 'scheduled',
    scheduledFor: dueAt,
    title: clean,
    pushTitle: kind === 'checkin' ? `Tiny progress ping ${isSelf ? 'for you' : `for ${profile.name}`} ✨` : `${clean} ${emoji}`,
    pushBody: kind === 'checkin' ? 'Tap to share a quick update.' : 'Tap to view this gentle reminder.',
    inAppTitle: kind === 'checkin' ? `${clean} scheduled ✨` : `${clean} scheduled ${emoji}`,
    inAppBody: `Scheduled for ${formatInTimeZone(dueAt, { timeZone })}.`,
    detailedChatMessage: kind === 'checkin'
      ? `${clean} ✨\n\nHow did this go?`
      : `**${clean}** ${emoji}\n\nA gentle reminder for the task you set. No pressure, just a nudge.`,
    responseOptions: kind === 'checkin' ? ['Yes', 'No', 'Partially', 'Faced an issue'] : [],
    source: 'wellness_chat',
    category: reminderType,
    channel: 'in_app',
    metadata: {
      kind,
      reminderType,
      goalType: reminderType,
      cadence: 'one_time',
      timezone: timeZone,
      sourceText,
      plannerSource: source,
      createdAt: new Date().toISOString(),
      toolOrchestrated: true,
    },
  };
}

function buildMissingFieldsReply(action = {}, profile = {}) {
  const name = profile?.name;
  const missing = new Set(action.missingFields || []);

  if (missing.has('time')) {
    return name
      ? `Sure 🌿 What time should I set that for ${name}? You can say it casually, like “tomorrow at 9 AM” or “after dinner.”`
      : `Sure 🌿 What time should I set that for? You can say it casually, like “tomorrow at 9 AM” or “after dinner.”`;
  }

  if (missing.has('title')) {
    return 'Sure 🌿 What should I remind you about?';
  }

  return action.clarificationQuestion || 'I can do that. Tell me one more detail so I set it correctly.';
}

function clarificationResult(action, reply) {
  return {
    handled: true,
    success: false,
    needsClarification: true,
    mode: 'tool_clarification',
    reply,
    action,
  };
}

function buildReplacementTitle(update = {}) {
  const oldText = stringOrNull(update?.oldText);
  const newText = stringOrNull(update?.newText);
  if (!newText) return null;
  if (!oldText) return newText;
  return newText;
}

function detectMedicationPolicyIssue(message = '') {
  const text = String(message || '').toLowerCase();
  const involvesMedication = /\b(?:medicine|medication|tablet|pill|dose|dosage|mg|ml|prescription)\b/i.test(text);
  const asksAdvice = /\b(?:should|can|may)\s+i\b.*\b(?:double|increase|decrease|change|skip|stop|take)\b/i.test(text) ||
    /\b(?:double|increase|decrease|change|skip|stop)\s+(?:my\s+)?(?:dose|dosage|medicine|medication)\b/i.test(text);

  if (involvesMedication && asksAdvice && !/\b(?:doctor|dr\.?|physician|clinician|prescription|prescribed)\b/i.test(text)) {
    return {
      blocked: true,
      reply: "I can’t decide or change medication dosage for you. Please follow your prescription or check with a qualified clinician. If a doctor has already changed it, tell me that clearly and I can help update the reminder text only. 🌿",
    };
  }

  return { blocked: false };
}

async function auditToolAction(db, {
  userId,
  profileId,
  action,
  normalizedParams = {},
  validation = {},
  toolResult = {},
}) {
  try {
    await db.run(`
      INSERT INTO audit_logs (id, user_id, profile_id, action, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `, [
      uuidv4(),
      userId,
      profileId,
      `tool_orchestrator:${action || 'unknown'}`,
      JSON.stringify({
        normalizedParams: sanitizeAudit(normalizedParams),
        validation: sanitizeAudit(validation),
        toolResult: sanitizeAudit(toolResult),
        at: new Date().toISOString(),
      }),
    ]);
  } catch (error) {
    console.warn('[ToolOrchestrator] audit log failed:', error.message);
  }
}

function summarizeToolResult(toolResult = {}, timeZone) {
  return {
    success: Boolean(toolResult.success),
    mode: toolResult.mode,
    item: toolResult.item ? {
      id: toolResult.item.id,
      kind: toolResult.item.kind,
      title: toolResult.item.title,
      scheduledFor: toolResult.item.scheduledFor,
      formattedDueText: toolResult.item.formattedDueText || formatDueText(toolResult.item.scheduledFor, timeZone),
    } : null,
    record: toolResult.record ? {
      id: toolResult.record.id,
      title: toolResult.record.title,
      scheduledFor: toolResult.record.scheduledFor,
      kind: toolResult.record.metadata?.kind,
      formattedDueText: formatDueText(toolResult.record.scheduledFor, timeZone),
    } : null,
    reply: toolResult.reply || null,
  };
}

function sanitizeAudit(value) {
  return JSON.parse(JSON.stringify(value, (key, val) => {
    if (/token|password|secret|key/i.test(key)) return '[redacted]';
    if (key === 'sourceText' && typeof val === 'string') return val.slice(0, 160);
    return val;
  }));
}

function sanitizeForClient(action = {}) {
  return {
    action: action.action,
    kind: action.kind,
    title: action.title || null,
    targetId: action.targetId || null,
    targetDescription: action.targetDescription || null,
    update: action.update || null,
    missingFields: action.missingFields || [],
    clarificationQuestion: action.clarificationQuestion || null,
  };
}

function safeJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeKind(kind) {
  const value = String(kind || '').toLowerCase();
  if (value === 'checkin' || value === 'check-in') return 'checkin';
  if (value === 'reminder') return 'reminder';
  return null;
}

function cleanTitle(value) {
  const clean = stringOrNull(value);
  if (!clean) return null;
  return clean
    .replace(/^remind\s+me\s+(?:to|about)\s+/i, '')
    .replace(/^set\s+(?:a\s+)?reminder\s+(?:to|for)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocalDateTime(value) {
  const clean = stringOrNull(value);
  if (!clean) return null;
  const match = clean.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]} ${String(match[4]).padStart(2, '0')}:${match[5]}`;
}

function normalizeRelativeTime(value) {
  if (!value || typeof value !== 'object') return null;
  const amount = Number(value.amount);
  const unit = String(value.unit || '').toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!/^(minutes?|hours?|days?)$/.test(unit)) return null;
  return { amount, unit: unit.replace(/s$/, '') + 's' };
}

function normalizeUpdate(update = {}) {
  return {
    title: cleanTitle(update?.title),
    localDateTime: normalizeLocalDateTime(update?.localDateTime),
    oldText: stringOrNull(update?.oldText),
    newText: stringOrNull(update?.newText),
  };
}

function stringOrNull(value) {
  const clean = String(value ?? '').trim();
  if (!clean || clean.toLowerCase() === 'null') return null;
  return clean;
}

function isSelfProfile(profile = {}) {
  const rel = String(profile.relation || profile.relationToUser || '').trim().toLowerCase();
  return rel === 'self' || rel === 'myself';
}

function titleCase(value = '') {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : '';
}

function normalizeComparableTitle(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(?:remind|reminder|to|for|me|about|the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferReminderType(title = '') {
  const t = String(title || '').toLowerCase();
  if (/water|hydrat|drink/.test(t)) return 'water_reminder';
  if (/medicine|medication|tablet|pill|prescribed|dose|mg\b/.test(t)) return 'medicine_reminder';
  if (/walk|exercise|stretch|move|posture/.test(t)) return 'movement_reminder';
  if (/sleep|bed|wind|screen/.test(t)) return 'winddown_reminder';
  if (/eat|food|meal|snack|daal|dal|cook|breakfast|lunch|dinner/.test(t)) return 'nutrition_reminder';
  if (/breath|calm|meditat|stress/.test(t)) return 'stress_reminder';
  return 'general_reminder';
}

function titleEmoji(title = '', type = '') {
  const text = `${title} ${type}`.toLowerCase();
  if (/sleep|wind|bed/.test(text)) return '🌙';
  if (/water|hydration/.test(text)) return '🌊';
  if (/walk|movement|exercise|stretch/.test(text)) return '🚶';
  if (/medicine|medication|tablet|pill|dose|mg\b/.test(text)) return '💊';
  if (/meal|food|nutrition|daal|dal|cook/.test(text)) return '🍽️';
  if (/habit|routine/.test(text)) return '🌱';
  return '🌿';
}
