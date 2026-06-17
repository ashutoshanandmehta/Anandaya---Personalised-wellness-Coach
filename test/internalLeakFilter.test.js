import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterLLMOutput } from '../server/services/postGenerationFilter.js';

// The exact leak from the bug report: the model echoed its hidden context as a
// "Compact Context Summary" bubble instead of answering the user.
const LEAKED_SUMMARY = `**Compact Context Summary**

- Name: Anandaya (profile for "boss")
- Age: 23 years
- Sex assigned at birth: Male
- Height: 170 cm
- Weight: 70 kg
- Timezone: Asia/Kolkata
- Current concern: not yet specified
- Program status: Day 0 (setup phase)`;

test('a whole-response Compact Context Summary leak is replaced, never shown', () => {
  const result = filterLLMOutput(LEAKED_SUMMARY, {});
  assert.equal(result.safe, true);
  assert.ok(!/Compact Context Summary/i.test(result.cleaned), 'header removed');
  assert.ok(!/Age:\s*23/i.test(result.cleaned), 'snapshot bullets removed');
  assert.ok(!/Asia\/Kolkata/i.test(result.cleaned), 'timezone removed');
  assert.ok(result.violations.includes('internal_context_leak_removed'));
});

test('a strong header mixed with prose still discards the whole contaminated reply', () => {
  const mixed = `Here is what I know.\n\nPROFILE SNAPSHOT\n- Height: 170 cm\n- Weight: 70 kg`;
  const result = filterLLMOutput(mixed, {});
  assert.ok(!/PROFILE SNAPSHOT/i.test(result.cleaned));
  assert.ok(!/170 cm/i.test(result.cleaned));
  assert.ok(result.violations.includes('internal_context_leak_removed'));
});

test('a custom emptyFallback is used when the whole reply is a leak', () => {
  const result = filterLLMOutput(LEAKED_SUMMARY, { emptyFallback: 'What would you like to focus on today?' });
  assert.equal(result.cleaned, 'What would you like to focus on today?');
});

test('a normal coaching reply is left untouched (no false positive)', () => {
  const normal = 'Thanks for sharing! Winding down before bed really helps. Want to try dimming the lights an hour before sleep?';
  const result = filterLLMOutput(normal, {});
  assert.equal(result.cleaned.trim(), normal);
  assert.ok(!result.violations.includes('internal_context_leak_removed'));
});

test('a stray internal field line is stripped without nuking the useful reply', () => {
  const partial = 'That sounds tough, and rest will help.\n\nTimezone: Asia/Kolkata';
  const result = filterLLMOutput(partial, {});
  assert.ok(/rest will help/i.test(result.cleaned), 'useful content kept');
  assert.ok(!/Asia\/Kolkata/i.test(result.cleaned), 'stray internal line removed');
  assert.ok(result.violations.includes('internal_context_leak_removed'));
});
