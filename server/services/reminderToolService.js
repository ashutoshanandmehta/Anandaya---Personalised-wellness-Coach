import { buildScheduledCheckin, insertScheduledCheckin } from './checkinPolicy.js';
import { v4 as uuidv4 } from 'uuid';
import { CronExpressionParser } from 'cron-parser';
import { resolveTimeZone } from './timeService.js';
import {
  buildReminderFollowupCheckin,
  buildEngagementCheckinRecord,
  planEngagementCheckin,
  inferCheckinTaxonomy,
  getTaxonomyPolicy,
} from './checkinEngagementEngine.js';

const ACTIVE_STATUSES = ['scheduled', 'due', 'sent'];
const VISIBLE_STATUSES = ['scheduled', 'due', 'sent', 'completed', 'missed'];
const AUTO_ENGAGEMENT_CHECKINS_ENABLED = String(process.env.ENABLE_AUTO_ENGAGEMENT_CHECKINS || '').toLowerCase() === 'true';
const ENGAGEMENT_IDLE_MINUTES = Math.max(10, Number(process.env.ENGAGEMENT_IDLE_MINUTES || 180));
const ENGAGEMENT_COOLDOWN_MINUTES = Math.max(10, Number(process.env.ENGAGEMENT_COOLDOWN_MINUTES || 180));

export function safeJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export async function createScheduledItem(db, record) {
  await insertScheduledCheckin(db, record);
  const metadata = record.metadata || {};
  if (metadata.kind === 'reminder' && !metadata.skipAutoFollowup) {
    const profile = await db.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', [
      record.profileId,
      record.userId,
    ]);
    const followup = await buildReminderFollowupCheckin({
      parentRecord: record,
      profile: profile || {},
    });
    if (followup) {
      await insertScheduledCheckin(db, followup);
      record.followupCheckin = followup;
      await auditReminderLifecycle(db, {
        userId: record.userId,
        profileId: record.profileId,
        action: 'reminder_followup_checkin_created',
        metadata: {
          parentReminderId: record.id,
          childCheckinId: followup.id,
          taxonomy: followup.metadata?.taxonomy,
          graceMinutes: followup.metadata?.graceMinutes,
        },
      });
    }
  }
  return record;
}

export async function createScheduledItemsFromOffers(db, { userId, profile, offers = [] }) {
  const records = [];
  for (const offer of offers) {
    const record = buildScheduledCheckin({ userId, profile, offer });
    await createScheduledItem(db, record);
    records.push(record);
  }
  return records;
}

export async function markDueScheduledItems(db, { userId = null, profileId = null, createEngagement = false } = {}) {
  const clauses = [
    "status = 'scheduled'",
    "datetime(scheduled_for) <= datetime('now')",
  ];
  const params = [];

  if (userId) {
    clauses.push('user_id = ?');
    params.push(userId);
  }

  if (profileId) {
    clauses.push('profile_id = ?');
    params.push(profileId);
  }

  const rowsToUpdate = await db.all(`
    SELECT * FROM scheduled_checkins
    WHERE ${clauses.join(' AND ')}
  `, params);

  let dueResult = { changes: 0 };
  if (rowsToUpdate.length > 0) {
    const ids = rowsToUpdate.map(r => r.id);
    dueResult = await db.run(`
      UPDATE scheduled_checkins
      SET status = 'due',
          updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${ids.map(() => '?').join(',')})
    `, ids);

    // Spawn recurring instances
    for (const row of rowsToUpdate) {
      const metadata = safeJson(row.metadata_json, {});
      if (metadata.cron && metadata.cadence === 'recurring') {
        try {
          const interval = CronExpressionParser.parse(metadata.cron, { tz: metadata.timezone || 'Asia/Kolkata' });
          const nextDate = interval.next().toISOString();
          
          await insertScheduledCheckin(db, {
            id: uuidv4(),
            userId: row.user_id,
            profileId: row.profile_id,
            goalId: row.goal_id,
            relation: row.relation,
            type: row.type,
            status: 'scheduled',
            scheduledFor: nextDate,
            title: row.title,
            pushTitle: row.push_title,
            pushBody: row.push_body,
            inAppTitle: row.in_app_title,
            inAppBody: row.in_app_body,
            detailedChatMessage: row.detailed_chat_message,
            responseOptions: safeJson(row.response_options_json, []),
            source: row.source,
            category: row.category,
            channel: row.channel,
            metadata: { ...metadata, createdAt: new Date().toISOString() },
          });
        } catch (e) {
          console.error('[ReminderService] Failed to schedule recurring checkin:', e.message);
        }
      }
    }
  }

  const triggeredResult = await activateTriggeredCheckins(db, { userId, profileId });
  const engagementResult = createEngagement
    ? await createDueEngagementCheckins(db, { userId, profileId })
    : { changes: 0 };

  return {
    ...dueResult,
    changes: (dueResult?.changes || 0) + (triggeredResult?.changes || 0) + (engagementResult?.changes || 0),
    dueChanges: dueResult?.changes || 0,
    triggeredChanges: triggeredResult?.changes || 0,
    engagementChanges: engagementResult?.changes || 0,
  };
}

