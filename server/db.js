import sqlite3 from '@libsql/sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { KNOWLEDGE_CHUNKS } from './data/knowledgeChunks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Support Turso connection via env vars
let isRemoteDb = false;
let connectionUrl = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'vita.db');
if (!connectionUrl.startsWith('file:') && !connectionUrl.startsWith('libsql:') && !connectionUrl.startsWith('http')) {
  connectionUrl = 'file:' + connectionUrl;
}

if (process.env.TURSO_DATABASE_URL) {
  isRemoteDb = true;
  connectionUrl = process.env.TURSO_DATABASE_URL.trim();
  // If an auth token is provided and not already in the URL, append it safely.
  if (process.env.TURSO_AUTH_TOKEN && !connectionUrl.includes('authToken=')) {
    const parsed = new URL(connectionUrl);
    parsed.searchParams.set('authToken', process.env.TURSO_AUTH_TOKEN.trim());
    connectionUrl = parsed.toString();
  }
}

// Ensure data directory exists if it's a local database
if (!isRemoteDb) {
  const localPath = connectionUrl.replace(/^file:/, '');
  const dataDir = path.dirname(localPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

let db;

export async function getDb() {
  if (db) return db;
  
  db = await open({
    filename: connectionUrl,
    driver: sqlite3.Database
  });

  if (!isRemoteDb) {
    await db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
  }
  
  await initDb();
  return db;
}

async function initDb() {
  // We perform a safe migration for the 'users' table to make password_hash nullable
  // and add new fields for Google OAuth.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users_new (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      auth_provider TEXT DEFAULT 'local',
      google_sub TEXT UNIQUE,
      first_name TEXT,
      last_name TEXT,
      date_of_birth TEXT,
      gender TEXT,
      account_setup_completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME
    );
  `);

  // Check if old users table exists
  const tableExists = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
  if (tableExists) {
    // Check if it already has auth_provider (i.e. already migrated)
    const columnsInfo = await db.all("PRAGMA table_info(users)");
    const hasAuthProvider = columnsInfo.some(col => col.name === 'auth_provider');
    if (!hasAuthProvider) {
      // Migrate data
      await db.exec(`
        INSERT INTO users_new (id, email, password_hash, created_at, updated_at, last_login_at)
        SELECT id, email, password_hash, created_at, updated_at, last_login_at FROM users;
      `);
      
      // Drop old and rename new
      await db.exec(`DROP TABLE users;`);
      await db.exec(`ALTER TABLE users_new RENAME TO users;`);
    } else {
      // If it already exists, just drop the new table that was created for safety
      await db.exec(`DROP TABLE IF EXISTS users_new;`);
    }
  } else {
    // No existing table, just rename
    await db.exec(`ALTER TABLE users_new RENAME TO users;`);
  }

  await ensureColumn('users', 'first_name', 'TEXT');
  await ensureColumn('users', 'last_name', 'TEXT');
  await ensureColumn('users', 'date_of_birth', 'TEXT');
  await ensureColumn('users', 'gender', 'TEXT');
  await ensureColumn('users', 'account_setup_completed_at', 'DATETIME');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      relation TEXT NOT NULL,
      relation_other TEXT,
      photo_path TEXT,
      avatar_initials TEXT,
      avatar_color TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS patient_states (
      id TEXT PRIMARY KEY,
      profile_id TEXT UNIQUE NOT NULL,
      structured_profile_json TEXT,
      profile_summary_text TEXT,
      profile_summary_updated_at DATETIME,
      timezone TEXT DEFAULT 'Asia/Kolkata',
      current_day INTEGER DEFAULT 1,
      protocol_start_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS checkins (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      day INTEGER NOT NULL,
      phase TEXT NOT NULL,
      questions_json TEXT NOT NULL,
      answers_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal_type TEXT,
      description TEXT,
      target TEXT,
      metrics TEXT,
      frequency TEXT,
      status TEXT DEFAULT 'active',
      start_date DATETIME,
      end_date DATETIME,
      progress_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      goal_id TEXT,
      type TEXT DEFAULT 'general',
      title TEXT DEFAULT 'General chat',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      profile_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      resend_available_at DATETIME NOT NULL,
      attempts INTEGER DEFAULT 0,
      consumed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS active_profile_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      last_active_profile_id TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (last_active_profile_id) REFERENCES profiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS safety_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      profile_id TEXT,
      message_preview TEXT,
      level TEXT NOT NULL,
      action TEXT NOT NULL,
      domain TEXT,
      reasons_json TEXT,
      matched_rules_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS safety_mode_transitions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      from_mode TEXT,
      to_mode TEXT NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS programs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      program_type TEXT NOT NULL,
      duration_days INTEGER NOT NULL,
      start_date TEXT,
      status TEXT NOT NULL DEFAULT 'setup_pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS program_days (
      id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      day_number INTEGER NOT NULL,
      calendar_date TEXT,
      status TEXT NOT NULL DEFAULT 'upcoming',
      summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(program_id, day_number),
      FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      program_day_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      target_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      completion_value REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (program_day_id) REFERENCES program_days(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      reminder_type TEXT NOT NULL,
      title TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'in_app',
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scheduled_checkins (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      goal_id TEXT,
      relation TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      scheduled_for DATETIME NOT NULL,
      delivered_at DATETIME,
      completed_at DATETIME,
      title TEXT NOT NULL,
      push_title TEXT NOT NULL,
      push_body TEXT NOT NULL,
      in_app_title TEXT NOT NULL,
      in_app_body TEXT NOT NULL,
      detailed_chat_message TEXT NOT NULL,
      response_options_json TEXT NOT NULL,
      metadata_json TEXT,
      source TEXT DEFAULT 'wellness_chat',
      category TEXT,
      channel TEXT DEFAULT 'in_app',
      shown_at DATETIME,
      acknowledged_at DATETIME,
      dismissed_at DATETIME,
      failed_at DATETIME,
      failed_reason TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      series_id TEXT,
      response TEXT,
      issue_type TEXT,
      issue_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS goal_progress (
      id TEXT PRIMARY KEY,
      scope_key TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      goal_id TEXT,
      total_scheduled_checkins INTEGER NOT NULL DEFAULT 0,
      completed_checkins INTEGER NOT NULL DEFAULT 0,
      partial_checkins INTEGER NOT NULL DEFAULT 0,
      missed_checkins INTEGER NOT NULL DEFAULT 0,
      issue_checkins INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      last_checkin_at DATETIME,
      next_checkin_at DATETIME,
      current_day INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS checkin_issues (
      id TEXT PRIMARY KEY,
      checkin_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      goal_id TEXT,
      issue_type TEXT NOT NULL,
      user_note TEXT,
      suggestion_given TEXT,
      carry_forward_to_next_checkin INTEGER NOT NULL DEFAULT 1,
      resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (checkin_id) REFERENCES scheduled_checkins(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      keywords_json TEXT,
      always_include INTEGER NOT NULL DEFAULT 0,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      embedding_json TEXT,
      embedding_model TEXT,
      embedded_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      upload_type TEXT NOT NULL,
      original_filename TEXT,
      stored_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'uploaded',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS prescriptions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      upload_id TEXT NOT NULL,
      ocr_text TEXT,
      extracted_json TEXT,
      user_confirmed_json TEXT,
      confirmation_status TEXT NOT NULL DEFAULT 'pending_user_confirmation',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      profile_id TEXT,
      action TEXT NOT NULL,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      run_after DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  // Safe additive migrations for messages table
  try { await db.exec('ALTER TABLE messages ADD COLUMN conversation_id TEXT;'); } catch (e) { /* ignore if exists */ }
  try { await db.exec('ALTER TABLE messages ADD COLUMN safety_level TEXT;'); } catch (e) { /* ignore if exists */ }
  try { await db.exec('ALTER TABLE messages ADD COLUMN safety_action TEXT;'); } catch (e) { /* ignore if exists */ }
  try { await db.exec('ALTER TABLE messages ADD COLUMN safety_domain TEXT;'); } catch (e) { /* ignore if exists */ }

  // Safe additive migrations for patient_states table
  try { await db.exec("ALTER TABLE patient_states ADD COLUMN safety_mode TEXT DEFAULT 'normal';"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE patient_states ADD COLUMN safety_mode_started_at DATETIME;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE patient_states ADD COLUMN pending_safety_action TEXT;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE patient_states ADD COLUMN last_safety_level TEXT;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE patient_states ADD COLUMN crisis_template_history_json TEXT;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE patient_states ADD COLUMN pending_followup_offer_json TEXT;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE patient_states ADD COLUMN timezone TEXT DEFAULT 'Asia/Kolkata';"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE patient_states ADD COLUMN profile_summary_text TEXT;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE patient_states ADD COLUMN profile_summary_updated_at DATETIME;"); } catch (e) { /* ignore */ }

  // Safe additive migrations for scheduled_checkins unified reminder lifecycle.
  try { await db.exec("ALTER TABLE scheduled_checkins ADD COLUMN source TEXT DEFAULT 'wellness_chat';"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE scheduled_checkins ADD COLUMN category TEXT;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE scheduled_checkins ADD COLUMN channel TEXT DEFAULT 'in_app';"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE scheduled_checkins ADD COLUMN shown_at DATETIME;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE scheduled_checkins ADD COLUMN acknowledged_at DATETIME;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE scheduled_checkins ADD COLUMN dismissed_at DATETIME;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE scheduled_checkins ADD COLUMN failed_at DATETIME;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE scheduled_checkins ADD COLUMN failed_reason TEXT;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE scheduled_checkins ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;"); } catch (e) { /* ignore */ }
  try { await db.exec("ALTER TABLE scheduled_checkins ADD COLUMN series_id TEXT;"); } catch (e) { /* ignore */ }

  await initKnowledgeBase();
  
  // Enable foreign keys
  await db.exec('PRAGMA foreign_keys = ON;');
}

async function ensureColumn(tableName, columnName, definition) {
  const columnsInfo = await db.all(`PRAGMA table_info(${tableName})`);
  if (!columnsInfo.some(col => col.name === columnName)) {
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

async function initKnowledgeBase() {
  try {
    await db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts
      USING fts5(id UNINDEXED, title, content, keywords);
    `);
  } catch (error) {
    console.warn('[Knowledge Base] SQLite FTS5 unavailable; falling back to in-memory retrieval.', error.message);
    return;
  }

  for (const chunk of KNOWLEDGE_CHUNKS) {
    const contentHash = hashText(`${chunk.title}\n${chunk.content}`);
    await db.run(`
      INSERT INTO knowledge_chunks (
        id, title, content, keywords_json, always_include, token_estimate, content_hash
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        keywords_json = excluded.keywords_json,
        always_include = excluded.always_include,
        token_estimate = excluded.token_estimate,
        embedding_json = CASE
          WHEN knowledge_chunks.content_hash = excluded.content_hash THEN knowledge_chunks.embedding_json
          ELSE NULL
        END,
        embedding_model = CASE
          WHEN knowledge_chunks.content_hash = excluded.content_hash THEN knowledge_chunks.embedding_model
          ELSE NULL
        END,
        embedded_at = CASE
          WHEN knowledge_chunks.content_hash = excluded.content_hash THEN knowledge_chunks.embedded_at
          ELSE NULL
        END,
        content_hash = excluded.content_hash,
        updated_at = CURRENT_TIMESTAMP
    `, [
      chunk.id,
      chunk.title,
      chunk.content,
      JSON.stringify(chunk.keywords || []),
      chunk.alwaysInclude ? 1 : 0,
      estimateTokens(chunk.content),
      contentHash,
    ]);
  }

  await db.run('DELETE FROM knowledge_chunks_fts');
  for (const chunk of KNOWLEDGE_CHUNKS) {
    await db.run(
      'INSERT INTO knowledge_chunks_fts (id, title, content, keywords) VALUES (?, ?, ?, ?)',
      [chunk.id, chunk.title, chunk.content, (chunk.keywords || []).join(' ')]
    );
  }
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function estimateTokens(text = '') {
  return Math.ceil(String(text).length / 4);
}
