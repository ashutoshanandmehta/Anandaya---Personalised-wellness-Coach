/**
 * uploads.js — Phase 5: Uploads & OCR Confirmation Flow
 *
 * Endpoints:
 *   POST   /api/profiles/:profileId/uploads          — upload a file (photo or prescription)
 *   GET    /api/profiles/:profileId/uploads          — list all uploads for a profile
 *   GET    /api/uploads/:uploadId/download           — serve stored file (auth required)
 *   DELETE /api/uploads/:uploadId                    — soft-delete an upload
 *   POST   /api/prescriptions/:prescriptionId/confirm  — user confirms/edits extracted OCR data
 *   GET    /api/profiles/:profileId/prescriptions    — list prescriptions for a profile
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireProfileOwnership } from '../middleware/profileOwnershipMiddleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Storage Config ──────────────────────────────────────────────

const UPLOAD_BASE = path.join(__dirname, '..', '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_BASE, { recursive: true });

const ALLOWED_TYPES = {
  'image/jpeg':      'jpg',
  'image/jpg':       'jpg',
  'image/png':       'png',
  'image/webp':      'webp',
  'application/pdf': 'pdf',
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const profileDir = path.join(UPLOAD_BASE, req.params.profileId || 'unknown');
    fs.mkdirSync(profileDir, { recursive: true });
    cb(null, profileDir);
  },
  filename: (req, file, cb) => {
    const ext = ALLOWED_TYPES[file.mimetype] || 'bin';
    cb(null, `${uuidv4()}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed. Accepted: JPEG, PNG, WEBP, PDF.`));
    }
  },
});

// ── OCR Simulation ──────────────────────────────────────────────
// In production, replace this with a real OCR service (e.g., Google Cloud Vision, Tesseract).
// For now, we return a plausible structured mock based on filename hints.
async function simulateOCR(filePath, uploadType) {
  if (uploadType !== 'prescription') return null;

  // Simulate OCR extraction delay
  await new Promise(r => setTimeout(r, 200));

  return {
    raw_text: `
[Simulated OCR — replace with real Vision API in production]

Dr. Mehta's Clinic
Patient Rx — Date: ${new Date().toLocaleDateString('en-IN')}

1. Tab. Metformin 500mg — 1-0-1 (with meals) × 30 days
2. Cap. Pantoprazole 40mg — 1-0-0 (before breakfast) × 15 days
3. Tab. Vitamin D3 60000 IU — 1 weekly × 8 weeks

Follow-up: 4 weeks
    `.trim(),
    extracted_medications: [
      { name: 'Metformin 500mg',       dose: '500mg', frequency: '1-0-1', duration: '30 days', instructions: 'with meals' },
      { name: 'Pantoprazole 40mg',     dose: '40mg',  frequency: '1-0-0', duration: '15 days', instructions: 'before breakfast' },
      { name: 'Vitamin D3 60000 IU',  dose: '60000 IU', frequency: 'weekly', duration: '8 weeks', instructions: '' },
    ],
    follow_up_date: null,
    doctor_name: 'Dr. Mehta',
  };
}

// ── Router ──────────────────────────────────────────────────────

const router = Router();
router.use(requireAuth);

// ── POST /api/profiles/:profileId/uploads — Upload a file ──────
router.post(
  '/profiles/:profileId/uploads',
  requireProfileOwnership,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'File too large. Maximum size is 10 MB.' });
        }
        return res.status(400).json({ error: err.message });
      }
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded. Use multipart/form-data with field name "file".' });
      }

      const db = await getDb();
      const { profileId } = req.params;
      const uploadType = req.body.upload_type || 'general'; // 'photo' | 'prescription' | 'general'

      // Compute SHA-256 for deduplication / integrity
      const fileBuffer = fs.readFileSync(req.file.path);
      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      const uploadId = `upl_${uuidv4()}`;

      await db.run(
        `INSERT INTO uploads (id, profile_id, user_id, upload_type, original_filename, stored_filename, mime_type, size_bytes, sha256, storage_path, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded')`,
        [
          uploadId,
          profileId,
          req.user.id,
          uploadType,
          req.file.originalname,
          req.file.filename,
          req.file.mimetype,
          req.file.size,
          sha256,
          req.file.path,
        ]
      );

      // Audit log
      await db.run(
        `INSERT INTO audit_logs (id, user_id, profile_id, action, metadata_json) VALUES (?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          req.user.id,
          profileId,
          'file_upload',
          JSON.stringify({ uploadId, uploadType, filename: req.file.originalname, size: req.file.size }),
        ]
      );

      const response = {
        id: uploadId,
        upload_type: uploadType,
        original_filename: req.file.originalname,
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
        status: 'uploaded',
      };

      // If prescription, run OCR and create prescription record
      if (uploadType === 'prescription') {
        const ocrResult = await simulateOCR(req.file.path, uploadType);
        const prescriptionId = `rx_${uuidv4()}`;

        await db.run(
          `INSERT INTO prescriptions (id, profile_id, upload_id, ocr_text, extracted_json, confirmation_status)
           VALUES (?, ?, ?, ?, ?, 'pending_user_confirmation')`,
          [
            prescriptionId,
            profileId,
            uploadId,
            ocrResult?.raw_text || null,
            ocrResult ? JSON.stringify(ocrResult.extracted_medications) : null,
          ]
        );

        response.prescription_id = prescriptionId;
        response.ocr_preview = ocrResult?.extracted_medications || null;
        response.confirmation_required = true;
        response.message = 'Prescription uploaded! Please review the extracted medications and confirm or edit them.';
      } else {
        response.message = 'File uploaded successfully.';

        // If photo upload, update profile photo_path
        if (uploadType === 'photo') {
          await db.run(
            'UPDATE profiles SET photo_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [req.file.path, profileId]
          );
        }
      }

      res.status(201).json(response);
    } catch (error) {
      console.error('[Upload]', error);
      // Clean up file on DB error
      if (req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      res.status(500).json({ error: 'Upload failed. Please try again.' });
    }
  }
);

// ── GET /api/profiles/:profileId/uploads — List uploads ────────
router.get('/profiles/:profileId/uploads', requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const uploads = await db.all(
      `SELECT id, upload_type, original_filename, mime_type, size_bytes, status, created_at
       FROM uploads
       WHERE profile_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [req.params.profileId]
    );
    res.json(uploads);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list uploads' });
  }
});

// ── GET /api/uploads/:uploadId/download — Download/view a file ─
router.get('/uploads/:uploadId/download', async (req, res) => {
  try {
    const db = await getDb();
    const uploadRow = await db.get(
      'SELECT * FROM uploads WHERE id = ? AND deleted_at IS NULL',
      [req.params.uploadId]
    );
    if (!uploadRow) return res.status(404).json({ error: 'Upload not found' });

    // Authorization check: must own the profile
    const profile = await db.get('SELECT user_id FROM profiles WHERE id = ?', [uploadRow.profile_id]);
    if (!profile || profile.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!fs.existsSync(uploadRow.storage_path)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    res.setHeader('Content-Type', uploadRow.mime_type);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${uploadRow.original_filename || uploadRow.stored_filename}"`
    );
    res.sendFile(uploadRow.storage_path);
  } catch (error) {
    res.status(500).json({ error: 'Download failed' });
  }
});

// ── DELETE /api/uploads/:uploadId — Soft-delete ────────────────
router.delete('/uploads/:uploadId', async (req, res) => {
  try {
    const db = await getDb();
    const uploadRow = await db.get('SELECT * FROM uploads WHERE id = ? AND deleted_at IS NULL', [req.params.uploadId]);
    if (!uploadRow) return res.status(404).json({ error: 'Upload not found' });

    const profile = await db.get('SELECT user_id FROM profiles WHERE id = ?', [uploadRow.profile_id]);
    if (!profile || profile.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await db.run('UPDATE uploads SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.uploadId]);

    await db.run(
      `INSERT INTO audit_logs (id, user_id, profile_id, action, metadata_json) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), req.user.id, uploadRow.profile_id, 'file_delete', JSON.stringify({ uploadId: req.params.uploadId })]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ── POST /api/prescriptions/:prescriptionId/confirm — User confirms OCR ──
router.post('/prescriptions/:prescriptionId/confirm', async (req, res) => {
  try {
    const db = await getDb();
    const rx = await db.get('SELECT * FROM prescriptions WHERE id = ?', [req.params.prescriptionId]);
    if (!rx) return res.status(404).json({ error: 'Prescription not found' });

    // Auth
    const profile = await db.get('SELECT user_id FROM profiles WHERE id = ?', [rx.profile_id]);
    if (!profile || profile.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { confirmed_medications, action } = req.body;
    // action: 'confirm' | 'reject'

    if (action === 'reject') {
      await db.run(
        `UPDATE prescriptions SET confirmation_status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [rx.id]
      );
      return res.json({ success: true, status: 'rejected' });
    }

    if (!confirmed_medications || !Array.isArray(confirmed_medications)) {
      return res.status(400).json({ error: 'confirmed_medications array is required for confirmation' });
    }

    await db.run(
      `UPDATE prescriptions SET user_confirmed_json = ?, confirmation_status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [JSON.stringify(confirmed_medications), rx.id]
    );

    // Auto-create medication reminders from confirmed medications
    const createdReminders = [];
    for (const med of confirmed_medications) {
      const reminderId = `rem_${uuidv4()}`;
      const scheduleJson = buildMedicationSchedule(med.frequency);

      await db.run(
        `INSERT INTO reminders (id, profile_id, reminder_type, title, schedule_json, source) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          reminderId,
          rx.profile_id,
          'medication',
          `💊 ${med.name}${med.dose ? ' ' + med.dose : ''}`,
          JSON.stringify(scheduleJson),
          'prescription_ocr',
        ]
      );
      createdReminders.push({ id: reminderId, title: `💊 ${med.name}`, schedule: scheduleJson });
    }

    await db.run(
      `INSERT INTO audit_logs (id, user_id, profile_id, action, metadata_json) VALUES (?, ?, ?, ?, ?)`,
      [
        uuidv4(), req.user.id, rx.profile_id,
        'prescription_confirmed',
        JSON.stringify({ prescriptionId: rx.id, medicationsConfirmed: confirmed_medications.length }),
      ]
    );

    res.json({
      success: true,
      status: 'confirmed',
      reminders_created: createdReminders,
      message: `Great! ${confirmed_medications.length} medication reminder${confirmed_medications.length !== 1 ? 's' : ''} created from your prescription.`,
    });
  } catch (error) {
    console.error('[Prescription Confirm]', error);
    res.status(500).json({ error: 'Confirmation failed' });
  }
});

// ── GET /api/profiles/:profileId/prescriptions ─────────────────
router.get('/profiles/:profileId/prescriptions', requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const prescriptions = await db.all(
      `SELECT p.id, p.upload_id, p.ocr_text, p.extracted_json, p.user_confirmed_json,
              p.confirmation_status, p.created_at,
              u.original_filename, u.mime_type, u.size_bytes
       FROM prescriptions p
       JOIN uploads u ON p.upload_id = u.id
       WHERE p.profile_id = ?
       ORDER BY p.created_at DESC`,
      [req.params.profileId]
    );
    res.json(prescriptions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load prescriptions' });
  }
});

// ── Helper: Build medication reminder schedule ──────────────────
function buildMedicationSchedule(frequency) {
  if (!frequency) return { times: ['08:00'], repeat: 'daily' };

  const freq = frequency.toLowerCase();
  // Common Indian prescription notation: 1-0-1 = morning + night
  if (freq.match(/1-1-1/)) return { times: ['08:00', '14:00', '20:00'], repeat: 'daily' };
  if (freq.match(/1-0-1/)) return { times: ['08:00', '20:00'], repeat: 'daily' };
  if (freq.match(/1-0-0/)) return { times: ['08:00'], repeat: 'daily' };
  if (freq.match(/0-0-1/)) return { times: ['20:00'], repeat: 'daily' };
  if (freq.match(/twice|bid|2x/i)) return { times: ['08:00', '20:00'], repeat: 'daily' };
  if (freq.match(/thrice|tid|3x/i)) return { times: ['08:00', '14:00', '20:00'], repeat: 'daily' };
  if (freq.match(/weekly|once a week/i)) return { times: ['09:00'], repeat: 'weekly', day: 'monday' };

  return { times: ['08:00'], repeat: 'daily' };
}

export default router;
