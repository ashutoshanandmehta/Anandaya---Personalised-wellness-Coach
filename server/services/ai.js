/**
 * AI Service Module
 *
 * Quota-Aware Per-Request Scheduler for Anandaya.
 */

import { HfInference } from '@huggingface/inference';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';

dotenv.config();

function cleanSecret(value) { return String(value || '').trim() || null; }
function unique(values) { return [...new Set(values.map(cleanSecret).filter(Boolean))]; }

const GROQ_MODELS = Object.freeze({
  GPT_OSS_120B: 'openai/gpt-oss-120b',
  LLAMA70: 'llama-3.3-70b-versatile',
  LLAMA_SCOUT: 'meta-llama/llama-4-scout-17b-16e-instruct',
  QWEN32: 'qwen/qwen3-32b',
  LLAMA8: 'llama-3.1-8b-instant',
});

// Slot state tracking
const slots = [];

function registerSlot(name, model, key, taskType, modelQualityScore) {
  const apiKey = cleanSecret(key);
  if (!apiKey) return;
  slots.push({
    slot_name: name,
    account_id: name.split('_')[1] || 'default',
    model,
    task_type: taskType,
    client: new Groq({ apiKey }),
    status: 'healthy', // healthy | cooling_down | exhausted | disabled
    active_requests: 0,
    estimated_tokens_in_current_minute: 0,
    requests_in_current_minute: 0,
    cooldown_until: 0,
    failure_count: 0,
    model_quality_score: modelQualityScore,
  });
}

// Main Chat (7 keys)
registerSlot('main_scout_1', GROQ_MODELS.LLAMA_SCOUT, process.env.GROQ_MAIN_LLAMA_SCOUT_1_KEY, 'main', 80);
registerSlot('main_scout_2', GROQ_MODELS.LLAMA_SCOUT, process.env.GROQ_MAIN_LLAMA_SCOUT_2_KEY, 'main', 80);
registerSlot('main_scout_3', GROQ_MODELS.LLAMA_SCOUT, process.env.GROQ_RESERVE_1_KEY, 'main', 80); // reserve key
registerSlot('main_llama70_1', GROQ_MODELS.LLAMA70, process.env.GROQ_MAIN_LLAMA70_1_KEY, 'main', 85);
registerSlot('main_llama70_2', GROQ_MODELS.LLAMA70, process.env.GROQ_MAIN_LLAMA70_2_KEY, 'main', 85);
registerSlot('main_openai_1', GROQ_MODELS.GPT_OSS_120B, process.env.GROQ_MAIN_OPENAI_1_KEY, 'main_complex', 100);
registerSlot('main_openai_2', GROQ_MODELS.GPT_OSS_120B, process.env.GROQ_MAIN_OPENAI_2_KEY, 'main_complex', 100);

// Planner
registerSlot('planner_llama8_1', GROQ_MODELS.LLAMA8, process.env.GROQ_PLANNER_LLAMA8_1_KEY, 'planner', 50);
registerSlot('planner_qwen_1', GROQ_MODELS.QWEN32, process.env.GROQ_PLANNER_QWEN_1_KEY, 'planner', 70);
registerSlot('planner_qwen_2', GROQ_MODELS.QWEN32, process.env.GROQ_PLANNER_QWEN_2_KEY, 'planner', 70);

// Summary
registerSlot('summary_llama8_1', GROQ_MODELS.LLAMA8, process.env.GROQ_SUMMARY_LLAMA8_1_KEY, 'summary', 50);
registerSlot('summary_qwen_1', GROQ_MODELS.QWEN32, process.env.GROQ_SUMMARY_QWEN_1_KEY, 'summary', 70);

// Token resetting loop (simplified)
setInterval(() => {
  const now = Date.now();
  for (const slot of slots) {
    slot.estimated_tokens_in_current_minute = 0;
    slot.requests_in_current_minute = 0;
    if (slot.status === 'cooling_down' && now > slot.cooldown_until) {
      slot.status = 'healthy';
      slot.failure_count = 0;
    }
  }
}, 60000);