export async function countSoonScheduledItems(db, minutesAhead = 5) {
  const safeMinutes = Math.max(1, Math.min(Number(minutesAhead) || 5, 1440));
  const result = await db.get(`
    SELECT COUNT(*) AS count
    FROM scheduled_checkins
    WHERE status IN ('scheduled', 'pending_trigger')
      AND datetime(scheduled_for) <= datetime('now', '+${safeMinutes} minutes')
  `);
  return result?.count || 0;
}

export async function listReminderItems(db, {
  userId,
  profileId = null,
  status = 'visible',
  limit = 30,
  markDue = false,
} = {}) {
  // The background scheduler (server/services/reminderScheduler.js) already
  // marks due items every 15–60s. Polling endpoints should NOT pay that cost
  // on every request — opt in with `markDue: true` only when the caller
  // actually needs the freshest state (e.g. status messages mid-chat).
  if (markDue) {
    await markDueScheduledItems(db, { userId, profileId });
  }

  const params = [userId];
  const clauses = ['sc.user_id = ?'];

  if (profileId) {
    clauses.push('sc.profile_id = ?');
    params.push(profileId);
  }

  const statusList = status === 'active'
    ? ACTIVE_STATUSES
    : status === 'all'
      ? null
      : VISIBLE_STATUSES;

  if (statusList) {
    clauses.push(`sc.status IN (${statusList.map(() => '?').join(',')})`);
    params.push(...statusList);
  } else if (status && status !== 'all') {
    clauses.push('sc.status = ?');
    params.push(status);
  }

  params.push(Math.max(1, Math.min(Number(limit) || 30, 100)));

  const rows = await db.all(`
    SELECT sc.*, p.name AS profile_name
    FROM scheduled_checkins sc
    JOIN profiles p ON p.id = sc.profile_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY
      CASE sc.status
        WHEN 'due' THEN 0
        WHEN 'sent' THEN 1
        WHEN 'scheduled' THEN 2
        WHEN 'missed' THEN 3
        WHEN 'completed' THEN 4
        ELSE 5
      END,
      datetime(sc.scheduled_for) ASC,
      datetime(sc.updated_at) DESC
    LIMIT ?
  `, params);

  return rows.map(serializeReminderItem);
}

export async function getReminderRow(db, { userId, itemId }) {
  return db.get(`
    SELECT sc.*, p.name AS profile_name
    FROM scheduled_checkins sc
    JOIN profiles p ON p.id = sc.profile_id
    WHERE sc.id = ? AND sc.user_id = ?
  `, [itemId, userId]);
}

export async function getRecentReminderRows(db, { userId = null, profileId, limit = 5 }) {
  const params = [profileId];
  const userClause = userId ? 'AND user_id = ?' : '';
  if (userId) params.push(userId);
  params.push(Math.max(1, Math.min(Number(limit) || 5, 20)));

  return db.all(`
    SELECT id, title, status, scheduled_for, delivered_at, shown_at,
           acknowledged_at, completed_at, metadata_json, created_at, updated_at
    FROM scheduled_checkins
    WHERE profile_id = ?
      ${userClause}
    ORDER BY datetime(created_at) DESC
    LIMIT ?
  `, params);
}

export async function acknowledgeReminderItem(db, { userId, itemId }) {
  const row = await getReminderRow(db, { userId, itemId });
  if (!row) return null;

  await db.run(`
    UPDATE scheduled_checkins
    SET shown_at = COALESCE(shown_at, CURRENT_TIMESTAMP),
        acknowledged_at = COALESCE(acknowledged_at, CURRENT_TIMESTAMP),
        delivery_attempts = COALESCE(delivery_attempts, 0) + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [itemId]);

  const updated = await getReminderRow(db, { userId, itemId });
  return serializeReminderItem(updated);
}

export async function dismissReminderItem(db, { userId, itemId }) {
  const row = await getReminderRow(db, { userId, itemId });
  if (!row) return null;
  if (!['scheduled', 'due', 'sent'].includes(row.status)) return serializeReminderItem(row);

  await db.run(`
    UPDATE scheduled_checkins
    SET dismissed_at = COALESCE(dismissed_at, CURRENT_TIMESTAMP),
        status = 'cancelled',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [itemId]);

  await cancelPendingChildrenForParent(db, {
    userId,
    parentReminderId: itemId,
    reason: 'parent_dismissed',
  });

  const updated = await getReminderRow(db, { userId, itemId });
  return serializeReminderItem(updated);
}

