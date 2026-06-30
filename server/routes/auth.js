import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { requestOtp, verifyOtp } from '../services/otpService.js';
import { hashPassword, verifyPassword } from '../services/passwordService.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = Router();
const SESSION_EXPIRY_DAYS = 30;
const DASHBOARD_TIMEZONE = 'Asia/Kolkata';
const AVATAR_COLORS = ['#D95C2B', '#E18B4F', '#C8653C', '#B65B34', '#E6A23C', '#A75A42'];

function setSessionCookie(res, sessionId) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('sessionId', sessionId, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax',
    maxAge: SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000, // 30 days
  });
}

function getServerClock() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DASHBOARD_TIMEZONE,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
  let greetingPeriod = 'morning';
  if (hour < 5) greetingPeriod = 'night';
  else if (hour < 12) greetingPeriod = 'morning';
  else if (hour < 17) greetingPeriod = 'afternoon';
  else if (hour < 21) greetingPeriod = 'evening';
  else greetingPeriod = 'night';

  return {
    serverNow: now.toISOString(),
    serverTimezone: DASHBOARD_TIMEZONE,
    greetingPeriod,
  };
}

function normalizeMobilePlatform(value = '') {
  return String(value || '').trim().toLowerCase() === 'android' ? 'android' : '';
}

function isMobileOAuthState(value = '') {
  return String(value || '').trim().toLowerCase() === 'mobile_android';
}

function getMobileCallbackUrl(code) {
  return `anandaya://auth/callback?code=${encodeURIComponent(code)}`;
}

async function ensureMobileAuthCodeTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_auth_codes (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      consumed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

async function createMobileAuthCode(db, userId) {
  await ensureMobileAuthCodeTable(db);
  await db.run("DELETE FROM mobile_auth_codes WHERE datetime(expires_at) <= datetime('now') OR consumed_at IS NOT NULL");
  const code = uuidv4();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await db.run(
    'INSERT INTO mobile_auth_codes (code, user_id, expires_at) VALUES (?, ?, ?)',
    [code, userId, expiresAt]
  );
  return code;
}

async function createSessionForUser(db, userId) {
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.run(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
    [sessionId, userId, expiresAt]
  );
  return { sessionId, expiresAt };
}

function buildUserPayload(user = {}) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name || '',
    lastName: user.last_name || '',
    dateOfBirth: user.date_of_birth || '',
    gender: user.gender || '',
    accountSetupCompletedAt: user.account_setup_completed_at || null,
  };
}