// When a task type's dedicated slots are all unhealthy (e.g. a restricted/bad
// provider key), degrade gracefully to a broader pool instead of failing the
// whole feature. The `main` models all support JSON output, so planner/summary
// JSON work can run there as a last resort.
const TASK_FALLBACKS = {
  planner: ['planner', 'main'],
  summary: ['summary', 'main'],
  main: ['main', 'main_complex'],
  main_complex: ['main_complex', 'main'],
};

function pickHealthySlot(taskType) {
  const now = Date.now();
  const candidateSlots = slots.filter(s => {
    if (s.status === 'cooling_down' && now > s.cooldown_until) {
      s.status = 'healthy';
    }
    return s.status === 'healthy' && (s.task_type === taskType || s.task_type.startsWith(taskType));
  });

  if (candidateSlots.length === 0) return null;

  // Score = quality - (active_requests * 10)
  candidateSlots.sort((a, b) => {
    const scoreA = a.model_quality_score - (a.active_requests * 10);
    const scoreB = b.model_quality_score - (b.active_requests * 10);
    return scoreB - scoreA;
  });

  return candidateSlots[0];
}

function getBestSlot(taskType) {
  const chain = TASK_FALLBACKS[taskType] || [taskType];
  for (const t of chain) {
    const slot = pickHealthySlot(t);
    if (slot) return slot;
  }
  return null;
}

function countSlotsForTask(taskType) {
  const chain = TASK_FALLBACKS[taskType] || [taskType];
  const names = new Set();
  for (const t of chain) {
    for (const slot of slots) {
      if (slot.task_type === t || slot.task_type.startsWith(t)) {
        names.add(slot.slot_name);
      }
    }
  }
  return names.size;
}

function handleSlotError(slot, error, taskType) {
  const status = error?.status;
  const message = String(error?.message || '');
  slot.failure_count = (slot.failure_count || 0) + 1;

  if (status === 429) {
    // Rate limited. Cool down this slot only.
    slot.status = 'cooling_down';
    slot.cooldown_until = Date.now() + 60000; // 1 min cool down
    console.warn(`[AI Slot Scheduler] 429 Rate Limit on ${slot.slot_name}. Cooling down.`);
  } else if (status >= 500) {
    slot.status = 'cooling_down';
    slot.cooldown_until = Date.now() + 30000;
  } else if (status === 400 || status === 401 || status === 403) {
    // Persistent config/auth failure for THIS slot's key or model — e.g.
    // `organization_restricted`, a revoked key, or a model the org can't access.
    // Retrying the same slot is pointless and starves the other slots, so
    // disable it for a long while and let the scheduler fail over to a healthy
    // slot (this is what restored profile extraction + the tool planner when
    // one provider key was restricted).
    slot.status = 'cooling_down';
    slot.cooldown_until = Date.now() + 15 * 60000; // 15 min
    console.warn(`[AI Slot Scheduler] ${status} on ${slot.slot_name} (${slot.model}) — disabling 15 min, failing over.`);
  } else if (taskType === 'planner' && /json|parse|unexpected token|parseable/i.test(message)) {
    // Invalid JSON is a planner-slot failure for this request. Cool it briefly
    // so the scheduler can try the next planner/main fallback instead of
    // asking the same model for the same malformed shape again.
    slot.status = 'cooling_down';
    slot.cooldown_until = Date.now() + 30000;
    console.warn(`[AI Slot Scheduler] Invalid JSON from ${slot.slot_name} (${slot.model}) — cooling 30s, failing over.`);
  }
}

