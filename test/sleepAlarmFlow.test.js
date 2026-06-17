import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAlarmSetupIntent,
  parseTwoTimes,
  planSleepAlarms,
  buildSleepAlarmOffers,
  formatLocalClock,
} from '../server/services/sleepAlarmFlow.js';

const TZ = 'Asia/Kolkata';
const FROM = new Date('2026-06-17T00:00:00.000Z'); // fixed reference for determinism

// ── detectAlarmSetupIntent ──────────────────────────────────────

test('detects "yes go ahead with the alarms" as alarm setup', () => {
  assert.equal(detectAlarmSetupIntent('yes go ahead with the alarms').isAlarmSetup, true);
});

test('detects "no, just keep these alarms" as alarm setup (must not reach LLM)', () => {
  assert.equal(detectAlarmSetupIntent('no, just keep these alarms').isAlarmSetup, true);
});

test('detects a named bedtime alarm as setup', () => {
  assert.equal(detectAlarmSetupIntent('set a bedtime alarm').isAlarmSetup, true);
});

test('does NOT treat a passing alarm mention as setup', () => {
  assert.equal(detectAlarmSetupIntent('the alarm this morning was really loud').isAlarmSetup, false);
});

test('does NOT treat a non-alarm reminder as alarm setup', () => {
  assert.equal(detectAlarmSetupIntent('remind me to drink water').isAlarmSetup, false);
});

// ── parseTwoTimes ───────────────────────────────────────────────

test('parses "10 PM 6 AM it works" into 22:00 and 06:00', () => {
  const r = parseTwoTimes('10 PM 6 AM it works');
  assert.equal(r.count, 2);
  assert.deepEqual(r.bedtime, { hour: 22, minute: 0 });
  assert.deepEqual(r.wakeup, { hour: 6, minute: 0 });
});

test('parses 24h "22:00 and 06:00"', () => {
  const r = parseTwoTimes('22:00 and 06:00');
  assert.deepEqual(r.bedtime, { hour: 22, minute: 0 });
  assert.deepEqual(r.wakeup, { hour: 6, minute: 0 });
});

test('bare "10 6" uses bedtime=PM / wake=AM heuristic', () => {
  const r = parseTwoTimes('10 6');
  assert.deepEqual(r.bedtime, { hour: 22, minute: 0 });
  assert.deepEqual(r.wakeup, { hour: 6, minute: 0 });
});

test('ignores non-time numbers / no-time messages', () => {
  assert.equal(parseTwoTimes('it works for me, thanks').count, 0);
});

// ── planSleepAlarms: offer contract ─────────────────────────────

test('"10 PM 6 AM it works" → two recurring reminder offers with correct cron', () => {
  const { offers, count } = planSleepAlarms({ message: '10 PM 6 AM it works', timezone: TZ, from: FROM });
  assert.equal(count, 2);
  assert.equal(offers.length, 2);

  const [bed, wake] = offers;
  // Bedtime
  assert.equal(bed.title, 'Bedtime alarm');
  assert.equal(bed.kind, 'reminder');
  assert.equal(bed.cadence, 'recurring');
  assert.equal(bed.metadata.kind, 'reminder');
  assert.equal(bed.metadata.cadence, 'recurring');
  assert.equal(bed.metadata.cron, '0 22 * * *');
  assert.equal(bed.metadata.timezone, TZ);
  assert.ok(new Date(bed.scheduledFor).getTime() > FROM.getTime(), 'bedtime scheduledFor is in the future');

  // Wake-up
  assert.equal(wake.title, 'Wake-up alarm');
  assert.equal(wake.metadata.kind, 'reminder');
  assert.equal(wake.metadata.cadence, 'recurring');
  assert.equal(wake.metadata.cron, '0 6 * * *');
  assert.ok(new Date(wake.scheduledFor).getTime() > FROM.getTime(), 'wake scheduledFor is in the future');
});

test('single "wake-up alarm at 6 am" → one wake-up offer', () => {
  const { offers, count } = planSleepAlarms({ message: 'set a wake-up alarm at 6 am', timezone: TZ, from: FROM });
  assert.equal(count, 1);
  assert.equal(offers[0].title, 'Wake-up alarm');
  assert.equal(offers[0].metadata.cron, '0 6 * * *');
});

test('single "bedtime alarm at 10 pm" → one bedtime offer', () => {
  const { offers, count } = planSleepAlarms({ message: 'set a bedtime alarm at 10 pm', timezone: TZ, from: FROM });
  assert.equal(count, 1);
  assert.equal(offers[0].title, 'Bedtime alarm');
  assert.equal(offers[0].metadata.cron, '0 22 * * *');
});

test('acceptance without a time → no offers (route must ask + persist pending)', () => {
  assert.equal(planSleepAlarms({ message: 'yes go ahead with the alarms', timezone: TZ, from: FROM }).count, 0);
});

test('offers carry skipAutoFollowup so exactly the alarms are created', () => {
  const { offers } = planSleepAlarms({ message: '10 PM and 6 AM', timezone: TZ, from: FROM });
  for (const o of offers) assert.equal(o.metadata.skipAutoFollowup, true);
});

// ── buildSleepAlarmOffers + formatLocalClock ────────────────────

test('buildSleepAlarmOffers handles 10:30 PM minute precision', () => {
  const [bed] = buildSleepAlarmOffers({ timezone: TZ, bedtime: { hour: 22, minute: 30 }, wakeup: null, from: FROM });
  assert.equal(bed.metadata.cron, '30 22 * * *');
  assert.equal(bed.metadata.localTime, '22:30');
});

test('formatLocalClock formats 24h to 12h clock', () => {
  assert.equal(formatLocalClock({ hour: 22, minute: 0 }), '10:00 PM');
  assert.equal(formatLocalClock({ hour: 6, minute: 0 }), '6:00 AM');
  assert.equal(formatLocalClock({ hour: 0, minute: 5 }), '12:05 AM');
});