export async function openScheduledItem(db, { userId, itemId }) {
  await markDueScheduledItems(db, { userId });
  const row = await getReminderRow(db, { userId, itemId });
  if (!row) return { error: 'not_found' };

  const scheduledAt = new Date(row.scheduled_for).getTime();
  if (
    row.status === 'pending_trigger' ||
    (row.status === 'scheduled' && Number.isFinite(scheduledAt) && scheduledAt > Date.now())
  ) {
    return {
      error: 'not_due',
      item: serializeReminderItem(row),
    };
  }

  const metadata = safeJson(row.metadata_json, {});
  const kind = metadata.kind || 'checkin';
  const shouldInsertMessage = !row.acknowledged_at && !row.delivered_at;

  if (kind === 'reminder') {
    await db.run(`
      UPDATE scheduled_checkins
      SET status = 'completed',
          shown_at = COALESCE(shown_at, CURRENT_TIMESTAMP),
          acknowledged_at = COALESCE(acknowledged_at, CURRENT_TIMESTAMP),
          delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
          completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
          delivery_attempts = COALESCE(delivery_attempts, 0) + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [row.id]);
    await cancelPendingChildrenForParent(db, {
      userId,
      parentReminderId: row.id,
      reason: 'parent_opened',
    });
  } else {
    await db.run(`
      UPDATE scheduled_checkins
      SET status = CASE WHEN status IN ('scheduled', 'due') THEN 'sent' ELSE status END,
          shown_at = COALESCE(shown_at, CURRENT_TIMESTAMP),
          acknowledged_at = COALESCE(acknowledged_at, CURRENT_TIMESTAMP),
          delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
          delivery_attempts = COALESCE(delivery_attempts, 0) + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [row.id]);
  }

  const updated = await getReminderRow(db, { userId, itemId });
  return {
    item: serializeReminderItem(updated),
    row: updated,
    shouldInsertMessage,
  };
}

export async function cancelFutureItemsForProfile(db, { userId, profileId, reason = 'cancelled' }) {
  return db.run(`
    UPDATE scheduled_checkins
    SET status = 'cancelled',
        dismissed_at = COALESCE(dismissed_at, CURRENT_TIMESTAMP),
        failed_reason = COALESCE(failed_reason, ?),
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
      AND profile_id = ?
      AND status IN ('scheduled', 'pending_trigger', 'due', 'sent', 'missed')
  `, [reason, userId, profileId]);
}

export async function activateTriggeredCheckins(db, { userId = null, profileId = null } = {}) {
  const params = [];
  const clauses = [
    "child.status = 'pending_trigger'",
    "datetime(child.scheduled_for) <= datetime('now')",
    "LOWER(COALESCE(child.metadata_json, '')) LIKE '%\"triggercondition\":\"parent_reminder_unopened\"%'",
  ];

  if (userId) {
    clauses.push('child.user_id = ?');
    params.push(userId);
  }

  if (profileId) {
    clauses.push('child.profile_id = ?');
    params.push(profileId);
  }

  const rows = await db.all(`
    SELECT child.id AS child_id,
           child.user_id,
           child.profile_id,
           child.metadata_json AS child_metadata_json,
           parent.id AS parent_id,
           parent.status AS parent_status,
           parent.acknowledged_at AS parent_acknowledged_at,
           parent.delivered_at AS parent_delivered_at,
           parent.completed_at AS parent_completed_at,
           parent.dismissed_at AS parent_dismissed_at
    FROM scheduled_checkins child
    LEFT JOIN scheduled_checkins parent
      ON parent.id = json_extract(child.metadata_json, '$.parentReminderId')
    WHERE ${clauses.join(' AND ')}
    LIMIT 100
  `, params);

  let changes = 0;
  for (const row of rows) {
    const parentHandled = !row.parent_id ||
      row.parent_acknowledged_at ||
      row.parent_delivered_at ||
      row.parent_completed_at ||
      row.parent_dismissed_at ||
      ['completed', 'cancelled'].includes(row.parent_status);

    if (parentHandled) {
      const result = await db.run(`
        UPDATE scheduled_checkins
        SET status = 'cancelled',
            dismissed_at = COALESCE(dismissed_at, CURRENT_TIMESTAMP),
            failed_reason = COALESCE(failed_reason, 'parent_handled_before_followup'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending_trigger'
      `, [row.child_id]);
      changes += result?.changes || 0;
      if (result?.changes) {
        await auditReminderLifecycle(db, {
          userId: row.user_id,
          profileId: row.profile_id,
          action: 'reminder_followup_checkin_cancelled',
          metadata: { parentReminderId: row.parent_id, childCheckinId: row.child_id },
        });
      }
      continue;
    }

    const result = await db.run(`
      UPDATE scheduled_checkins
      SET status = 'due',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending_trigger'
    `, [row.child_id]);
    changes += result?.changes || 0;
    if (result?.changes) {
      await auditReminderLifecycle(db, {
        userId: row.user_id,
        profileId: row.profile_id,
        action: 'reminder_followup_checkin_activated',
        metadata: { parentReminderId: row.parent_id, childCheckinId: row.child_id },
      });
    }
  }

  return { changes };
}

