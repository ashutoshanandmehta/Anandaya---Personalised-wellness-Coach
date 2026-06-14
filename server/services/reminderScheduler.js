import { getDb } from '../db.js';
import { countSoonScheduledItems, markDueScheduledItems } from './reminderToolService.js';

const DEFAULT_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 60_000);
const FAST_INTERVAL_MS = 15_000; // 15 seconds for short-term reminders

let schedulerHandle = null;
let isRunning = false;
let currentIntervalMs = DEFAULT_INTERVAL_MS;

export function startReminderScheduler({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (schedulerHandle) return schedulerHandle;
  currentIntervalMs = intervalMs;

  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const db = await getDb();
      const result = await markDueScheduledItems(db, { createEngagement: true });
      if (result?.changes) {
        console.log(`[Scheduler] Marked ${result.changes} check-in${result.changes === 1 ? '' : 's'} due.`);
      }

      // Adaptive polling: check if any reminders are due soon (within 5 min)
      const soonCount = await countSoonScheduledItems(db, 5);
      const desiredInterval = soonCount > 0 ? FAST_INTERVAL_MS : DEFAULT_INTERVAL_MS;

      if (desiredInterval !== currentIntervalMs) {
        currentIntervalMs = desiredInterval;
        clearInterval(schedulerHandle);
        schedulerHandle = setInterval(tick, currentIntervalMs);
        schedulerHandle.unref?.();
        console.log(`[Scheduler] Switched to ${currentIntervalMs / 1000}s polling (${soonCount} reminder${soonCount === 1 ? '' : 's'} due soon).`);
      }
    } catch (error) {
      console.error('[Scheduler] Failed to process due check-ins:', error.message);
    } finally {
      isRunning = false;
    }
  };

  schedulerHandle = setInterval(tick, currentIntervalMs);
  schedulerHandle.unref?.();
  tick();
  return schedulerHandle;
}

export async function markDueScheduledCheckins(db) {
  return markDueScheduledItems(db);
}
