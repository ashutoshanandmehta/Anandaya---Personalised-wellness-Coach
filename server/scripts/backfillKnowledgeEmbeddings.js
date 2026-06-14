import dotenv from 'dotenv';
import { backfillKnowledgeChunkEmbeddings } from '../services/protocolRetriever.js';

dotenv.config();

const force = process.argv.includes('--force');

try {
  const result = await backfillKnowledgeChunkEmbeddings({ force });
  console.log('[RAG Embeddings] Knowledge chunk embedding backfill complete.', {
    updated: result.updated,
    model: result.model,
    force,
  });
  process.exit(0);
} catch (error) {
  console.error('[RAG Embeddings] Backfill failed:', error.message);
  process.exit(1);
}
