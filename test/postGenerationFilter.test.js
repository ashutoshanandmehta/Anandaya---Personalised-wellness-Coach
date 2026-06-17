import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterLLMOutput,
  HONEST_NO_SCHEDULE_REPLY,
} from '../server/services/postGenerationFilter.js';

// The observed hallucinations from the real bug report. On a schedulingForbidden
// turn (no tool actually saved anything) the filter must hard-replace the whole
// reply with the honest message — never leak a fabricated confirmation.
const FABRICATED_CONFIRMATIONS = [
  'Your bedtime alarm is set for 10 PM and your wake-up alarm for 6 AM.',
  'Your wake-up alarm is set for 6 AM.',
  "I'll forward the request to create the two alarms.",
  "I'll pass these times to the system.",
  "I'll create them for you now.",
  "I'll note them down for you.",
  "I've set a reminder for your bedtime.",
  'I have set your alarm for 10 PM.',
  'Both alarms are scheduled for 10 PM and 6 AM.',
  'Once the system confirms, they should appear in the left sidebar.',
];

for (const text of FABRICATED_CONFIRMATIONS) {
  test(`schedulingForbidden blocks: "${text.slice(0, 40)}..."`, () => {
    const result = filterLLMOutput(text, { schedulingForbidden: true });
    assert.equal(result.safe, false);
    assert.equal(result.cleaned, HONEST_NO_SCHEDULE_REPLY);
    assert.ok(result.violations.includes('false_scheduling_confirmation_blocked'));
  });
}

test('schedulingForbidden does NOT block benign wellness text', () => {
  const benign = "That's a great goal. Winding down before bed can really help — try dimming the lights an hour before sleep.";
  const result = filterLLMOutput(benign, { schedulingForbidden: true });
  assert.equal(result.safe, true);
  assert.equal(result.cleaned, benign);
});

test('schedulingForbidden allows an honest "nothing saved" admission', () => {
  const honest = "I haven't saved any alarms yet. What times would you like for bedtime and wake-up?";
  const result = filterLLMOutput(honest, { schedulingForbidden: true });
  assert.equal(result.safe, true);
});

test('without schedulingForbidden, false confirmation is a soft strip (not whole-reply replace)', () => {
  const mixed = "Sleep is so important. Your bedtime alarm is set for 10 PM. Try to keep screens away.";
  const result = filterLLMOutput(mixed, {});
  // Soft mode keeps the safe sentences and strips the offending one.
  assert.equal(result.safe, true);
  assert.ok(!/alarm is set/i.test(result.cleaned), 'offending sentence stripped');
  assert.ok(/Sleep is so important/.test(result.cleaned), 'benign content kept');
});

test('hard safety violations still block regardless of scheduling flag', () => {
  const dangerous = 'You should stop taking your medication.';
  const result = filterLLMOutput(dangerous, { schedulingForbidden: true });
  assert.equal(result.safe, false);
  assert.ok(result.violations.includes('unauthorized_dose_change'));
});

test('hard safety wins over the scheduling guard when both match', () => {
  // Dangerous medical advice AND a fabricated alarm confirmation in one reply.
  const combo = 'You should stop taking your medication. Your bedtime alarm is set for 10 PM.';
  const result = filterLLMOutput(combo, { schedulingForbidden: true });
  assert.equal(result.safe, false);
  // Must return the safety fallback, not the scheduling honest-reply.
  assert.ok(result.violations.includes('unauthorized_dose_change'));
  assert.ok(!result.violations.includes('false_scheduling_confirmation_blocked'));
});
