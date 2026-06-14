/**
 * Small deterministic protocol retriever.
 * It selects relevant local protocol chunks from our approved knowledge source.
 * This is the lightweight pre-FTS/RAG layer; no open internet retrieval.
 */

import { KNOWLEDGE_CHUNKS } from '../data/knowledgeChunks.js';
import { getDb } from '../db.js';
import { generateEmbedding } from './ai.js';

const DEFAULT_MAX_CHUNKS = 5;
const HYBRID_MIN_OPTIONAL_SCORE = 5;
const SEMANTIC_RESCUE_SCORE = 16;
const SEMANTIC_RAG_ENABLED = String(process.env.ENABLE_SEMANTIC_RAG || '').toLowerCase() === 'true';
const SEMANTIC_TIMEOUT_MS = Number(process.env.RAG_EMBEDDING_TIMEOUT_MS || 2000);

export function estimateTokens(text = '') {
  return Math.ceil(String(text).length / 4);
}

export async function retrieveProtocolChunksHybrid(options = {}) {
  const fallback = retrieveProtocolChunks(options);

  try {
    const db = await getDb();
    const rows = await db.all('SELECT * FROM knowledge_chunks');
    if (!rows.length) return { ...fallback, source: 'memory_keyword' };

    const chunks = rows.map(rowToChunk);
    const query = buildQuery(options);
    const always = chunks.filter(chunk => chunk.alwaysInclude);
    const forcedIds = new Set([
      ...forcedSafetyChunks(options.safety).map(chunk => chunk.id),
      ...forcedProfileChunks(options.profile).map(chunk => chunk.id),
    ]);

    const scores = new Map();
    for (const id of forcedIds) addScore(scores, id, 100, 'forced');

    const allowedOptionalIds = new Set(
      chunks
        .filter(chunk => !chunk.alwaysInclude && isChunkEligible(chunk, query, options.profile))
        .map(chunk => chunk.id)
    );

    for (const chunk of chunks) {
      if (!chunk.alwaysInclude && !allowedOptionalIds.has(chunk.id) && !forcedIds.has(chunk.id)) continue;
      const score = scoreChunk(chunk, query, options.safety, options.profile);
      if (score > 0) addScore(scores, chunk.id, score * 2, 'keyword');
    }

    const ftsMatches = await searchFts(db, query);
    const usedFtsMatches = [];
    ftsMatches.forEach((match, index) => {
      if (!allowedOptionalIds.has(match.id) && !forcedIds.has(match.id)) return;
      usedFtsMatches.push(match.id);
      addScore(scores, match.id, Math.max(2, 10 - index * 2), 'fts');
    });

    const semanticMatches = await searchSemantic(rows, query);
    const usedSemanticMatches = [];
    semanticMatches.forEach((match, index) => {
      if (!allowedOptionalIds.has(match.id) && !forcedIds.has(match.id)) return;
      usedSemanticMatches.push(match.id);
      addScore(scores, match.id, Math.max(4, match.score * 32 - index), 'semantic');
    });

    const hasLexicalOptionalMatch = [...scores.entries()].some(([id, entry]) => (
      allowedOptionalIds.has(id) && hasLexicalRetrievalSource(entry)
    ));

    const optional = chunks
      .filter(chunk => !chunk.alwaysInclude)
      .map(chunk => ({ chunk, score: scores.get(chunk.id)?.score || 0, entry: scores.get(chunk.id) }))
      .filter(item => shouldIncludeOptionalChunk(item, forcedIds, hasLexicalOptionalMatch))
      .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
      .map(item => item.chunk);

    const selected = dedupeChunks([
      ...always,
      ...optional,
    ]).slice(0, options.maxChunks || DEFAULT_MAX_CHUNKS);

    return {
      chunks: selected,
      query,
      selectedChunkIds: selected.map(chunk => chunk.id),
      estimatedProtocolTokens: estimateTokens(selected.map(chunk => chunk.content).join('\n\n')),
      source: 'sqlite_hybrid',
      retrievalStats: {
        ftsMatches: usedFtsMatches,
        semanticMatches: usedSemanticMatches,
        scoredChunks: [...scores.entries()]
          .sort((a, b) => b[1].score - a[1].score)
          .slice(0, 8)
          .map(([id, entry]) => ({ id, score: Number(entry.score.toFixed(2)), sources: [...entry.sources] })),
      },
    };
  } catch (error) {
    console.warn('[Protocol Retriever] DB hybrid retrieval failed; using memory fallback.', error.message);
    return { ...fallback, source: 'memory_keyword' };
  }
}

