import { getDb } from '../db.js';

export async function requireProfileOwnership(req, res, next) {
  const profileId = req.params.profileId || req.body.profileId;

  if (!profileId) {
    return res.status(400).json({ error: 'Profile ID is required' });
  }

  try {
    const db = await getDb();
    const profile = await db.get(`
      SELECT id FROM profiles WHERE id = ? AND user_id = ?
    `, [profileId, req.user.id]);

    if (!profile) {
      return res.status(403).json({ error: 'Profile not found or access denied' });
    }

    next();
  } catch (error) {
    console.error('[Profile Middleware]', error);
    res.status(500).json({ error: 'Internal server error verifying profile access' });
  }
}
