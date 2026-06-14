/**
 * AI Service Module
 *
 * Central model/key router for Anandaya.
 * Groq is used for chat, JSON/planner work, summaries, and tool-polish text.
 * Hugging Face is kept only for embeddings/RAG.
 */

import { HfInference } from '@huggingface/inference';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';

dotenv.config();

const GROQ_POOL_RECOVERY_MS = 120_000;
const LEGACY_GROQ_KEY = cleanSecret(process.env.GROQ_API_KEY);
const LEGACY_GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const HF_EMBEDDING_MODEL = process.env.HF_EMBEDDING_MODEL || 'sentence-transformers/all-MiniLM-L6-v2';

const GROQ_MODELS = Object.freeze({
  GPT_OSS_120B: 'openai/gpt-oss-120b',
  LLAMA70: 'llama-3.3-70b-versatile',
  LLAMA_SCOUT: 'meta-llama/llama-4-scout-17b-16e-instruct',
  QWEN32: 'qwen/qwen3-32b',
  LLAMA8: 'llama-3.1-8b-instant',
});

function cleanSecret(value) {
  const text = String(value || '').trim();
  return text || null;
}

function unique(values) {
  return [...new Set(values.map(cleanSecret).filter(Boolean))];
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function groqSlot(name, model, key) {
  const apiKey = cleanSecret(key);
  if (!apiKey) return null;
  return {
    name,
    model,
    client: new Groq({ apiKey }),
  };
}

function configuredSlots(slots, legacyName) {
  const configured = slots.filter(Boolean);
  if (configured.length) return configured;
  if (!LEGACY_GROQ_KEY) return [];
  return [groqSlot(legacyName, LEGACY_GROQ_MODEL, LEGACY_GROQ_KEY)];
}

const groqPools = Object.freeze({
  main_chat: configuredSlots([
    groqSlot('main_openai_1', GROQ_MODELS.GPT_OSS_120B, process.env.GROQ_MAIN_OPENAI_1_KEY),
    groqSlot('main_openai_2', GROQ_MODELS.GPT_OSS_120B, process.env.GROQ_MAIN_OPENAI_2_KEY),
    groqSlot('main_llama70_1', GROQ_MODELS.LLAMA70, process.env.GROQ_MAIN_LLAMA70_1_KEY),
    groqSlot('main_llama70_2', GROQ_MODELS.LLAMA70, process.env.GROQ_MAIN_LLAMA70_2_KEY),
    groqSlot('main_llama_scout_1', GROQ_MODELS.LLAMA_SCOUT, process.env.GROQ_MAIN_LLAMA_SCOUT_1_KEY),
    groqSlot('main_llama_scout_2', GROQ_MODELS.LLAMA_SCOUT, process.env.GROQ_MAIN_LLAMA_SCOUT_2_KEY),
  ], 'legacy_main_groq'),
  json_extract: configuredSlots([
    groqSlot('planner_qwen_1', GROQ_MODELS.QWEN32, process.env.GROQ_PLANNER_QWEN_1_KEY),
    groqSlot('planner_qwen_2', GROQ_MODELS.QWEN32, process.env.GROQ_PLANNER_QWEN_2_KEY),
    groqSlot('planner_llama8_1', GROQ_MODELS.LLAMA8, process.env.GROQ_PLANNER_LLAMA8_1_KEY),
  ], 'legacy_planner_groq'),
  summary: configuredSlots([
    groqSlot('summary_llama8_1', GROQ_MODELS.LLAMA8, process.env.GROQ_SUMMARY_LLAMA8_1_KEY),
    groqSlot('summary_qwen_1', GROQ_MODELS.QWEN32, process.env.GROQ_SUMMARY_QWEN_1_KEY),
  ], 'legacy_summary_groq'),
});

const reserveKey = cleanSecret(process.env.GROQ_RESERVE_1_KEY);
const reserveSlots = Object.freeze({
  main_chat: groqSlot('reserve_groq_1', GROQ_MODELS.LLAMA_SCOUT, reserveKey),
  json_extract: groqSlot('reserve_groq_1', GROQ_MODELS.LLAMA8, reserveKey),
  summary: groqSlot('reserve_groq_1', GROQ_MODELS.LLAMA8, reserveKey),
});

const poolState = {
  main_chat: { activeIndex: 0, recoveryUntil: 0, lastErrorReason: null },
  json_extract: { activeIndex: 0, recoveryUntil: 0, lastErrorReason: null },
  summary: { activeIndex: 0, recoveryUntil: 0, lastErrorReason: null },
};

const explicitHfEmbeddingTokens = unique([
  process.env.HF_EMBEDDING_1_TOKEN,
  process.env.HF_EMBEDDING_2_TOKEN,
  process.env.HF_EMBEDDING_3_TOKEN,
]);
const legacyHfEmbeddingTokens = unique([
  process.env.HF_TOKEN_EMBEDDINGS,
  process.env.HF_TOKEN,
]);
const hfEmbeddingClients = (explicitHfEmbeddingTokens.length ? explicitHfEmbeddingTokens : legacyHfEmbeddingTokens).map((token, index) => ({
  name: `hf_embedding_${index + 1}`,
  client: new HfInference(token),
}));

let hfEmbeddingIndex = 0;

function errorLabel(error) {
  const status = error?.status ? `status=${error.status}` : '';
  const code = error?.error?.error?.code || error?.code || error?.cause?.code || '';
  const message = error?.error?.error?.message || error?.message || 'unknown error';
  return [status, code, message].filter(Boolean).join(' ');
}

function resetPoolIfRecovered(taskKey) {
  const state = poolState[taskKey];
  if (!state) return;
  if (state.recoveryUntil && Date.now() >= state.recoveryUntil) {
    state.activeIndex = 0;
    state.recoveryUntil = 0;
    state.lastErrorReason = null;
    console.warn(`[AI Pool] ${taskKey} recovery window ended; reset to preferred slot.`);
  }
}

function advanceGroqPool(taskKey, error) {
  const slots = groqPools[taskKey] || [];
  const state = poolState[taskKey];
  if (!state || !slots.length) return;
  state.activeIndex = (state.activeIndex + 1) % slots.length;
  state.recoveryUntil = Date.now() + GROQ_POOL_RECOVERY_MS;
  state.lastErrorReason = errorLabel(error);
  const nextSlot = slots[state.activeIndex];
  console.warn(`[AI Pool] ${taskKey} switched to ${nextSlot.name} (${nextSlot.model}); recovery reset in 2 minutes. Reason: ${state.lastErrorReason}`);
}

function getActiveSlot(taskKey) {
  resetPoolIfRecovered(taskKey);
  const slots = groqPools[taskKey] || [];
  if (!slots.length) return null;
  const state = poolState[taskKey];
  return slots[state.activeIndex % slots.length];
}

function logGroqAttempt({ taskKey, taskLabel, slot, inputTokens, reserve = false }) {
  console.log('[AI Pool Attempt]', {
    task: taskKey,
    label: taskLabel,
    slot: slot.name,
    model: slot.model,
    reserve,
    estimatedInputTokens: inputTokens,
    recoveryUntil: poolState[taskKey]?.recoveryUntil
      ? new Date(poolState[taskKey].recoveryUntil).toISOString()
      : null,
  });
}

async function runGroqPool(taskLabel, taskKey, inputText, runner) {
  const slots = groqPools[taskKey] || [];
  if (!slots.length) {
    throw new Error(`No Groq slots configured for ${taskKey}.`);
  }

  const inputTokens = estimateTokens(inputText);
  let lastError = null;

  for (let attempt = 0; attempt < slots.length; attempt += 1) {
    const slot = getActiveSlot(taskKey);
    if (!slot) break;
    try {
      logGroqAttempt({ taskKey, taskLabel, slot, inputTokens });
      return await runner(slot);
    } catch (error) {
      lastError = error;
      console.error(`[AI Pool] ${taskKey} slot ${slot.name} (${slot.model}) failed. ${errorLabel(error)}`);
      advanceGroqPool(taskKey, error);
    }
  }

  const reserve = reserveSlots[taskKey];
  if (reserve) {
    try {
      logGroqAttempt({ taskKey, taskLabel, slot: reserve, inputTokens, reserve: true });
      return await runner(reserve);
    } catch (error) {
      lastError = error;
      console.error(`[AI Pool] ${taskKey} reserve ${reserve.name} (${reserve.model}) failed. ${errorLabel(error)}`);
    }
  }

  throw lastError || new Error(`All Groq routes failed for ${taskKey}.`);
}

function parseMaybeJson(text) {
  const trimmed = String(text || '')
    .trim()
    .replace(/^```json/i, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(trimmed);
}

async function generateJSONWithSlot(slot, systemInstruction, userPrompt) {
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
}

async function generateTextWithSlot(slot, systemInstruction, userPrompt, temperature = 0.7) {
  const response = await slot.client.chat.completions.create({
    model: slot.model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    temperature,
  });
  return response.choices[0].message.content;
}

async function chatWithSlot(slot, systemInstruction, history, userMessage, temperature = 0.7) {
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
}

export function getAIProviderSummary() {
  const summarizeSlot = slot => slot ? `${slot.name}:${slot.model}` : 'not configured';
  return {
    primary: summarizeSlot(getActiveSlot('main_chat')),
    fallbacks: (groqPools.main_chat || []).slice(1).map(summarizeSlot),
    taskProviders: {
      main_chat: {
        primary: summarizeSlot((groqPools.main_chat || [])[0]),
        fallbackOrder: (groqPools.main_chat || []).map(summarizeSlot),
      },
      json_extract: {
        primary: summarizeSlot((groqPools.json_extract || [])[0]),
        fallbackOrder: (groqPools.json_extract || []).map(summarizeSlot),
      },
      summary: {
        primary: summarizeSlot((groqPools.summary || [])[0]),
        fallbackOrder: (groqPools.summary || []).map(summarizeSlot),
      },
      embeddings: {
        primary: `${HF_EMBEDDING_MODEL} (${hfEmbeddingClients.length} HF token${hfEmbeddingClients.length === 1 ? '' : 's'})`,
        fallbackOrder: ['HF token cycle', 'FTS/lexical retrieval fallback'],
      },
    },
    huggingFaceTasks: {
      embeddings: {
        configured: hfEmbeddingClients.length > 0,
        model: HF_EMBEDDING_MODEL,
        tokenCount: hfEmbeddingClients.length,
      },
    },
    groqPools: Object.fromEntries(
      Object.entries(groqPools).map(([task, slots]) => [
        task,
        {
          active: summarizeSlot(getActiveSlot(task)),
          recoveryUntil: poolState[task]?.recoveryUntil
            ? new Date(poolState[task].recoveryUntil).toISOString()
            : null,
          slots: slots.map(summarizeSlot),
          reserve: summarizeSlot(reserveSlots[task]),
        },
      ])
    ),
  };
}

/**
 * Generate a structured JSON response from the planner/extraction pool.
 * Invalid JSON is treated as a model failure and advances the planner cycle.
 */
export async function generateJSON(systemInstruction, userPrompt) {
  return runGroqPool(
    'JSON generation',
    'json_extract',
    `${systemInstruction}\n${userPrompt}`,
    slot => generateJSONWithSlot(slot, systemInstruction, userPrompt)
  );
}

/**
 * Generate short text for summaries and tool-result polish.
 */
export async function generateText(systemInstruction, userPrompt, temperature = 0.7) {
  try {
    return await runGroqPool(
      'text generation',
      'summary',
      `${systemInstruction}\n${userPrompt}`,
      slot => generateTextWithSlot(slot, systemInstruction, userPrompt, temperature)
    );
  } catch (error) {
    console.error('[AI Pool] Summary/text generation exhausted.', errorLabel(error));
    return 'AI service is temporarily unavailable. Your message was saved.';
  }
}

/**
 * Generate user-facing wellness copy from the main chat pool.
 * Use this when short copy should match the primary companion voice.
 */
export async function generateMainText(systemInstruction, userPrompt, temperature = 0.55) {
  try {
    return await runGroqPool(
      'main text generation',
      'main_chat',
      `${systemInstruction}\n${userPrompt}`,
      slot => generateTextWithSlot(slot, systemInstruction, userPrompt, temperature)
    );
  } catch (error) {
    console.error('[AI Pool] Main text generation exhausted.', errorLabel(error));
    return 'AI service is temporarily unavailable. Your message was saved.';
  }
}

/**
 * Run a multi-turn chat with conversation history.
 * History format: [{ role: 'user'|'assistant', content: '...' }]
 */
export async function chat(systemInstruction, history, userMessage, temperature = 0.7) {
  try {
    return await runGroqPool(
      'chat generation',
      'main_chat',
      `${systemInstruction}\n${(history || []).map(m => `${m.role}: ${m.content}`).join('\n')}\nuser: ${userMessage}`,
      slot => chatWithSlot(slot, systemInstruction, history, userMessage, temperature)
    );
  } catch (error) {
    console.error('[AI Pool] Main chat exhausted.', errorLabel(error));
    return 'AI service is temporarily unavailable. Your message was saved.';
  }
}

/**
 * Generate embeddings for semantic protocol retrieval.
 * HF embeddings rotate tokens on error; no timer is used.
 */
export async function generateEmbedding(input) {
  if (!hfEmbeddingClients.length) {
    throw new Error('Hugging Face embeddings task is not configured.');
  }

  let lastError = null;
  for (let attempt = 0; attempt < hfEmbeddingClients.length; attempt += 1) {
    const current = hfEmbeddingClients[hfEmbeddingIndex % hfEmbeddingClients.length];
    try {
      console.log('[AI Embedding Attempt]', {
        slot: current.name,
        model: HF_EMBEDDING_MODEL,
        estimatedInputTokens: estimateTokens(input),
      });
      return await current.client.featureExtraction({
        model: HF_EMBEDDING_MODEL,
        inputs: input,
      });
    } catch (error) {
      lastError = error;
      console.error(`[AI Embedding] ${current.name} failed. ${errorLabel(error)}`);
      hfEmbeddingIndex = (hfEmbeddingIndex + 1) % hfEmbeddingClients.length;
      console.warn(`[AI Embedding] Switched to ${hfEmbeddingClients[hfEmbeddingIndex].name}.`);
    }
  }

  throw lastError || new Error('All Hugging Face embedding tokens failed.');
}