export async function createDueEngagementCheckins(db, { userId = null, profileId = null, limit = 10 } = {}) {
  if (!AUTO_ENGAGEMENT_CHECKINS_ENABLED) {
    return { changes: 0, skipped: 'auto_engagement_checkins_disabled' };
  }

  const params = [];
  const clauses = [];

  if (userId) {
    clauses.push('p.user_id = ?');
    params.push(userId);
  }

  if (profileId) {
    clauses.push('p.id = ?');
    params.push(profileId);
  }

  params.push(Math.max(1, Math.min(Number(limit) || 10, 25)));

  const rows = await db.all(`
    SELECT p.*,
           ps.structured_profile_json,
           ps.profile_summary_text,
           ps.timezone,
           ps.created_at AS state_created_at,
           ps.updated_at AS state_updated_at,
           (
             SELECT MAX(m.created_at)
             FROM messages m
             WHERE m.profile_id = p.id
           ) AS last_chat_at,
           (
             SELECT MAX(COALESCE(sc.completed_at, sc.updated_at))
             FROM scheduled_checkins sc
             WHERE sc.profile_id = p.id
               AND LOWER(COALESCE(sc.metadata_json, '')) LIKE '%"kind":"checkin"%'
               AND sc.response IS NOT NULL
           ) AS last_progress_at,
           (
             SELECT MAX(sc.created_at)
             FROM scheduled_checkins sc
             WHERE sc.profile_id = p.id
               AND LOWER(COALESCE(sc.metadata_json, '')) LIKE '%"checkinsource":"engagement"%'
           ) AS last_engagement_at,
           (
             SELECT COUNT(*)
             FROM scheduled_checkins sc
             WHERE sc.profile_id = p.id
               AND sc.status IN ('scheduled', 'pending_trigger', 'due', 'sent')
               AND LOWER(COALESCE(sc.metadata_json, '')) LIKE '%"checkinsource":"engagement"%'
           ) AS active_engagement_count
    FROM profiles p
    LEFT JOIN patient_states ps ON ps.profile_id = p.id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    LIMIT ?
  `, params);

  let changes = 0;
  const now = Date.now();
  for (const row of rows) {
    if (Number(row.active_engagement_count || 0) > 0) continue;

    const structured = safeJson(row.structured_profile_json, {});
    const profile = { ...row, ...structured };
    const concernText = [
      structured.current_concern,
      structured.concern,
      structured.concern_summary,
      structured.category,
      structured.primaryCategory,
      row.category,
      row.profile_summary_text,
      ...(Array.isArray(structured.goals) ? structured.goals : []),
      ...(Array.isArray(structured.conditions) ? structured.conditions : []),
    ].filter(Boolean).join(' ').trim();
    if (!concernText) continue;

    const taxonomy = inferCheckinTaxonomy({
      title: [
        structured.category,
        structured.concern,
        structured.concern_summary,
        row.profile_summary_text,
        ...(Array.isArray(structured.goals) ? structured.goals : []),
        ...(Array.isArray(structured.conditions) ? structured.conditions : []),
      ].join(' '),
      metadata: structured,
      profile,
    });
    const policy = getTaxonomyPolicy(taxonomy);
    const thresholdMs = ENGAGEMENT_IDLE_MINUTES * 60 * 1000;
    const cooldownMs = Math.max(ENGAGEMENT_COOLDOWN_MINUTES, Math.min(policy.engagementHours * 60, 720)) * 60 * 1000;
    const lastProgressAt = parseDateMs(row.last_progress_at || row.state_created_at || row.created_at);
    const lastChatAt = parseDateMs(row.last_chat_at || row.state_updated_at || row.state_created_at || row.created_at);
    const lastEngagementAt = parseDateMs(row.last_engagement_at);

    if (!lastChatAt || now - lastChatAt < thresholdMs) continue;
    if (lastProgressAt && now - lastProgressAt < thresholdMs) continue;
    if (lastEngagementAt && now - lastEngagementAt < cooldownMs) continue;

    const engagementPlan = await planEngagementCheckin({
      profile,
      patientState: row,
      taxonomy,
      idleMinutes: Math.round((now - lastChatAt) / 60_000),
      timeZone: row.timezone,
    });
    if (!engagementPlan?.shouldSchedule) continue;

    const scheduledFor = new Date(now + engagementPlan.delayMinutes * 60_000).toISOString();

    const record = await buildEngagementCheckinRecord({
      userId: row.user_id,
      profile,
      patientState: row,
      taxonomy,
      scheduledFor,
      engagementPlan,
    });
    await insertScheduledCheckin(db, record);
    changes += 1;
    await auditReminderLifecycle(db, {
      userId: row.user_id,
      profileId: row.id,
      action: 'engagement_checkin_created',
      metadata: {
        checkinId: record.id,
        taxonomy,
        idleMinutes: Math.round((now - lastChatAt) / 60_000),
        scheduledFor,
        delayMinutes: engagementPlan.delayMinutes,
        plannerReason: engagementPlan.reason,
      },
    });
  }

  return { changes };
}

