import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectConversationalSchedulingTurn,
  assistantProposedSchedule,
  messageHasTime,
  messageIsAffirmation,
} from '../server/services/schedulingContext.js';

// The exact bug from the report: assistant proposes a reminder summary with
// times, user says "yes, everything is correct" — must route to the orchestrator.
const reminderSummaryTurn = [
  { role: 'user', content: 'okay, wind down at 11 PM' },
  {
    role: 'assistant',
    content:
      'Reminder summary\nWind-down (calm activity) 11 PM\nBedtime cue (in bed) 11:30 PM\nMorning wake-up 6 AM\nI’ll pass these times to the app. Is everything correct?',
  },
];

test('"yes, everything is correct" after a reminder summary routes to orchestrator', () => {
  assert.equal(
    detectConversationalSchedulingTurn({ message: 'yes, everything is correct', history: reminderSummaryTurn }),
    true
  );
});

test('"okay, wind down at 11 PM" after a schedule proposal routes to orchestrator', () => {
  const history = [
    { role: 'assistant', content: 'Pick a bedtime window, e.g. 9:30–10:00 PM. Want a wind-down reminder?' },
  ];
  assert.equal(detectConversationalSchedulingTurn({ message: 'okay, wind down at 11 PM', history }), true);
});

test('affirmation with NO prior schedule proposal does NOT route (avoid false positives)', () => {
  const history = [{ role: 'assistant', content: 'Drinking water through the day is a great habit.' }];
  assert.equal(detectConversationalSchedulingTurn({ message: 'yes, definitely', history }), false);
});

test('bare time with no prior schedule proposal does NOT route', () => {
  const history = [{ role: 'assistant', content: 'How has your energy been lately?' }];
  assert.equal(detectConversationalSchedulingTurn({ message: 'around 11 PM I crash', history }), false);
});

test('empty history does not throw and returns false', () => {
  assert.equal(detectConversationalSchedulingTurn({ message: 'yes', history: [] }), false);
});

test('assistantProposedSchedule needs both a schedule word and a time', () => {
  assert.equal(assistantProposedSchedule('I’ll set a reminder for 8 PM'), true);
  assert.equal(assistantProposedSchedule('Let’s talk about your sleep'), false); // word, no time
  assert.equal(assistantProposedSchedule('See you at 8 PM'), false); // time, no schedule word
});

test('messageHasTime detects common clock formats', () => {
  assert.equal(messageHasTime('10 PM and 6 AM'), true);
  assert.equal(messageHasTime('22:00'), true);
  assert.equal(messageHasTime('at 9'), true);
  assert.equal(messageHasTime('sometime soon'), false);
});

test('messageIsAffirmation only matches leading affirmations', () => {
  assert.equal(messageIsAffirmation('yes, everything is correct'), true);
  assert.equal(messageIsAffirmation('sounds good'), true);
  assert.equal(messageIsAffirmation('no, change the time'), false);
  assert.equal(messageIsAffirmation('I was going to say yes'), false);
});
