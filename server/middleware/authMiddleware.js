import { getDb } from '../db.js';

export async function requireAuth(req, res, next) {
  const sessionId = req.cookies.sessionId;
  
  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const db = await getDb();
    const session = await db.get(`
      SELECT user_id, expires_at FROM sessions WHERE id = ?
    `, [sessionId]);

    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    if (new Date(session.expires_at) < new Date()) {
      await db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
      return res.status(401).json({ error: 'Session expired' });
    }

    // Attach user_id to request
    req.user = { id: session.user_id };
    next();
  } catch (error) {
    console.error('[Auth Middleware]', error);
    res.status(500).json({ error: 'Internal server error during authentication' });
  }
}
