import { getDb } from '../db.js';
import { v4 as uuidv4 } from 'uuid';

// Simple job processor
let isProcessing = false;
const JOB_POLL_INTERVAL = 5000;

export async function enqueueJob(jobType, payload) {
  const db = await getDb();
  const id = uuidv4();
  await db.run(
    `INSERT INTO background_jobs (id, job_type, payload_json) VALUES (?, ?, ?)`,
    [id, jobType, JSON.stringify(payload)]
  );
  
  // Kick off processor if not running
  if (!isProcessing) {
    processJobs().catch(e => console.error('[JobQueue] Error starting processor:', e));
  }
}

export async function processJobs() {
  if (isProcessing) return;
  isProcessing = true;
  
  try {
    const db = await getDb();
    
    while (true) {
      // Find a pending job
      const job = await db.get(
        `SELECT * FROM background_jobs 
         WHERE status = 'pending' AND run_after <= CURRENT_TIMESTAMP 
         ORDER BY created_at ASC LIMIT 1`
      );
      
      if (!job) {
        break; // No more jobs, exit loop
      }
      
      // Mark as running
      await db.run(
        `UPDATE background_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`,
        [job.id]
      );
      
      try {
        await executeJob(job.job_type, JSON.parse(job.payload_json));
        
        // Mark as done
        await db.run(
          `UPDATE background_jobs SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [job.id]
        );
      } catch (err) {
        console.error(`[JobQueue] Job ${job.id} (${job.job_type}) failed:`, err);
        const attempts = job.attempts + 1;
        const newStatus = attempts >= 3 ? 'failed' : 'pending';
        // Simple backoff: retry in 30 seconds
        const runAfter = new Date(Date.now() + 30000).toISOString();
        
        await db.run(
          `UPDATE background_jobs 
           SET status = ?, attempts = ?, last_error = ?, run_after = ?, updated_at = CURRENT_TIMESTAMP 
           WHERE id = ?`,
          [newStatus, attempts, err.message, runAfter, job.id]
        );
      }
    }
  } catch (globalErr) {
    console.error('[JobQueue] Global processor error:', globalErr);
  } finally {
    isProcessing = false;
    // Schedule next poll just in case
    setTimeout(() => {
      processJobs().catch(e => console.error('[JobQueue] Poll error:', e));
    }, JOB_POLL_INTERVAL);
  }
}

// We lazy-load handlers to avoid circular dependencies
let profileEngine = null;
let profileSummaryEngine = null;

async function executeJob(jobType, payload) {
  if (jobType === 'update_profile_summary') {
    if (!profileEngine) {
      profileEngine = await import('./profileEngine.js');
      profileSummaryEngine = await import('./profileSummaryEngine.js');
    }
    const { profileId, conversationId, historyForExtraction, oldStructuredProfile, newDay } = payload;
    
    // 1. Extract Profile Updates
    const updatedProfile = await profileEngine.extractProfileFromChat(historyForExtraction, oldStructuredProfile);
    
    // 2. Save Updated Profile (since this is background now)
    const db = await import('../db.js').then(m => m.getDb());
    await db.run(
      `UPDATE patient_states
       SET structured_profile_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE profile_id = ?`,
      [JSON.stringify(updatedProfile), profileId]
    );

    // 3. Update Profile Summary
    const newSummary = await profileSummaryEngine.updateProfileContextSummary({
      profileId,
      structuredProfile: updatedProfile,
      historyForSummary: historyForExtraction,
      currentDay: newDay
    });

    // 4. Save Summary
    await db.run(
      `UPDATE patient_states
       SET profile_summary_text = ?, profile_summary_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE profile_id = ?`,
      [newSummary, profileId]
    );
  } else {
    throw new Error(`Unknown job type: ${jobType}`);
  }
}