export function retrieveProtocolChunks({
  question = '',
  profile = {},
  patientState = {},
  safety = {},
  history = [],
  maxChunks = DEFAULT_MAX_CHUNKS,
} = {}) {
  const query = buildQuery({ question, profile, patientState, safety, history });
  const always = KNOWLEDGE_CHUNKS.filter(chunk => chunk.alwaysInclude);
  const optional = KNOWLEDGE_CHUNKS
    .filter(chunk => !chunk.alwaysInclude)
    .filter(chunk => isChunkEligible(chunk, query, profile))
    .map(chunk => ({ chunk, score: scoreChunk(chunk, query, safety, profile) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .slice(0, Math.max(0, maxChunks - always.length))
    .map(item => item.chunk);

  const chunks = dedupeChunks([
    ...always,
    ...forcedSafetyChunks(safety),
    ...forcedProfileChunks(profile),
    ...optional,
  ]).slice(0, maxChunks);

  return {
    chunks,
    query,
    selectedChunkIds: chunks.map(chunk => chunk.id),
    estimatedProtocolTokens: estimateTokens(chunks.map(chunk => chunk.content).join('\n\n')),
  };
}

export async function backfillKnowledgeChunkEmbeddings({ force = false } = {}) {
  const db = await getDb();
  const rows = await db.all(`
    SELECT id, title, content, embedding_json
    FROM knowledge_chunks
    ${force ? '' : 'WHERE embedding_json IS NULL'}
    ORDER BY id
  `);

  const model = process.env.HF_EMBEDDING_MODEL || 'sentence-transformers/all-MiniLM-L6-v2';
  let updated = 0;

  for (const row of rows) {
    const input = `${row.title}\n\n${row.content}`;
    const embedding = normalizeEmbedding(await generateEmbedding(input));
    if (!embedding.length) continue;

    await db.run(`
      UPDATE knowledge_chunks
      SET embedding_json = ?,
          embedding_model = ?,
          embedded_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [JSON.stringify(embedding), model, row.id]);
    updated += 1;
  }

  return { updated, model };
}

export function formatProtocolChunks(chunks) {
  return chunks.map(chunk => (
    `### ${chunk.title} [${chunk.id}]\n${chunk.content}`
  )).join('\n\n---\n\n');
}

function buildQuery({ question, profile, patientState, safety, history }) {
  const recentHistory = (history || []).slice(-4).map(item => item.content).join(' ');
  const structured = patientState?.structured_profile_json
    ? safeJson(patientState.structured_profile_json)
    : patientState?.structured_profile;

  return [
    question,
    recentHistory,
    patientState?.profile_summary_text,
    profile?.name,
    profile?.relation,
    profile?.relation_other,
    profile?.age,
    profile?.sex,
    profile?.height,
    profile?.weight,
    profile?.category,
    profile?.severity,
    ...asList(profile?.red_flags),
    ...asList(profile?.goals),
    structured?.category,
    structured?.severity,
    ...asList(structured?.red_flags),
    ...asList(structured?.goals),
    ...asList(structured?.allergies),
    ...asList(structured?.conditions),
    ...asList(structured?.medications),
    safety?.level,
    safety?.domain,
    safety?.action,
  ].filter(Boolean).join(' ').toLowerCase();
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return value.split(',').map(item => item.trim()).filter(Boolean);
    }
  }
  return [];
}

async function searchFts(db, query) {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    return await db.all(`
      SELECT kc.id, bm25(knowledge_chunks_fts) AS rank
      FROM knowledge_chunks_fts
      JOIN knowledge_chunks kc ON kc.id = knowledge_chunks_fts.id
      WHERE knowledge_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT 8
    `, [ftsQuery]);
  } catch (error) {
    console.warn('[Protocol Retriever] FTS query failed; continuing without FTS.', error.message);
    return [];
  }
}

async function searchSemantic(rows, query) {
  if (!SEMANTIC_RAG_ENABLED) return [];

  const embeddedRows = rows
    .map(row => ({ id: row.id, embedding: safeJson(row.embedding_json) }))
    .filter(row => Array.isArray(row.embedding) && row.embedding.length > 0);

  if (!embeddedRows.length) return [];

  try {
    const queryEmbedding = normalizeEmbedding(await withTimeout(
      generateEmbedding(query),
      SEMANTIC_TIMEOUT_MS,
      'Semantic embedding timed out'
    ));
    if (!queryEmbedding.length) return [];

    return embeddedRows
      .map(row => ({ id: row.id, score: cosineSimilarity(queryEmbedding, row.embedding) }))
      .filter(row => Number.isFinite(row.score) && row.score > 0.18)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  } catch (error) {
    console.warn('[Protocol Retriever] Semantic retrieval failed; continuing without embeddings.', error.message);
    return [];
  }
}

