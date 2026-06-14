/**
 * Protocol knowledge chunks derived from the approved wellness protocol.
 * This is intentionally local/static for now. Later we can move these rows into
 * SQLite FTS without changing the retriever contract.
 */

import { WELLNESS_PROTOCOL } from './wellness-protocol.js';

const SECTION_MAP = buildSectionMap(WELLNESS_PROTOCOL);

const DEFINITIONS = [
  {
    id: 'core_safety',
    title: 'Core safety and boundaries',
    alwaysInclude: true,
    headings: [
      '0. Supreme Operating Principle',
      '1. Scope Boundary',
      '2. Product Architecture: Safety Before Conversation',
      '3. Risk Levels',
      '20. Final Boundary',
    ],
    keywords: [
      'safety', 'diagnose', 'prescribe', 'dose', 'doctor', 'clinician', 'urgent',
      'emergency', 'red flag', 'professional', 'harmful', 'risk',
    ],
  },
  {
    id: 'profile_intake',
    title: 'Profile, sidebar, and intake',
    headings: [
      '4. Profile Creation Protocol',
      '5. Right Patient Sidebar Protocol',
      '6. Day 0 Intake Protocol',
      '7. Multi-Label Category Classifier',
    ],
    keywords: [
      'profile', 'age', 'height', 'weight', 'sex', 'sidebar', 'intake',
      'onboarding', 'photo', 'category', 'classify',
    ],
  },
  {
    id: 'emergency_red_flags',
    title: 'Emergency and red-flag symptoms',
    headings: [
      '8.1 Emergency or Red-Flag Physical Symptoms',
      '13. Google Maps and Nearby Care Protocol',
    ],
    keywords: [
      'emergency', 'urgent', 'hospital', 'chest pain', 'breathing', 'fainting',
      'seizure', 'bleeding', 'allergic', 'weakness', 'confusion', 'nearby care',
    ],
  },
  {
    id: 'acute_recovery',
    title: 'Acute illness and recovery comfort',
    headings: [
      '8.2 Acute Non-Urgent Illness',
      '9. Immediate Relief Before Long Intake',
      '9.1 Headache Comfort Support',
      '9.2 Diarrhea and Hydration Support',
    ],
    keywords: [
      'headache', 'cold', 'cough', 'fever', 'body ache', 'diarrhea', 'loose motion',
      'vomit', 'stomach', 'hydration', 'ors', 'recovery', 'symptoms',
    ],
  },
  {
    id: 'chronic_conditions',
    title: 'Chronic conditions and undiagnosed symptoms',
    headings: [
      '8.3 Chronic Condition Management Support',
      '8.4 First-Time or Undiagnosed Symptoms',
      '8.14 Preventive Care and Reports',
    ],
    keywords: [
      'diabetes', 'blood pressure', 'asthma', 'thyroid', 'migraine', 'chronic',
      'undiagnosed', 'first time', 'report', 'lab', 'reading', 'checkup',
    ],
  },
  {
    id: 'medication_prescription',
    title: 'Medication and prescription boundaries',
    headings: [
      '8.5 Medication Adherence',
      '8.6 Prescription Support',
      '14. Quick Commerce and Pharmacy Protocol',
    ],
    keywords: [
      'medicine', 'medication', 'tablet', 'pill', 'dose', 'dosage', 'prescription',
      'missed dose', 'pharmacy', 'pharmacist', 'ocr',
    ],
  },
  {
    id: 'mental_emotional',
    title: 'Mental and emotional distress',
    headings: [
      '8.7 Mental and Emotional Distress',
      '9.3 Anxiety or Panic-Like Distress',
    ],
    keywords: [
      'stress', 'anxiety', 'panic', 'sad', 'lonely', 'grief', 'heartbreak',
      'mood', 'emotional', 'relationship', 'exam', 'work stress',
    ],
  },
  {
    id: 'sleep',
    title: 'Sleep and circadian optimization',
    headings: ['8.8 Sleep and Circadian Optimization'],
    keywords: [
      'sleep', 'bedtime', 'wake', 'insomnia', 'night', 'nap', 'caffeine',
      'screen before bed', 'morning light', 'tired', 'fresh',
    ],
  },
  {
    id: 'focus_screen',
    title: 'Focus, concentration, and screen time',
    headings: [
      '8.9 Focus and Concentration',
      '8.10 Screen Time Management',
    ],
    keywords: [
      'focus', 'concentration', 'study', 'work', 'attention', 'distraction',
      'screen time', 'phone', 'social media', 'apps',
    ],
  },
  {
    id: 'hydration',
    title: 'Hydration and water tracking',
    headings: [
      '8.11 Hydration and Water Tracking',
      '9.2 Diarrhea and Hydration Support',
    ],
    keywords: [
      'water', 'hydration', 'drink', 'thirst', 'bottle', 'urine', 'sweat',
      'heat', 'ors', 'dehydration',
    ],
  },
  {
    id: 'fitness',
    title: 'Physical fitness and movement',
    headings: ['8.12 Physical Fitness Enhancement'],
    keywords: [
      'exercise', 'fitness', 'workout', 'movement', 'walking', 'steps', 'strength',
      'mobility', 'injury', 'pain', 'equipment',
    ],
  },
  {
    id: 'nutrition',
    title: 'Nutrition and meal routine',
    headings: ['8.13 Nutrition and Meal Routine'],
    keywords: [
      'nutrition', 'meal', 'diet', 'food', 'breakfast', 'lunch', 'dinner',
      'cravings', 'appetite', 'cooking', 'balanced plate',
    ],
  },
  {
    id: 'caregiver',
    title: 'Caregiver mode',
    headings: ['8.15 Caregiver Mode'],
    keywords: [
      'mother', 'father', 'parent', 'child', 'sibling', 'friend', 'caregiver',
      'elderly', 'dependent', 'guardian', 'family',
    ],
  },
  {
    id: 'goals_reminders_checkins',
    title: 'Goals, reminders, progress, and check-ins',
    headings: [
      '10. Goal Setup Protocol',
      '11. Progress Timeline Protocol',
      '12. Reminder Protocol',
      '18. Daily Check-In Protocol',
      '19. Data Persistence Requirements',
    ],
    keywords: [
      'goal', 'plan', 'duration', '7 day', '14 day', '30 day', '90 day',
      'progress', 'timeline', 'reminder', 'check-in', 'checkin', 'habit',
      'track', 'schedule', 'daily',
    ],
  },
  {
    id: 'style_contract',
    title: 'Response style and output contract',
    headings: [
      '15. Response Style',
      '16. LLM Output Contract',
      '17. Post-Generation Safety Filter',
    ],
    keywords: [
      'style', 'tone', 'emoji', 'question', 'format', 'json', 'output',
      'response', 'filter',
    ],
  },
];

export const KNOWLEDGE_CHUNKS = DEFINITIONS.map(definition => ({
  ...definition,
  content: definition.headings
    .map(heading => SECTION_MAP.get(heading))
    .filter(Boolean)
    .join('\n\n---\n\n'),
})).filter(chunk => chunk.content.trim().length > 0);

function buildSectionMap(protocol) {
  const sections = new Map();
  const lines = protocol.split('\n');
  let currentTitle = null;
  let currentLines = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      if (currentTitle && currentLines.length) {
        sections.set(currentTitle, currentLines.join('\n').trim());
      }
      currentTitle = headingMatch[1].trim();
      currentLines = [line];
    } else if (currentTitle) {
      currentLines.push(line);
    }
  }

  if (currentTitle && currentLines.length) {
    sections.set(currentTitle, currentLines.join('\n').trim());
  }

  return sections;
}

export default KNOWLEDGE_CHUNKS;
