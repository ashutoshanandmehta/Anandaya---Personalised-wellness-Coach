import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const {
  GMAIL_SENDER_EMAIL,
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
  NODE_ENV,
  ALLOW_DEV_OTP_LOGGING
} = process.env;

let transporter = null;

if (GMAIL_SENDER_EMAIL && GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: GMAIL_SENDER_EMAIL,
      clientId: GMAIL_CLIENT_ID,
      clientSecret: GMAIL_CLIENT_SECRET,
      refreshToken: GMAIL_REFRESH_TOKEN
    }
  });
}

/**
 * Sends an OTP email via Gmail API.
 * Falls back to console.log in development if ALLOW_DEV_OTP_LOGGING is true.
 */
export async function sendOtpEmail({ to, otp, purpose }) {
  const isDevFallbackAllowed = NODE_ENV === 'development' && ALLOW_DEV_OTP_LOGGING === 'true';

  const subject = purpose === 'signup' 
    ? 'Your Anandaya verification code' 
    : 'Reset your Anandaya password';

  const text = `Here is your 6-digit verification code: ${otp}\n\nIt expires in 5 minutes. Do not share this code with anyone.`;
  const html = `<p>Here is your 6-digit verification code:</p>
                <h2>${otp}</h2>
                <p>It expires in 5 minutes. Do not share this code with anyone.</p>`;

  if (!transporter) {
    if (isDevFallbackAllowed) {
      console.log(`\n=========================================`);
      console.log(`🔧 DEV OTP FALLBACK: Email to ${to}`);
      console.log(`🔧 PURPOSE: ${purpose}`);
      console.log(`🔧 OTP CODE: ${otp}`);
      console.log(`=========================================\n`);
      return;
    } else {
      throw new Error('Gmail credentials are not configured and development fallback is disabled or unavailable in production.');
    }
  }

  try {
    await transporter.sendMail({
      from: `"Anandaya" <${GMAIL_SENDER_EMAIL}>`,
      to,
      subject,
      text,
      html
    });
  } catch (error) {
    console.error('[GmailService] Failed to send email:', error);
    // If it fails to send but dev fallback is allowed, print it
    if (isDevFallbackAllowed) {
      console.log(`\n=========================================`);
      console.log(`🔧 DEV OTP FALLBACK (SEND FAILED): ${to} -> ${otp}`);
      console.log(`=========================================\n`);
      return;
    }
    throw new Error('Failed to send verification email. Please try again later.');
  }
}
