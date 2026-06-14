/**
 * Anandaya AI Agent — Express Server
 * Entry point for the backend API.
 */

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { getDb } from './db.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profile.js';
import uploadRoutes from './routes/uploads.js';
import locationRoutes from './routes/location.js';
import scheduledCheckinRoutes from './routes/scheduledCheckins.js';
import { getAIProviderSummary } from './services/ai.js';
import { startReminderScheduler } from './services/reminderScheduler.js';
import { processJobs } from './services/jobQueue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security & Middleware ──────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline styles/scripts for dev
}));
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Rate limiting: 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please slow down and try again in a few minutes.' },
});
app.use('/api/', limiter);

import programRoutes from './routes/programs.js';

// ── Health Check ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API Routes ─────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api', programRoutes);
app.use('/api', uploadRoutes);
app.use('/api', locationRoutes);
app.use('/api', scheduledCheckinRoutes);

// ── Production Static File Serving ─────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const distPath = join(__dirname, '..', 'dist');
  app.use(express.static(distPath));

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(join(distPath, 'index.html'));
    }
  });
}

// ── Error Handler ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
});

// ── Start Server ───────────────────────────────────────────────
async function startServer() {
  try {
    await getDb(); // Initialize SQLite schema
    console.log('[DB] SQLite Database initialized');
    startReminderScheduler();
    
    // Start background job queue processor
    processJobs().catch(e => console.error('[JobQueue] Error starting processJobs:', e));

    app.listen(PORT, () => {
      const aiSummary = getAIProviderSummary();
      console.log(`\n🏥 Anandaya AI Server`);
      console.log(`   ├─ API:  http://localhost:${PORT}/api`);
      console.log(`   ├─ Mode: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   ├─ AI:   ${aiSummary.primary}`);
      console.log(`   ├─ Fallbacks: ${aiSummary.fallbacks.join(' → ') || 'none configured'}`);
      console.log(`   ├─ Task routing: ${Object.entries(aiSummary.taskProviders)
        .map(([task, config]) => `${task}=${config.fallbackOrder.join(' → ')}`)
        .join('; ')}`);
      console.log(`   └─ HF tasks: ${Object.entries(aiSummary.huggingFaceTasks)
        .map(([task, config]) => `${task}=${config.configured ? config.model : 'not configured'}`)
        .join(', ')}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
