import 'dotenv/config';
import { getDb } from './server/db.js';
import { orchestrateToolAction } from './server/services/toolOrchestrator.js';

async function runTest() {
  const db = await getDb();
  
  // Create a dummy profile if needed, or use existing
  const userId = 'user_smoke_test';
  const profileId = 'profile_smoke_test';
  
  const history = [
    { role: 'assistant', content: 'Reminder plan for Aryan\'s paracetamol:\nMorning: 8:00 am\nEvening: 5:00 pm\nNight: 10:00 pm\nWould you like the alerts right at these times?' }
  ];
  const message = 'go ahead with exact timing';
  
  const result = await orchestrateToolAction({
    db,
    userId,
    profileId,
    profile: { name: 'Aryan' },
    patientState: { timezone: 'Asia/Kolkata' },
    history,
    message,
    conversationId: 'conv_smoke',
    pendingFollowupOffer: null
  });

  console.log(JSON.stringify(result, null, 2));
}

runTest().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