function buildFtsQuery(query) {
  const terms = tokenize(query)
    .filter(term => !STOP_WORDS.has(term))
    .slice(0, 12);

  return terms.length ? terms.map(term => `"${term}"`).join(' OR ') : '';
}

function tokenize(text) {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map(term => term.trim())
      .filter(term => term.length >= 3)
  )];
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'are', 'was', 'were', 'what',
  'how', 'can', 'should', 'this', 'that', 'have', 'has', 'had', 'not', 'but',
  'from', 'into', 'about', 'today', 'please', 'need', 'want',
]);

function scoreChunk(chunk, query, safety, profile) {
  let score = 0;

  for (const keyword of chunk.keywords || []) {
    const needle = String(keyword).toLowerCase();
    if (!needle) continue;
    if (query.includes(needle)) score += needle.includes(' ') ? 4 : 2;
  }

  if (chunk.id === 'emergency_red_flags' && ['RED', 'ORANGE'].includes(safety?.level)) score += 12;
  if (chunk.id === 'acute_recovery' && /acute|symptom|illness|recovery|headache|fever|diarrhea|loose motion/.test(query)) score += 8;
  if (chunk.id === 'medication_prescription' && /medication|medicine|prescription|dose|tablet|pharmacy/.test(query)) score += 10;
  if (chunk.id === 'mental_emotional' && /mental|emotional|stress|anxiety|panic|sad|crisis/.test(query)) score += 10;
  if (chunk.id === 'caregiver' && !isSelfProfile(profile)) score += 5;
  if (chunk.id === 'goals_reminders_checkins' && /plan|goal|track|reminder|check.?in|habit|duration/.test(query)) score += 8;
  if (chunk.id === 'profile_intake' && /\b(age|height|weight|female|male|sex|gender|cm|kg|years?|yo)\b|\b\d+\s?(cm|kg)\b/.test(query)) score += 10;

  return score;
}

function forcedSafetyChunks(safety) {
  if (!safety || safety.level === 'GREEN') return [];
  return KNOWLEDGE_CHUNKS.filter(chunk => ['emergency_red_flags', 'acute_recovery'].includes(chunk.id));
}

function forcedProfileChunks(profile) {
  if (isSelfProfile(profile)) return [];
  return KNOWLEDGE_CHUNKS.filter(chunk => chunk.id === 'caregiver');
}

function isSelfProfile(profile = {}) {
  const relation = String(profile.relation || profile.relationToUser || '').toLowerCase();
  return relation === 'self' || relation === 'myself';
}

function isChunkEligible(chunk, query, profile) {
  if (chunk.id !== 'caregiver') return true;
  if (!isSelfProfile(profile)) return true;
  return /mother|father|parent|child|sibling|friend|caregiver|elderly|dependent|guardian|family|wife|husband|spouse|son|daughter/.test(query);
}

function dedupeChunks(chunks) {
  const seen = new Set();
  const result = [];
  for (const chunk of chunks) {
    if (!chunk || seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    result.push(chunk);
  }
  return result;
}

function rowToChunk(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    keywords: safeJson(row.keywords_json) || [],
    alwaysInclude: Boolean(row.always_include),
  };
}

function addScore(scores, id, amount, source) {
  const existing = scores.get(id) || { score: 0, sources: new Set() };
  existing.score += amount;
  existing.sources.add(source);
  scores.set(id, existing);
}

function hasLexicalRetrievalSource(entry) {
  return Boolean(entry?.sources?.has('keyword') || entry?.sources?.has('forced'));
}

function shouldIncludeOptionalChunk(item, forcedIds, hasLexicalOptionalMatch) {
  if (forcedIds.has(item.chunk.id)) return true;
  if (!item.entry) return false;
  if (hasLexicalRetrievalSource(item.entry)) return item.score >= HYBRID_MIN_OPTIONAL_SCORE;
  if (item.entry.sources.has('semantic')) {
    return hasLexicalOptionalMatch
      ? item.score >= SEMANTIC_RESCUE_SCORE
      : item.score >= HYBRID_MIN_OPTIONAL_SCORE;
  }
  if (hasLexicalOptionalMatch) return false;
  return item.score >= 8;
}

function normalizeEmbedding(value) {
  if (!Array.isArray(value)) return [];
  const vector = Array.isArray(value[0]) ? value[0] : value;
  return vector.map(Number).filter(Number.isFinite);
}

function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  if (!len) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function withTimeout(promise, timeoutMs, message) {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