async function cancelPendingChildrenForParent(db, { userId, parentReminderId, reason }) {
  const result = await db.run(`
    UPDATE scheduled_checkins
    SET status = 'cancelled',
        dismissed_at = COALESCE(dismissed_at, CURRENT_TIMESTAMP),
        failed_reason = COALESCE(failed_reason, ?),
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
      AND status = 'pending_trigger'
      AND json_extract(metadata_json, '$.parentReminderId') = ?
  `, [reason, userId, parentReminderId]);

  if (result?.changes) {
    await auditReminderLifecycle(db, {
      userId,
      profileId: null,
      action: 'reminder_followup_children_cancelled',
      metadata: { parentReminderId, changes: result.changes, reason },
    });
  }

  return result;
}

async function auditReminderLifecycle(db, { userId, profileId, action, metadata = {} }) {
  try {
    await db.run(`
      INSERT INTO audit_logs (id, user_id, profile_id, action, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `, [
      cryptoRandomId(),
      userId || null,
      profileId || null,
      action,
      JSON.stringify({ ...metadata, at: new Date().toISOString() }),
    ]);
  } catch (error) {
    console.warn('[ReminderLifecycleAudit] failed:', error.message);
  }
}

function cryptoRandomId() {
  return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function parseDateMs(value) {
  if (!value) return null;
  const raw = String(value);
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? raw
    : raw.replace(' ', 'T') + 'Z';
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export async function buildReminderStatusMessage(db, { userId, profileId, profile = {} }) {
  const items = await listReminderItems(db, {
    userId,
    profileId,
    status: 'active',
    limit: 8,
    markDue: true,
  });
  const name = profile?.name || 'this profile';
  const isSelf = isSelfProfile(profile);

  if (!items.length) {
    return isSelf
      ? "I checked the saved schedule, and there are no active reminders or check-ins right now. We can set one whenever it would actually help. 🌿"
      : `I checked the saved schedule, and there are no active reminders or check-ins for ${name} right now. We can set one whenever it would actually help. 🌿`;
  }

  const lines = items.slice(0, 6).map(item => {
    const label = item.kind === 'reminder' ? 'reminder' : 'check-in';
    return `- **${item.title || item.displayTitle || label}** (${label}): ${item.formattedDueText || item.displayBody || 'scheduled'}`;
  });

  const intro = isSelf
    ? "Yes, here’s what’s actually saved in your schedule:"
    : `Yes, here’s what’s actually saved for ${name}:`;

  return `${intro}\n\n${lines.join('\n')}\n\nWhen any item is due, it’ll become openable from the notification bell.`;
}

export async function updateLatestReminderText(db, {
  userId,
  profileId,
  correction = {},
  originalMessage = '',
} = {}) {
  const row = await db.get(`
    SELECT sc.*, p.name AS profile_name
    FROM scheduled_checkins sc
    JOIN profiles p ON p.id = sc.profile_id
    WHERE sc.user_id = ?
      AND sc.profile_id = ?
      AND sc.status IN ('scheduled', 'due', 'sent')
      AND (
        sc.response_options_json = '[]'
        OR LOWER(COALESCE(sc.metadata_json, '')) LIKE '%"kind":"reminder"%'
        OR LOWER(COALESCE(sc.metadata_json, '')) LIKE '%"kind": "reminder"%'
      )
    ORDER BY datetime(sc.created_at) DESC
    LIMIT 1
  `, [userId, profileId]);

  if (!row) {
    return {
      success: false,
      assistantMessage: "I checked the saved schedule, but I don't see an active reminder to edit yet. Tell me the reminder and time again, and I'll save it properly. 🌿",
    };
  }

  const oldTitle = row.title || 'Reminder';
  const nextTitle = buildCorrectedTitle(oldTitle, correction);
  if (!nextTitle) {
    return {
      success: false,
      assistantMessage: "I can update it, I just need the exact wording. For example: “change cook daat to cook daal.”",
    };
  }

  const metadata = {
    ...safeJson(row.metadata_json, {}),
    correctionHistory: [
      ...(safeJson(row.metadata_json, {}).correctionHistory || []),
      {
        from: oldTitle,
        to: nextTitle,
        oldText: correction.oldText || null,
        newText: correction.newText || null,
        sourceText: originalMessage || null,
        correctedAt: new Date().toISOString(),
      },
    ].slice(-5),
  };
  const detailedChatMessage = buildReminderDetailMessage(nextTitle);

  await db.run(`
    UPDATE scheduled_checkins
    SET title = ?,
        push_title = ?,
        in_app_title = ?,
        detailed_chat_message = ?,
        metadata_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    nextTitle,
    `${nextTitle} 🌿`,
    `${nextTitle} scheduled 🌿`,
    detailedChatMessage,
    JSON.stringify(metadata),
    row.id,
  ]);

  const updated = await getReminderRow(db, { userId, itemId: row.id });
  const item = serializeReminderItem(updated);

  return {
    success: true,
    item,
    assistantMessage: `Done, updated it 🌿\n\nReminder: **${nextTitle}**\n${item.formattedDueText || formatDueText(item.scheduledFor, item.metadata?.timezone)}`,
  };
}

export async function updateReminderItem(db, {
  userId,
  profileId,
  itemId = null,
  title = null,
  scheduledFor = null,
  timeZone = null,
  sourceText = '',
} = {}) {
  const row = itemId
    ? await db.get(`
        SELECT sc.*, p.name AS profile_name
        FROM scheduled_checkins sc
        JOIN profiles p ON p.id = sc.profile_id
        WHERE sc.id = ? AND sc.user_id = ? AND sc.profile_id = ?
      `, [itemId, userId, profileId])
    : await db.get(`
        SELECT sc.*, p.name AS profile_name
        FROM scheduled_checkins sc
        JOIN profiles p ON p.id = sc.profile_id
        WHERE sc.user_id = ?
          AND sc.profile_id = ?
          AND sc.status IN ('scheduled', 'due', 'sent')
          AND (
            sc.response_options_json = '[]'
            OR LOWER(COALESCE(sc.metadata_json, '')) LIKE '%"kind":"reminder"%'
            OR LOWER(COALESCE(sc.metadata_json, '')) LIKE '%"kind": "reminder"%'
          )
        ORDER BY datetime(sc.created_at) DESC
        LIMIT 1
      `, [userId, profileId]);

  if (!row) {
    return {
      success: false,
      reason: 'not_found',
      assistantMessage: "I checked the saved schedule, but I don't see an active reminder to update yet. Tell me the reminder and time again, and I'll save it properly. 🌿",
    };
  }

  const metadata = {
    ...safeJson(row.metadata_json, {}),
    timezone: resolveTimeZone(timeZone, safeJson(row.metadata_json, {}).timezone),
    updateHistory: [
      ...(safeJson(row.metadata_json, {}).updateHistory || []),
      {
        fromTitle: row.title,
        toTitle: title || row.title,
        fromScheduledFor: row.scheduled_for,
        toScheduledFor: scheduledFor || row.scheduled_for,
        sourceText: sourceText || null,
        updatedAt: new Date().toISOString(),
      },
    ].slice(-5),
  };

  const nextTitle = title ? titleCaseReminder(title) : row.title;
  const nextScheduledFor = scheduledFor || row.scheduled_for;

  await db.run(`
    UPDATE scheduled_checkins
    SET title = ?,
        push_title = ?,
        in_app_title = ?,
        in_app_body = ?,
        detailed_chat_message = ?,
        scheduled_for = ?,
        status = CASE WHEN status IN ('due', 'sent') AND datetime(?) > datetime('now') THEN 'scheduled' ELSE status END,
        metadata_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    nextTitle,
    `${nextTitle} 🌿`,
    `${nextTitle} scheduled 🌿`,
    `Scheduled for ${formatDueText(nextScheduledFor, metadata.timezone)}.`,
    buildReminderDetailMessage(nextTitle),
    nextScheduledFor,
    nextScheduledFor,
    JSON.stringify(metadata),
    row.id,
  ]);

  const updated = await getReminderRow(db, { userId, itemId: row.id });
  const item = serializeReminderItem(updated);
  return {
    success: true,
    item,
    assistantMessage: `Done, updated it 🌿\n\nReminder: **${item.title}**\n${item.formattedDueText || formatDueText(item.scheduledFor, metadata.timezone)}`,
  };
}

export async function cancelReminderItem(db, {
  userId,
  profileId,
  itemId = null,
  targetText = '',
  reason = 'user_cancelled',
} = {}) {
  const params = [userId, profileId];
  let targetClause = '';
  if (itemId) {
    targetClause = 'AND sc.id = ?';
    params.push(itemId);
  } else if (targetText) {
    targetClause = 'AND LOWER(sc.title) LIKE ?';
    params.push(`%${String(targetText).toLowerCase().trim()}%`);
  }

  const rows = await db.all(`
    SELECT sc.*, p.name AS profile_name
    FROM scheduled_checkins sc
    JOIN profiles p ON p.id = sc.profile_id
    WHERE sc.user_id = ?
      AND sc.profile_id = ?
      AND sc.status IN ('scheduled', 'due', 'sent')
      AND (
        sc.response_options_json = '[]'
        OR LOWER(COALESCE(sc.metadata_json, '')) LIKE '%"kind":"reminder"%'
        OR LOWER(COALESCE(sc.metadata_json, '')) LIKE '%"kind": "reminder"%'
      )
      ${targetClause}
    ORDER BY datetime(sc.scheduled_for) ASC
    LIMIT 3
  `, params);

  if (!rows.length) {
    return {
      success: false,
      reason: 'not_found',
      assistantMessage: "I checked the saved schedule, but I don't see an active matching reminder to cancel. 🌿",
    };
  }

  if (!itemId && !targetText && rows.length > 1) {
    return {
      success: false,
      reason: 'ambiguous',
      needsClarification: true,
      items: rows.map(serializeReminderItem),
      assistantMessage: `I found a few active reminders. Which one should we cancel?\n\n${rows.map(row => `- ${row.title} (${formatDueText(row.scheduled_for, safeJson(row.metadata_json, {}).timezone)})`).join('\n')}`,
    };
  }

  const row = rows[0];
  await db.run(`
    UPDATE scheduled_checkins
    SET status = 'cancelled',
        dismissed_at = COALESCE(dismissed_at, CURRENT_TIMESTAMP),
        failed_reason = COALESCE(failed_reason, ?),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [reason, row.id]);
  await cancelPendingChildrenForParent(db, {
    userId,
    parentReminderId: row.id,
    reason: 'parent_cancelled',
  });

  const updated = await getReminderRow(db, { userId, itemId: row.id });
  const item = serializeReminderItem(updated);
  return {
    success: true,
    item,
    assistantMessage: `Cancelled it 🌿\n\nReminder: **${row.title}**`,
  };
}

export function serializeReminderItem(row) {
  if (!row) return null;
  const metadata = safeJson(row.metadata_json, {});
  const kind = metadata.kind || 'checkin';
  const category = row.category || metadata.category || metadata.goalType || metadata.reminderType || row.type;
  const display = buildNotificationDisplay(row, metadata);

  return {
    id: row.id,
    userId: row.user_id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    goalId: row.goal_id,
    relation: row.relation,
    kind,
    category,
    type: row.type,
    status: row.status,
    channel: row.channel || metadata.channel || 'in_app',
    source: row.source || metadata.source || 'wellness_chat',
    scheduledFor: row.scheduled_for,
    deliveredAt: row.delivered_at,
    shownAt: row.shown_at,
    acknowledgedAt: row.acknowledged_at,
    dismissedAt: row.dismissed_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    failedReason: row.failed_reason,
    deliveryAttempts: row.delivery_attempts || 0,
    seriesId: row.series_id || metadata.seriesId || null,
    title: row.title,
    body: row.in_app_body || row.push_body,
    pushTitle: row.push_title,
    pushBody: row.push_body,
    inAppTitle: row.in_app_title,
    inAppBody: row.in_app_body,
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

  if (row.status === 'pending_trigger') {
    return {
      state: 'hidden',
      canOpen: false,
      title: row.in_app_title || row.title || 'Check-in',
      body: row.in_app_body || 'Waiting for the right moment.',
      meta: 'Hidden',
    };
  }

  if (row.status === 'completed') {
    return {
      state: 'completed',
      canOpen: false,
      title: 'Logged 🌿',
      body: 'Updated today.',
      meta: row.completed_at ? `Updated ${formatTime(row.completed_at, metadata.timezone)}` : 'Completed',
    };
  }

  if (row.status === 'cancelled') {
    return {
      state: 'cancelled',
      canOpen: false,
      title: 'Cancelled',
      body: 'This item is no longer active.',
      meta: 'Cancelled',
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
    body: row.in_app_body || 'Scheduled around your day.',
    meta: formatDueText(row.scheduled_for, metadata.timezone),
  };
}

function buildScheduledTitle(row, metadata = {}) {
  const title = row.title || (metadata.kind === 'reminder' ? 'Reminder' : 'Check-in');
  return `${title} scheduled ${titleEmoji(title, metadata)}`;
}

function buildDueTitle(row, metadata = {}) {
  const kind = metadata.kind || 'checkin';
  const profileName = row.profile_name || 'this profile';
  const isSelf = isSelfProfile(row);
  const title = row.title || (kind === 'reminder' ? 'Reminder' : 'Check-in');

  if (kind === 'reminder') {
    return isSelf
      ? `Time for your ${title.toLowerCase()} ${titleEmoji(title, metadata)}`
      : `Time for ${profileName}'s ${title.toLowerCase()} ${titleEmoji(title, metadata)}`;
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
  const owner = isSelf ? 'your' : `${profileName}'s`;
  if (/sleep|wind/.test(taxonomy)) return isSelf ? 'Morning sleep detective moment 🌙' : `Sleep detective moment for ${profileName} 🌙`;
  if (/medicine|medication|pill|dose/.test(taxonomy)) return isSelf ? 'Quick medicine follow-up 💊' : `Medicine follow-up for ${profileName} 💊`;
  if (/water|hydrat/.test(taxonomy)) return isSelf ? 'Sip check, no pressure 💧' : `Sip check for ${profileName} 💧`;
  if (/meal|food|nutrition|cook/.test(taxonomy)) return isSelf ? 'Meal check, real life edition 🍽️' : `Meal check for ${profileName} 🍽️`;
  if (/recover|symptom|pain|stomach|health/.test(taxonomy)) return isSelf ? 'Tiny health check 🙂' : `Tiny health check for ${profileName} 🙂`;
  if (/habit|stress|movement/.test(taxonomy)) return isSelf ? 'Reality check, kindly 😄' : `Reality check for ${profileName} 😄`;
  return `Time for ${owner} check-in ✨`;
}

function titleEmoji(title = '', metadata = {}) {
  const text = `${title} ${metadata.reminderType || ''} ${metadata.goalType || ''}`.toLowerCase();
  if (/sleep|wind|bed/.test(text)) return '🌙';
  if (/water|hydration/.test(text)) return '🌊';
  if (/walk|movement|exercise|stretch/.test(text)) return '🚶';
  if (/medicine|medication|tablet|pill/.test(text)) return '💊';
  if (/meal|food|nutrition/.test(text)) return '🍽️';
  if (/habit|routine/.test(text)) return '🌱';
  return '🌿';
}

function buildCorrectedTitle(oldTitle = '', correction = {}) {
  const newText = String(correction.newText || '').trim();
  const oldText = String(correction.oldText || '').trim();
  let next = oldTitle;

  if (oldText && newText) {
    const escaped = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    next = pattern.test(next) ? next.replace(pattern, newText) : newText;
  } else if (newText) {
    next = newText;
  } else {
    return null;
  }

  return titleCaseReminder(next);
}

function titleCaseReminder(value = '') {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function buildReminderDetailMessage(title) {
  return `**${title}** 🌿\n\nA gentle reminder for the task you set. No pressure, just a nudge.`;
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

export function formatDueText(value, timeZone) {
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

function isSelfProfile(profile = {}) {
  const relation = String(profile.relation || profile.relationToUser || '').trim().toLowerCase();
  return relation === 'self' || relation === 'myself';
}