function getInitials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function getAvatarColor(str = '') {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function parseDateOfBirth(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  if (date.getTime() > Date.now()) return null;
  return { raw, year, month, day };
}

function getTodayInDashboardTimezone() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DASHBOARD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function calculateAge(dateOfBirth) {
  const parsed = parseDateOfBirth(dateOfBirth);
  if (!parsed) return null;
  const today = getTodayInDashboardTimezone();
  let age = today.year - parsed.year;
  if (today.month < parsed.month || (today.month === parsed.month && today.day < parsed.day)) {
    age -= 1;
  }
  return age >= 0 && age <= 130 ? age : null;
}

function normalizeSetupText(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function upsertOwnerPatientState(db, { profileId, age, gender, dateOfBirth }) {
  const existing = await db.get('SELECT id, structured_profile_json FROM patient_states WHERE profile_id = ?', [profileId]);
  const structured = {
    ...parseJsonObject(existing?.structured_profile_json),
    ...(age !== null ? { age } : {}),
    sex: gender,
    date_of_birth: dateOfBirth,
  };

  if (existing) {
    await db.run(`
      UPDATE patient_states
      SET structured_profile_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE profile_id = ?
    `, [JSON.stringify(structured), profileId]);
    return;
  }

  await db.run(`
    INSERT INTO patient_states (id, profile_id, structured_profile_json, current_day)
    VALUES (?, ?, ?, 0)
  `, [uuidv4(), profileId, JSON.stringify(structured)]);
}

// ── Auth Endpoints ──────────────────────────────────────────────

router.get('/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_CALLBACK_URL;
  const mobilePlatform = normalizeMobilePlatform(req.query.platform);
  const state = mobilePlatform === 'android' ? 'mobile_android' : '';

  if (process.env.NODE_ENV === 'development' && (!clientId || !redirectUri)) {
    // In development mode, bypass the live Google authentication flow entirely if offline or missing keys
    const fallbackUri = redirectUri || 'http://localhost:3000/api/auth/google/callback';
    return res.redirect(`${fallbackUri}?code=mock_code_dev${state ? `&state=${encodeURIComponent(state)}` : ''}`);
  }

  if (!clientId || !redirectUri) {
    return res.status(500).send('Google OAuth is not configured');
  }
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20email%20profile&prompt=select_account${state ? `&state=${encodeURIComponent(state)}` : ''}`;
  res.redirect(authUrl);
});

router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const isMobileAndroid = isMobileOAuthState(state);
  if (!code) return res.status(400).send('No code provided');

  let sub = 'mock-google-sub-12345';
  let email = 'google-mock-user@anand.healthcare';

  if (code !== 'mock_code_dev') {
    try {
      // 1. Exchange code for tokens
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: process.env.GOOGLE_CALLBACK_URL,
        })
      });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) {
        console.error('Token exchange error:', tokenData);
        if (process.env.NODE_ENV === 'development') {
          console.warn('[Google Callback] Token exchange failed. Using dev mock fallback.');
        } else {
          const frontendUrl = process.env.FRONTEND_URL || '';
          return res.redirect(`${frontendUrl}/?error=google_auth_failed`);
        }
      } else {
        // 2. Fetch user profile
        const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const profileData = await profileResponse.json();
        if (!profileResponse.ok || !profileData.sub || !profileData.email) {
          console.error('Profile fetch error:', profileData);
          if (process.env.NODE_ENV === 'development') {
            console.warn('[Google Callback] Profile fetch failed. Using dev mock fallback.');
          } else {
            const frontendUrl = process.env.FRONTEND_URL || '';
            return res.redirect(`${frontendUrl}/?error=google_auth_failed`);
          }
        } else {
          sub = profileData.sub;
          email = profileData.email;
        }
      }
    } catch (error) {
      console.error('[Google Callback Network Error]', error);
      if (process.env.NODE_ENV === 'development') {
        console.warn('[Google Callback] Network failure. Falling back to dev mock user.');
      } else {
        const frontendUrl = process.env.FRONTEND_URL || '';
        return res.redirect(`${frontendUrl}/?error=internal_error`);
      }
    }
  }

  try {
    const db = await getDb();

    // 3. Find or create user
    let user = await db.get('SELECT * FROM users WHERE google_sub = ?', [sub]);
    
    if (!user) {
      // Check if email already exists
      user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
      if (user) {
        // Link Google to existing user
        await db.run(
          'UPDATE users SET google_sub = ?, auth_provider = ?, last_login_at = CURRENT_TIMESTAMP WHERE id = ?',
          [sub, user.password_hash ? 'both' : 'google', user.id]
        );
      } else {
        // Create new user
        const userId = uuidv4();
        await db.run(
          'INSERT INTO users (id, email, password_hash, auth_provider, google_sub, last_login_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
          [userId, email, null, 'google', sub]
        );
        user = { id: userId, email };
      }
    } else {
      // Update login timestamp
      await db.run('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    }

    if (isMobileAndroid) {
      const mobileCode = await createMobileAuthCode(db, user.id);
      return res.redirect(getMobileCallbackUrl(mobileCode));
    }

    // 4. Create session
    const { sessionId } = await createSessionForUser(db, user.id);

    setSessionCookie(res, sessionId);
    
    // Redirect to app shell
    const frontendUrl = process.env.FRONTEND_URL || '';
    res.redirect(`${frontendUrl}/`);
  } catch (error) {
    console.error('[Google Callback Database Error]', error);
    const frontendUrl = process.env.FRONTEND_URL || '';
    res.redirect(`${frontendUrl}/?error=internal_error`);
  }
});

router.post('/mobile/exchange', async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing mobile auth code.' });

    const db = await getDb();
    await ensureMobileAuthCodeTable(db);

    const row = await db.get(`
      SELECT code, user_id, expires_at, consumed_at
      FROM mobile_auth_codes
      WHERE code = ?
    `, [code]);

    if (!row || row.consumed_at || new Date(row.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Invalid or expired mobile auth code.' });
    }

    await db.run(
      'UPDATE mobile_auth_codes SET consumed_at = CURRENT_TIMESTAMP WHERE code = ? AND consumed_at IS NULL',
      [code]
    );

    const { sessionId, expiresAt } = await createSessionForUser(db, row.user_id);
    setSessionCookie(res, sessionId);

    res.json({
      success: true,
      sessionId,
      expiresAt,
      userId: row.user_id,
    });
  } catch (error) {
    console.error('[Mobile Auth Exchange]', error);
    res.status(500).json({ error: 'Could not complete mobile sign-in.' });
  }
});

router.post('/request-otp', async (req, res) => {
  try {
    const { email, purpose } = req.body;
    if (!email || !purpose) return res.status(400).json({ error: 'Email and purpose are required.' });
    
    // For signup, ensure user doesn't already exist
    if (purpose === 'signup') {
      const db = await getDb();
      const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
      if (existing) return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // For forgot-password, ensure user exists
    if (purpose === 'forgot-password') {
      const db = await getDb();
      const existing = await db.get('SELECT id, password_hash FROM users WHERE email = ?', [email]);
      if (!existing) return res.status(400).json({ error: 'No account found with this email.' });
      if (!existing.password_hash) return res.status(400).json({ error: 'This account uses Google Login.' });
    }

    await requestOtp(email, purpose);
    res.json({ success: true, message: 'OTP sent successfully.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { email, purpose, otp } = req.body;
    await verifyOtp(email, purpose, otp);
    res.json({ success: true, message: 'OTP verified successfully.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/signup', async (req, res) => {
  try {
    const { email, password, otp } = req.body;
    if (!email || !password || !otp) return res.status(400).json({ error: 'Missing fields' });

    // Verify the OTP one last time to ensure security
    await verifyOtp(email, 'signup', otp);

    const db = await getDb();
    
    // Hash password
    const hashed = await hashPassword(password);
    const userId = uuidv4();

    // Start transaction
    await db.exec('BEGIN TRANSACTION');
    try {
      await db.run(
        'INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)',
        [userId, email, hashed]
      );

      // Create session
      const sessionId = uuidv4();
      const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await db.run(
        'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
        [sessionId, userId, expiresAt]
      );

      await db.exec('COMMIT');
      
      setSessionCookie(res, sessionId);
      res.json({ success: true, userId });
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }
  } catch (error) {
    console.error('[Signup]', error);
    res.status(400).json({ error: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    if (!user.password_hash) {
      return res.status(401).json({ error: 'This account uses Google Login. Please continue with Google.' });
    }

    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Invalid email or password' });

    // Update last login
    await db.run('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

    // Create session
    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await db.run(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
      [sessionId, user.id, expiresAt]
    );

    setSessionCookie(res, sessionId);
    res.json({ success: true, userId: user.id });
  } catch (error) {
    console.error('[Login]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  try {
    const sessionId = req.cookies.sessionId;
    const db = await getDb();
    await db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
    res.clearCookie('sessionId');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/forgot-password/reset', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    await verifyOtp(email, 'forgot-password', otp);

    const db = await getDb();
    const hashed = await hashPassword(newPassword);
    await db.run('UPDATE users SET password_hash = ? WHERE email = ?', [hashed, email]);
    
    // Optionally invalidate all active sessions for security
    const user = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (user) {
      await db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    }

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const user = await db.get(`
      SELECT id, email, first_name, last_name, date_of_birth, gender, account_setup_completed_at
      FROM users
      WHERE id = ?
    `, [req.user.id]);
    
    // Also fetch their active profile preference
    const pref = await db.get('SELECT last_active_profile_id FROM active_profile_preferences WHERE user_id = ?', [req.user.id]);
    
    res.json({
      user: buildUserPayload(user),
      activeProfileId: pref ? pref.last_active_profile_id : null,
      ...getServerClock(),
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/account-setup', requireAuth, async (req, res) => {
  try {
    const firstName = normalizeSetupText(req.body.firstName);
    const lastName = normalizeSetupText(req.body.lastName);
    const email = normalizeSetupText(req.body.email).toLowerCase();
    const dateOfBirth = String(req.body.dateOfBirth || '').trim();
    const gender = normalizeSetupText(req.body.gender);

    if (!firstName || !lastName || !email || !dateOfBirth || !gender) {
      return res.status(400).json({ error: 'First name, last name, email, date of birth, and gender are required.' });
    }
    if (firstName.length > 80 || lastName.length > 80 || gender.length > 40) {
      return res.status(400).json({ error: 'Please keep account details short and readable.' });
    }

    const parsedDob = parseDateOfBirth(dateOfBirth);
    const age = calculateAge(dateOfBirth);
    if (!parsedDob || age === null) {
      return res.status(400).json({ error: 'Please enter a valid date of birth.' });
    }

    const db = await getDb();
    const existingUser = await db.get('SELECT id, email FROM users WHERE id = ?', [req.user.id]);
    if (!existingUser) return res.status(401).json({ error: 'Unauthorized' });
    if (email !== String(existingUser.email || '').trim().toLowerCase()) {
      return res.status(400).json({ error: 'Email must match the signed-in account.' });
    }

    const fullName = `${firstName} ${lastName}`.trim();
    const initials = getInitials(fullName);
    const color = getAvatarColor(fullName || existingUser.id);
    let ownerProfileId;

    await db.exec('BEGIN TRANSACTION');
    try {
      await db.run(`
        UPDATE users
        SET first_name = ?,
            last_name = ?,
            date_of_birth = ?,
            gender = ?,
            account_setup_completed_at = COALESCE(account_setup_completed_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [firstName, lastName, dateOfBirth, gender, req.user.id]);

      let ownerProfile = await db.get(`
        SELECT *
        FROM profiles
        WHERE user_id = ?
          AND (
            LOWER(relation) IN ('myself', 'self')
            OR LOWER(name) = LOWER(?)
          )
        ORDER BY
          CASE WHEN LOWER(relation) IN ('myself', 'self') THEN 0 ELSE 1 END,
          created_at ASC
        LIMIT 1
      `, [req.user.id, fullName]);

      if (ownerProfile) {
        ownerProfileId = ownerProfile.id;
        await db.run(`
          UPDATE profiles
          SET name = ?,
              relation = 'Myself',
              relation_other = NULL,
              avatar_initials = ?,
              avatar_color = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [fullName, initials, color, ownerProfileId]);
      } else {
        ownerProfileId = uuidv4();
        await db.run(`
          INSERT INTO profiles (id, user_id, name, relation, relation_other, avatar_initials, avatar_color)
          VALUES (?, ?, ?, 'Myself', NULL, ?, ?)
        `, [ownerProfileId, req.user.id, fullName, initials, color]);
      }

      await upsertOwnerPatientState(db, {
        profileId: ownerProfileId,
        age,
        gender,
        dateOfBirth,
      });

      await db.run(`
        INSERT INTO active_profile_preferences (id, user_id, last_active_profile_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET last_active_profile_id = ?, updated_at = CURRENT_TIMESTAMP
      `, [uuidv4(), req.user.id, ownerProfileId, ownerProfileId]);

      await db.exec('COMMIT');
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }

    const user = await db.get(`
      SELECT id, email, first_name, last_name, date_of_birth, gender, account_setup_completed_at
      FROM users
      WHERE id = ?
    `, [req.user.id]);
    const profiles = await db.all('SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);

    res.json({
      success: true,
      user: buildUserPayload(user),
      profileId: ownerProfileId,
      activeProfileId: ownerProfileId,
      profiles,
      ...getServerClock(),
    });
  } catch (error) {
    console.error('[Account Setup]', error);
    res.status(500).json({ error: 'Failed to complete account setup' });
  }
});

export default router;
