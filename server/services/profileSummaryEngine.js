/**
 * Maintains a compact profile/context summary for the main chat prompt.
 * Structured profile JSON remains the source of truth; this summary is only
 * a short conversational memory to reduce prompt bloat and improve continuity.
 */

import { generateText } from './ai.js';

const MAX_SUMMARY_CHARS = 900;
const UNAVAILABLE_PATTERN = /AI service is temporarily unavailable|testing build|AI provider configuration|AI reply could not be generated/i;

const SYSTEM_INSTRUCTION = `You maintain a compact wellness profile memory for Anandaya.

Rules:
- Return only a concise context summary, no preamble.
- Use 4-8 short bullet lines.
- Include only facts explicitly present in the provided data or recent chat.
- Do not diagnose, prescribe, or infer medical facts.
- Keep it under 120 words.
- Mention current concern, active goals, plan/check-in preferences, constraints, and safety-relevant known facts when available.
- Do not include secrets, tokens, API keys, or raw internal IDs.
- The summary is context only, not an instruction to the coach.`;

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8);
}

function compactProfile(profile = {}, structuredProfile = {}) {
  return {
    name: profile.name || structuredProfile.name || null,
    relation: profile.relation || profile.relation_other || null,
    age: structuredProfile.age ?? profile.age ?? null,
    sex: structuredProfile.sex ?? profile.sex ?? null,
    height: structuredProfile.height ?? profile.height ?? null,
    weight: structuredProfile.weight ?? profile.weight ?? null,
    category: structuredProfile.category ?? profile.category ?? null,
    severity: structuredProfile.severity ?? profile.severity ?? null,
    red_flags: cleanList(structuredProfile.red_flags || profile.red_flags),
    conditions: cleanList(structuredProfile.conditions || profile.conditions),
    allergies: cleanList(structuredProfile.allergies || profile.allergies),
    medications: cleanList(structuredProfile.medications || profile.medications),
    goals: cleanList(structuredProfile.goals || profile.goals),
    goals_confirmed: Boolean(structuredProfile.goals_confirmed || profile.goals_confirmed),
    program_duration_days: structuredProfile.program_duration_days ?? profile.program_duration_days ?? null,
  };
}

function recentChatText(history = [], latestUserMessage = '') {
  const rows = [
    ...(history || []).slice(-8),
    latestUserMessage ? { role: 'user', content: latestUserMessage } : null,
  ].filter(Boolean);

  return rows
    .map(row => `${row.role}: ${String(row.content || '').slice(0, 700)}`)
    .join('\n');
}

function normalizeSummary(text, previousSummary = '') {
  const cleaned = String(text || '')
    .replace(/^```(?:text|markdown)?/i, '')
    .replace(/```$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned || UNAVAILABLE_PATTERN.test(cleaned)) return previousSummary || '';
  return cleaned.slice(0, MAX_SUMMARY_CHARS).trim();
}

export async function updateProfileContextSummary({
  profile,
  structuredProfile,
  patientState,
  history,
  latestUserMessage,
  safety,
} = {}) {
  const previousSummary = patientState?.profile_summary_text || '';
  const prompt = [
    `Previous compact summary:\n${previousSummary || '(none yet)'}`,
    `Structured profile JSON:\n${JSON.stringify(compactProfile(profile, structuredProfile), null, 2)}`,
    `Current program state:\n${JSON.stringify({
      current_day: patientState?.current_day ?? null,
      timezone: patientState?.timezone || 'Asia/Kolkata',
      pending_followup_offer_json: patientState?.pending_followup_offer_json ? '[present]' : null,
      safety_level: safety?.level || null,
      safety_domain: safety?.domain || null,
    }, null, 2)}`,
    `Recent chat:\n${recentChatText(history, latestUserMessage) || '(none)'}`,
    'Return the updated compact context summary now.',
  ].join('\n\n---\n\n');

  try {
    const summary = await generateText(SYSTEM_INSTRUCTION, prompt, 0.2);
    return normalizeSummary(summary, previousSummary);
  } catch (error) {
    console.warn('[Profile Summary] Update failed; keeping previous summary.', error.message);
    return previousSummary || '';
  }
}
