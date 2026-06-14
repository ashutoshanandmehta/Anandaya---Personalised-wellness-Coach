import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { sendOtpEmail } from './gmailService.js';

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const OTP_RESEND_MS = 30 * 1000;     // 30 seconds
const MAX_ATTEMPTS = 5;

// Cryptographically secure random 6-digit number
function generateOtp() {
  return crypto.randomInt(100000, 999999).toString();
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

/**
 * Creates an OTP, saves it to the database, and sends it via email.
 */
export async function requestOtp(email, purpose) {
  const db = await getDb();
  
  // Check if there's a recent OTP blocking resend
  const recent = await db.get(`
    SELECT resend_available_at FROM otp_codes 
    WHERE email = ? AND purpose = ? AND consumed_at IS NULL 
    ORDER BY created_at DESC LIMIT 1
  `, [email, purpose]);

  if (recent && new Date(recent.resend_available_at) > new Date()) {
    const waitSecs = Math.ceil((new Date(recent.resend_available_at) - new Date()) / 1000);
    throw new Error(`Please wait ${waitSecs} seconds before requesting a new code.`);
  }

  const rawOtp = generateOtp();
  const hashedOtp = hashOtp(rawOtp);
  const now = Date.now();
  
  const expiresAt = new Date(now + OTP_EXPIRY_MS).toISOString();
  const resendAvailableAt = new Date(now + OTP_RESEND_MS).toISOString();
  const id = uuidv4();

  await db.run(`
    INSERT INTO otp_codes (id, email, otp_hash, purpose, expires_at, resend_available_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, email, hashedOtp, purpose, expiresAt, resendAvailableAt]);

  // Send the email (or log if dev fallback is enabled)
  await sendOtpEmail({ to: email, otp: rawOtp, purpose });
}

/**
 * Verifies an OTP against the database.
 */
export async function verifyOtp(email, purpose, submittedOtp) {
  const db = await getDb();
  
  // Get the latest unconsumed OTP
  const record = await db.get(`
    SELECT * FROM otp_codes 
    WHERE email = ? AND purpose = ? AND consumed_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `, [email, purpose]);

  if (!record) {
    throw new Error('No valid verification code found. Please request a new one.');
  }

  if (new Date(record.expires_at) < new Date()) {
    throw new Error('This verification code has expired. Please request a new one.');
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw new Error('Too many failed attempts. Please request a new verification code.');
  }

  const hashedSubmitted = hashOtp(submittedOtp);

  if (hashedSubmitted !== record.otp_hash) {
    // Increment attempts
    await db.run(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`, [record.id]);
    throw new Error('Invalid verification code.');
  }

  // Mark as consumed
  await db.run(`UPDATE otp_codes SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?`, [record.id]);
  
  return true;
}
