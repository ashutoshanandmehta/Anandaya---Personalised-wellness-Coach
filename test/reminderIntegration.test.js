/**
 * End-to-end DB test for the sleep-alarm write path.
 *
 * Uses a throwaway SQLite file so it exercises the REAL schema bootstrap,
 * the REAL createScheduledItemsFromOffers write, and the REAL
 * listReminderItems query that powers GET /api/reminders?status=active.
 *
 * DATABASE_PATH must be set before db.js is imported (it reads the path at
 * module-eval time), so we set it first and use dynamic import().
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `anandaya-test-${randomUUID()}.db`);
process.env.DATABASE_PATH = TMP_DB;

let getDb, createScheduledItemsFromOffers, listReminderItems, planSleepAlarms;
let db;
const userId = `user_${randomUUID()}`;
const profileId = `prof_${randomUUID()}`;
const profile = { id: profileId, name: 'Test Sleeper', relation: 'self' };

before(async () => {
  ({ getDb } = await import('../server/db.js'));
  ({ createScheduledItemsFromOffers, listReminderItems } = await import('../server/services/reminderToolService.js'));
  ({ planSleepAlarms } = await import('../server/services/sleepAlarmFlow.js'));

  db = await getDb();
  await db.run('INSERT INTO users (id, email) VALUES (?, ?)', [userId, `${userId}@test.local`]);
  await db.run(
    'INSERT INTO profiles (id, user_id, name, relation) VALUES (?, ?, ?, ?)',
    [profileId, userId, profile.name, profile.relation]
  );
});

after(async () => {
  try { await db?.close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
});

test('"10 PM and 6 AM" creates exactly two recurring reminder rows in scheduled_checkins', async () => {
  const { offers } = planSleepAlarms({ message: '10 PM and 6 AM', timezone: 'Asia/Kolkata' });
  assert.equal(offers.length, 2);

  await createScheduledItemsFromOffers(db, { userId, profile, offers });

  const rows = await db.all(
    `SELECT title, status, scheduled_for, metadata_json FROM scheduled_checkins WHERE profile_id = ? ORDER BY title`,
    [profileId]
  );
  assert.equal(rows.length, 2, 'exactly two rows (no surprise follow-up check-ins)');

  const bedtime = rows.find(r => r.title === 'Bedtime alarm');
  const wake = rows.find(r => r.title === 'Wake-up alarm');
  assert.ok(bedtime, 'Bedtime alarm row exists');
  assert.ok(wake, 'Wake-up alarm row exists');

  for (const row of rows) {
    assert.equal(row.status, 'scheduled');
    const meta = JSON.parse(row.metadata_json);
    assert.equal(meta.kind, 'reminder');
    assert.equal(meta.cadence, 'recurring');
    assert.ok(meta.timezone, 'timezone persisted');
    assert.ok(/^\d{1,2} \d{1,2} \* \* \*$/.test(meta.cron), `daily cron present: ${meta.cron}`);
    assert.ok(new Date(row.scheduled_for).getTime() > Date.now(), 'scheduled_for is a future UTC time');
  }

  assert.equal(JSON.parse(bedtime.metadata_json).cron, '0 22 * * *');
  assert.equal(JSON.parse(wake.metadata_json).cron, '0 6 * * *');
});

test('listReminderItems(status=active) returns the created alarms (the /api/reminders path)', async () => {
  const items = await listReminderItems(db, { userId, profileId, status: 'active' });
  const titles = items.map(i => i.title).sort();
  assert.deepEqual(titles, ['Bedtime alarm', 'Wake-up alarm']);
  for (const item of items) {
    assert.equal(item.kind, 'reminder');
  }
});
