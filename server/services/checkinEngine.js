/**
 * Check-in Engine
 * Generates adaptive daily check-in questions based on protocol day and patient history.
 */

import { generateText } from './ai.js';

/**
 * Protocol phases with day ranges, descriptions, and focus areas.
 */
const PHASES = [
  {
    id: 'onboarding',
    name: 'Onboarding',
    emoji: '🌟',
    dayRange: [1, 1],
    description: 'Welcome and baseline assessment. Understand the patient\'s starting point, set expectations, and confirm goals.',
    focusAreas: ['establishing baseline habits', 'confirming wellness goals', 'understanding current routines', 'setting expectations for the program'],
  },
  {
    id: 'early',
    name: 'Early Adoption',
    emoji: '🌱',
    dayRange: [2, 3],
    description: 'First changes are being implemented. Focus on comfort, early barriers, and initial adherence.',
    focusAreas: ['initial adherence to new routines', 'comfort with changes', 'identifying early barriers', 'sleep tracking consistency', 'hydration habits'],
  },
  {
    id: 'building',
    name: 'Building Habits',
    emoji: '🔨',
    dayRange: [4, 7],
    description: 'Habits are forming. Focus on consistency, specific challenges, and small wins.',
    focusAreas: ['habit consistency', 'specific challenges encountered', 'celebrating small wins', 'sleep quality changes', 'movement routine adherence', 'meal timing'],
  },
  {
    id: 'momentum',
    name: 'Gaining Momentum',
    emoji: '📈',
    dayRange: [8, 14],
    description: 'Progress should be visible. Focus on reviewing patterns, adjustments, and deepening commitment.',
    focusAreas: ['progress review and pattern recognition', 'adjustments needed', 'deepening habits', 'stress management effectiveness', 'energy level changes', 'nutrition improvements'],
  },
  {
    id: 'sustaining',
    name: 'Sustaining',
    emoji: '🏆',
    dayRange: [15, 28],
    description: 'Habits are becoming natural. Focus on long-term sustainability, reflection, and celebrating progress.',
    focusAreas: ['long-term sustainability', 'reflecting on transformation', 'celebrating achievements', 'planning beyond the program', 'favorite new habits', 'overall wellbeing improvement'],
  },
];

/**
 * Determine the current phase based on the protocol day.
 */
function getPhase(day) {
  for (const phase of PHASES) {
    if (day >= phase.dayRange[0] && day <= phase.dayRange[1]) {
      return phase;
    }
  }
  return PHASES[PHASES.length - 1]; // Default to sustaining
}

/**
 * Generate adaptive check-in questions for a patient on a given day.
 * @param {object} profile - Patient profile
 * @param {number} day - Current day of protocol (1-28)
 * @param {Array} checkInHistory - Previous check-in records
 * @returns {object} Check-in data with questions
 */
export async function generateCheckIn(profile, day, checkInHistory = []) {
  const phase = getPhase(day);
  const patientName = profile.name || 'there';
  const goals = (profile.goals || []).join(', ') || 'general wellness';

  // Summarize previous check-ins for context
  let previousContext = 'No previous check-ins yet.';
  if (checkInHistory.length > 0) {
    const recentCheckins = checkInHistory.slice(-3);
    previousContext = recentCheckins
      .map((ci) => `Day ${ci.day} (${ci.phaseName}): ${ci.questions}`)
      .join('\n\n');
  }

  const systemInstruction = `You are a warm, supportive wellness coach named Vita. You're conducting a daily check-in with ${patientName}, who is on Day ${day} of a 28-day wellness program.

Patient Profile:
- Name: ${patientName}
- Age: ${profile.age || 'not specified'}
- Goals: ${goals}
- Sleep habits: ${profile.sleepHabits || 'not specified'}
- Exercise habits: ${profile.exerciseHabits || 'not specified'}
- Conditions: ${(profile.conditions || []).join(', ') || 'none reported'}

Current Phase: ${phase.emoji} ${phase.name} (Days ${phase.dayRange[0]}-${phase.dayRange[1]})
Phase Focus: ${phase.description}

Previous Check-ins:
${previousContext}

TONE RULES:
- Warm and encouraging, but not overly enthusiastic or clinical
- Clear and direct — don't be vague or fluffy
- Use the patient's name naturally
- Reference their specific goals and history when relevant
- If this isn't Day 1, reference previous check-ins to show continuity

FORMATTING RULES - YOU MUST FOLLOW THESE:
- Always write responses in clean, readable Markdown.
- Use short paragraphs.
- Add blank lines between paragraphs.
- Use bullet points or numbered lists when explaining multiple points.
- Use Markdown tables when information is best compared across categories, options, prices, pros/cons, steps, symptoms, features, model choices, or trade-offs.
- Keep tables simple and readable.
- Do not use a table if a short paragraph or bullet list is clearer.
- Add a blank line before and after every list or table.
- Do not write dense wall-of-text responses.
- Do not jam numbering into sentences.
- Ensure there is a space after punctuation.
- Keep responses concise and easy to scan.
- Avoid unnecessary follow-up questions at the end of every response.`;

  const userPrompt = `Generate a Day ${day} check-in message for ${patientName}. 

Include:
1. A brief, warm greeting that acknowledges where they are in the program
2. 2-3 specific check-in questions focused on: ${phase.focusAreas.join(', ')}
3. A brief encouraging note

${day === 1 ? 'This is their FIRST day — welcome them, confirm their goals, and ask about their baseline habits.' : ''}
${day > 1 && checkInHistory.length > 0 ? 'Reference their previous responses to show you remember and care about their progress.' : ''}

Keep the total response under 200 words. Make it feel like a conversation, not a survey.`;

  const questions = await generateText(systemInstruction, userPrompt, 0.7);

  return {
    day,
    phase: phase.id,
    phaseName: phase.name,
    phaseEmoji: phase.emoji,
    questions,
  };
}