export function getUserFacingAIErrorMessage(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const status = Number(error?.status || error?.code || 0);

  if (
    status === 429 ||
    /rate\s*limit|too many requests|tokens?\s+per\s+minute|requests?\s+per\s+minute|\btpm\b|\brpm\b|quota|exceeded/i.test(message)
  ) {
    return 'This testing build has reached its current AI token/request limit for the minute. Your message was saved. Please try again in about a minute.';
  }

  if (/no healthy slots|system degraded|all attempts failed/i.test(message)) {
    return 'This testing build is temporarily out of available AI capacity because the test provider limits were reached. Your message was saved. Please try again shortly.';
  }

  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden|organization_restricted|permission/i.test(message)) {
    return 'The AI provider configuration for this testing build needs attention. Your message was saved, but the assistant cannot reply until the test API access is fixed.';
  }

  return 'The AI reply could not be generated right now. Your message was saved. Please try again shortly.';
}

async function executeWithSlot(taskType, runner, estimatedTokens) {
  const maxAttempts = Math.max(3, countSlotsForTask(taskType) + 1);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const slot = getBestSlot(taskType);
    if (!slot) {
      if (lastError) break;
      throw new Error(`No healthy slots available for ${taskType}. System degraded.`);
    }

    slot.active_requests++;
    slot.estimated_tokens_in_current_minute += estimatedTokens;
    slot.requests_in_current_minute++;

    try {
      const result = await runner(slot);
      slot.active_requests--;
      return result;
    } catch (error) {
      lastError = error;
      slot.active_requests--;
      console.error(`[AI Slot] ${taskType}/${slot.slot_name} (${slot.model}) failed:`, error?.status, error?.message);
      handleSlotError(slot, error, taskType);
    }
  }
  throw new Error(`All attempts failed for ${taskType}: ${lastError?.message || 'unknown error'}`);
}

// ── Invalid JSON Auto-Repair ───────────────────────────────────────
// Robustly extract a JSON value from a model's raw text. Handles three things
// that broke the naive `JSON.parse`:
//   1. Reasoning models (Qwen3) emit <think>…</think> before the JSON.
//   2. Models wrap output in ```json … ``` fences (anywhere, not just leading).
//   3. Stray prose before/after the JSON — we fall back to the first balanced
//      {…} or […] block.
function parseMaybeJson(text) {
  let s = String(text || '');
  // Drop closed reasoning blocks, then any unterminated trailing <think>.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
  // Strip markdown code fences wherever they appear.
  s = s.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(s);
  } catch {
    const extracted = extractFirstJson(s);
    if (extracted !== null) return extracted;
    throw new SyntaxError('No parseable JSON found in model output');
  }
}

