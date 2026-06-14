/**
 * Profile Engine
 * Parses unstructured patient onboarding text into structured profile data.
 */

import { generateJSON } from './ai.js';

const SYSTEM_INSTRUCTION = `You are a health intake parser. Your job is to extract or update the patient's profile based on the conversation history.
You are given the current structured profile state. Only update or add fields if they are explicitly mentioned in the recent conversation.

Return the complete updated structured JSON profile matching this schema exactly. Do not nest it.
{
  "age": "number or null",
  "sex": "string (Male, Female, Other) or null",
  "height": "string (e.g. 175 cm) or null",
  "weight": "string (e.g. 70 kg) or null",
  "category": "string (e.g. Sleep, Nutrition, General) or null",
  "severity": "string (Mild, Moderate, Severe) or null",
  "conditions": ["array of strings"],
  "allergies": ["array of strings"],
  "medications": ["array of strings"],
  "goals": ["array of strings"],
  "program_duration_days": "number or null - Extract ONLY if the user explicitly confirms a number of days to track their goal (e.g., 7, 14, 28)."
}`;

export async function extractProfileFromChat(history, currentProfile) {
  if (!history || history.length === 0) return currentProfile;

  const historyText = history.map(h => `${h.role}: ${h.content}`).join('\n');
  
  const updatedProfile = await generateJSON(
    SYSTEM_INSTRUCTION,
    `Current Profile JSON:\n${JSON.stringify(currentProfile, null, 2)}\n\nRecent Conversation:\n${historyText}\n\nReturn the updated JSON profile.`
  );

  // Ensure arrays
  updatedProfile.conditions = updatedProfile.conditions || [];
  updatedProfile.allergies = updatedProfile.allergies || [];
  updatedProfile.medications = updatedProfile.medications || [];
  updatedProfile.goals = updatedProfile.goals || [];

  return updatedProfile;
}
