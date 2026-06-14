import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireProfileOwnership } from '../middleware/profileOwnershipMiddleware.js';

const router = Router();
router.use(requireAuth);

// ── Programs ───────────────────────────────────────────────────

// Create a new program for a profile
router.post('/profiles/:profileId/programs', requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const { program_type, duration_days } = req.body;
    
    if (!program_type || !duration_days) {
      return res.status(400).json({ error: 'program_type and duration_days are required' });
    }

    const programId = `prog_${uuidv4()}`;
    const startDate = new Date().toISOString();

    await db.run(
      'INSERT INTO programs (id, profile_id, program_type, duration_days, start_date, status) VALUES (?, ?, ?, ?, ?, ?)',
      [programId, req.params.profileId, program_type, duration_days, startDate, 'active']
    );

    // Initialize program days
    for (let i = 1; i <= duration_days; i++) {
      const dayId = `pday_${uuidv4()}`;
      const dayDate = new Date();
      dayDate.setDate(dayDate.getDate() + (i - 1));
      
      await db.run(
        'INSERT INTO program_days (id, program_id, profile_id, day_number, calendar_date, status) VALUES (?, ?, ?, ?, ?, ?)',
        [dayId, programId, req.params.profileId, i, dayDate.toISOString(), i === 1 ? 'active' : 'upcoming']
      );
    }

    res.json({ id: programId, status: 'active', program_type, duration_days });
  } catch (error) {
    console.error('Create program error:', error);
    res.status(500).json({ error: 'Failed to create program' });
  }
});

// Get active program for a profile
router.get('/profiles/:profileId/programs/active', requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const program = await db.get(
      'SELECT * FROM programs WHERE profile_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
      [req.params.profileId, 'active']
    );

    if (!program) {
      return res.json(null);
    }

    // Get days for this program
    const days = await db.all(
      'SELECT * FROM program_days WHERE program_id = ? ORDER BY day_number ASC',
      [program.id]
    );
    program.days = days;

    res.json(program);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch active program' });
  }
});

// Get a specific program day with its tasks
router.get('/programs/:programId/days/:dayNumber', async (req, res) => {
  try {
    const db = await getDb();
    
    // Auth check on program
    const program = await db.get('SELECT profile_id FROM programs WHERE id = ?', [req.params.programId]);
    if (!program) return res.status(404).json({ error: 'Program not found' });
    
    // Enforce profile ownership
    const profile = await db.get('SELECT user_id FROM profiles WHERE id = ?', [program.profile_id]);
    if (!profile || profile.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const day = await db.get(
      'SELECT * FROM program_days WHERE program_id = ? AND day_number = ?',
      [req.params.programId, req.params.dayNumber]
    );

    if (!day) return res.status(404).json({ error: 'Day not found' });

    const tasks = await db.all(
      'SELECT * FROM tasks WHERE program_day_id = ? ORDER BY created_at ASC',
      [day.id]
    );
    day.tasks = tasks;

    res.json(day);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch day' });
  }
});

// ── Tasks ──────────────────────────────────────────────────────

router.patch('/tasks/:taskId', async (req, res) => {
  try {
    const db = await getDb();
    const { status, completion_value } = req.body;

    const task = await db.get('SELECT profile_id FROM tasks WHERE id = ?', [req.params.taskId]);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const profile = await db.get('SELECT user_id FROM profiles WHERE id = ?', [task.profile_id]);
    if (!profile || profile.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await db.run(
      'UPDATE tasks SET status = ?, completion_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status || 'pending', completion_value || null, req.params.taskId]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// ── Reminders ──────────────────────────────────────────────────

router.get('/profiles/:profileId/reminders', requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const reminders = await db.all(
      'SELECT * FROM reminders WHERE profile_id = ? ORDER BY created_at DESC',
      [req.params.profileId]
    );
    res.json(reminders);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load reminders' });
  }
});

router.post('/profiles/:profileId/reminders', requireProfileOwnership, async (req, res) => {
  try {
    const db = await getDb();
    const { reminder_type, title, schedule_json, source } = req.body;
    
    const reminderId = `rem_${uuidv4()}`;
    
    await db.run(
      'INSERT INTO reminders (id, profile_id, reminder_type, title, schedule_json, source) VALUES (?, ?, ?, ?, ?, ?)',
      [reminderId, req.params.profileId, reminder_type, title, JSON.stringify(schedule_json), source || 'user']
    );

    res.json({ id: reminderId, status: 'created' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create reminder' });
  }
});

router.delete('/reminders/:reminderId', async (req, res) => {
  try {
    const db = await getDb();
    
    const reminder = await db.get('SELECT profile_id FROM reminders WHERE id = ?', [req.params.reminderId]);
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });

    const profile = await db.get('SELECT user_id FROM profiles WHERE id = ?', [reminder.profile_id]);
    if (!profile || profile.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await db.run('DELETE FROM reminders WHERE id = ?', [req.params.reminderId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete reminder' });
  }
});

export default router;