// Scan for the first balanced {…} or […], respecting strings/escapes.
function extractFirstJson(s) {
  for (let start = 0; start < s.length; start++) {
    const open = s[start];
    if (open !== '{' && open !== '[') continue;

    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

export async function generateJSON(systemInstruction, userPrompt) {
  let lastError = null;
  // Attempt 1: Normal
  try {
    return await executeWithSlot('planner', async (slot) => {
      const response = await slot.client.chat.completions.create({
        model: slot.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${systemInstruction}\n\nIMPORTANT: Return ONLY valid JSON.` },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
      });
      return parseMaybeJson(response.choices[0].message.content);
    }, 500);
  } catch (err) {
    lastError = err;
    console.warn('[AI Planner] JSON parse failed attempt 1, retrying with stricter prompt.', err.message);
  }

  // Attempt 2: Stricter
  try {
    return await executeWithSlot('planner', async (slot) => {
      const response = await slot.client.chat.completions.create({
        model: slot.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${systemInstruction}\n\nCRITICAL ERROR LAST TIME: YOUR OUTPUT WAS NOT VALID JSON. You MUST output ONLY raw parseable JSON this time without any markdown blocks or explanations.` },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.0,
      });
      return parseMaybeJson(response.choices[0].message.content);
    }, 500);
  } catch (err) {
    console.error('[AI Planner] JSON strictly failed.', err);
    throw new Error('Could not generate valid JSON from planner');
  }
}

export async function generateText(systemInstruction, userPrompt, temperature = 0.7) {
  try {
    return await executeWithSlot('summary', async (slot) => {
      const response = await slot.client.chat.completions.create({
        model: slot.model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
        temperature,
      });
      return response.choices[0].message.content;
    }, 1000);
  } catch (err) {
    console.error('[AI] generateText failed', err);
    return 'Summary unavailable.';
  }
}

export async function generateMainText(systemInstruction, userPrompt, temperature = 0.55) {
  try {
    return await executeWithSlot('main', async (slot) => {
      const response = await slot.client.chat.completions.create({
        model: slot.model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
        temperature,
      });
      return response.choices[0].message.content;
    }, 500);
  } catch (error) {
    return getUserFacingAIErrorMessage(error);
  }
}

// Standard synchronous chat (fallback or non-streaming)
export async function chat(systemInstruction, history, userMessage, temperature = 0.7) {
  try {
    return await executeWithSlot('main', async (slot) => {
      const messages = [
        { role: 'system', content: systemInstruction },
        ...(history || []),
        { role: 'user', content: userMessage },
      ];
      const response = await slot.client.chat.completions.create({
        model: slot.model,
        messages,
        temperature,
      });
      return response.choices[0].message.content;
    }, 2000);
  } catch (error) {
    return getUserFacingAIErrorMessage(error);
  }
}

// ── Streaming (SSE) ───────────────────────────────────────────────
export async function chatStream(systemInstruction, history, userMessage, temperature = 0.7) {
  // Returns { stream (AsyncIterable), slotName }
  return await executeWithSlot('main', async (slot) => {
    const messages = [
      { role: 'system', content: systemInstruction },
      ...(history || []),
      { role: 'user', content: userMessage },
    ];
    const stream = await slot.client.chat.completions.create({
      model: slot.model,
      messages,
      temperature,
      stream: true,
    });
    return { stream, slotName: slot.slot_name };
  }, 2000);
}

// ── Embeddings (HF) ───────────────────────────────────────────────
const HF_EMBEDDING_MODEL = process.env.HF_EMBEDDING_MODEL || 'sentence-transformers/all-MiniLM-L6-v2';
const explicitHfTokens = unique([process.env.HF_EMBEDDING_1_TOKEN, process.env.HF_EMBEDDING_2_TOKEN, process.env.HF_EMBEDDING_3_TOKEN]);
const legacyHfTokens = unique([process.env.HF_TOKEN_EMBEDDINGS, process.env.HF_TOKEN]);
const hfClients = (explicitHfTokens.length ? explicitHfTokens : legacyHfTokens).map((token, index) => ({
  name: `hf_embedding_${index + 1}`,
  client: new HfInference(token),
}));
let hfIndex = 0;

export async function generateEmbedding(input) {
  if (!hfClients.length) throw new Error('Hugging Face embeddings task is not configured.');
  let lastError = null;
  for (let attempt = 0; attempt < hfClients.length; attempt++) {
    const current = hfClients[hfIndex % hfClients.length];
    try {
      return await current.client.featureExtraction({ model: HF_EMBEDDING_MODEL, inputs: input });
    } catch (error) {
      lastError = error;
      hfIndex = (hfIndex + 1) % hfClients.length;
    }
  }
  throw lastError || new Error('All HF embedding tokens failed.');
}

export function getAIProviderSummary() {
  return {
    primary: slots.length > 0 ? slots[0].slot_name : 'not configured',
    fallbacks: slots.map(s => s.slot_name),
    taskProviders: {
      main_chat: { fallbackOrder: slots.filter(s => s.task_type.startsWith('main')).map(s => s.slot_name) },
      json_extract: { fallbackOrder: slots.filter(s => s.task_type === 'planner').map(s => s.slot_name) },
      summary: { fallbackOrder: slots.filter(s => s.task_type === 'summary').map(s => s.slot_name) }
    },
    slots: slots.map(s => ({ name: s.slot_name, status: s.status, active: s.active_requests })),
    embeddings_configured: hfClients.length > 0,
    huggingFaceTasks: {
      embeddings: {
        configured: hfClients.length > 0,
        model: HF_EMBEDDING_MODEL,
      },
    },
  };
}
