/**
 * crisisModeHandler.js
 * Anandaya — Deterministic Mental Health Crisis Mode Handler
 *
 * This handler MUST NEVER call Qwen, protocolEngine, or any LLM.
 * All responses are deterministic, fixed templates with intent-routing and repetition cooldowns.
 */

// ─────────────────────────────────────────────
// 1. INTENT DETECTION
// ─────────────────────────────────────────────

const INTENTS = {
  ACTIVE_CRISIS_REPEAT: 'active_crisis_repeat',
  UNSURE_OR_OVERWHELMED: 'unsure_or_overwhelmed',
  WANTS_TO_SHARE: 'wants_to_share',
  ANGRY_AT_BOT: 'angry_at_bot',
  SAYS_NO_ONE: 'says_no_one',
  ASKS_WHY_RELATIONSHIP: 'asks_why_relationship',
  CRYING_OR_BREAKUP_CONTEXT: 'crying_or_breakup_context',
  SAYS_FEELS_SAFER: 'says_feels_safer',
  SAYS_ALONE: 'says_alone',
  SAYS_WITH_SOMEONE: 'says_with_someone',
  ASKS_FOR_LOCATION_HELP: 'asks_for_location_help',
  REFUSES_HELP: 'refuses_help',
  ASKS_TO_CONTINUE_NORMAL: 'asks_to_continue_normal',
  HOSTILE_LANGUAGE: 'hostile_language',
  SHORT_ACKNOWLEDGEMENT: 'short_acknowledgement',
  UNKNOWN: 'unknown',
};

const INTENT_PATTERNS = [
  {
    intent: INTENTS.SAYS_FEELS_SAFER,
    patterns: [
      /\b(feel(s)? safer|feel(s)? better|feel(s)? calmer|feel(s)? okay|feel(s)? ok|feel(s)? fine|i'm okay|i'm fine|i'm better|changed my mind|i am okay|i am fine|i am better|i am calmer|much better|slightly better|a bit better|little better|okay now|ok now|fine now|safer now|calmer now)\b/i,
    ],
  },
  {
    intent: INTENTS.ANGRY_AT_BOT,
    patterns: [
      /\b(useless|stop giving suggestions|you're not listening|you are not listening|don't irritate|irritating|annoying|stop repeating|you don't understand|fuck you|shut up|you're useless|not helpful|not helping|worst|hate this|hate you)\b/i,
    ],
  },
  {
    intent: INTENTS.SAYS_NO_ONE,
    patterns: [
      /\b(no one|nobody|no body|there's no one|there is no one|by myself|all alone|completely alone|i have no one|no friends|no family|nobody cares|no one cares)\b/i,
    ],
  },
  {
    intent: INTENTS.SAYS_ALONE,
    patterns: [
      /\b(i'm alone|i am alone|sitting alone|home alone|alone right now|by myself|no one is here|nobody here|nobody around)\b/i,
    ],
  },
  {
    intent: INTENTS.SAYS_WITH_SOMEONE,
    patterns: [
      /\b(i'm with|i am with|someone is here|someone's here|not alone|with my (mom|dad|friend|sister|brother|family|partner|husband|wife)|my (mom|dad|friend|sister|brother|family) is here)\b/i,
    ],
  },
  {
    intent: INTENTS.CRYING_OR_BREAKUP_CONTEXT,
    patterns: [
      /\b(breakup|broke up|broken up|relationship|boyfriend|girlfriend|he left|she left|they left|left me|dumped|rejected|cheated|crying|can't stop crying|been crying|sobbing)\b/i,
    ],
  },
  {
    intent: INTENTS.ASKS_WHY_RELATIONSHIP,
    patterns: [
      /\b(why did (he|she|they)|why would (he|she|they)|why did this happen|why did it end|why did we break|what did i do wrong|why don't they|why don't (he|she))\b/i,
    ],
  },
  {
    intent: INTENTS.WANTS_TO_SHARE,
    patterns: [
      /\b(i want to (share|tell|talk|say)|can i tell|can i share|can i talk|listen to me|hear me|let me tell|let me share|i need to talk|just want to talk|want someone to listen)\b/i,
    ],
  },
  {
    intent: INTENTS.REFUSES_HELP,
    patterns: [
      /\b(don't want help|do not want help|don't need help|i don't want|leave me alone|stop helping|back off|i'm fine without|no help needed|don't call anyone|don't contact anyone)\b/i,
    ],
  },
  {
    intent: INTENTS.ASKS_TO_CONTINUE_NORMAL,
    patterns: [
      /\b(continue (wellness|setup|normal|chat)|return to (wellness|normal|setup)|go back to (normal|wellness)|wellness setup|resume (wellness|setup|normal)|normal (chat|mode|wellness)|start wellness|start setup)\b/i,
    ],
  },
  {
    intent: INTENTS.ASKS_FOR_LOCATION_HELP,
    patterns: [
      /\b(find (nearby|near|close|around)|nearest (hospital|clinic|care|doctor)|where (can i|should i|do i)|location|near me|nearby care|emergency care near)\b/i,
    ],
  },
  {
    intent: INTENTS.HOSTILE_LANGUAGE,
    patterns: [
      /\b(fuck|shit|bastard|asshole|bitch|damn you|go to hell|screw you|idiot|stupid app|garbage)\b/i,
    ],
  },
  {
    intent: INTENTS.UNSURE_OR_OVERWHELMED,
    patterns: [
      /\b(i don't know|i do not know|don't know what|not sure|confused|what do i do|what should i do|can't think|can't decide|overwhelmed|too much|everything feels|don't understand|lost)\b/i,
    ],
  },
  {
    intent: INTENTS.ACTIVE_CRISIS_REPEAT,
    patterns: [
      /\b(want to (die|hurt myself|kill myself|end it|disappear)|still (feeling|feel|hurting)|haven't (improved|gotten better)|still awful|still terrible|still bad|still in pain|it's getting worse|getting worse|feels worse|feeling worse)\b/i,
    ],
  },
  {
    intent: INTENTS.SHORT_ACKNOWLEDGEMENT,
    patterns: [
      /^(yes|no|ok|okay|hmm|hm|uh|sure|maybe|alright|fine|right|yeah|nah|nope|yep|got it|i see|oh|ah)\.?$/i,
    ],
  },
];

export function detectCrisisIntent(message) {
  const text = (message || '').trim();
  for (const { intent, patterns } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return intent;
      }
    }
  }
  return INTENTS.UNKNOWN;
}

// ─────────────────────────────────────────────
// 2. TEMPLATE BANK
// ─────────────────────────────────────────────

// Each template: { id, modes, intents, text, hasQuestion }
const TEMPLATE_BANK = [

  // ── FIRST ENTRY (initial RED trigger, also used for active_crisis_repeat) ──
  {
    id: 'initial_crisis_A',
    modes: ['crisis_active'],
    intents: ['*'],
    priority: 10,
    text: `I'm really glad you told me. Your safety matters most right now.\n\nPlease contact emergency support now or reach out to someone you trust who is physically near you. Try not to stay alone while this feeling is intense.\n\nI can also help you find nearby emergency care if you allow location access.`,
    hasQuestion: false,
  },
  {
    id: 'initial_crisis_B',
    modes: ['crisis_active'],
    intents: ['*'],
    priority: 9,
    text: `Thank you for telling me. I'm taking this seriously.\n\nRight now, the most important thing is getting real support near you. Please contact emergency support or reach out to someone you trust who can be with you.\n\nI can help you find nearby emergency care if you allow location access.`,
    hasQuestion: false,
  },
  {
    id: 'initial_crisis_C',
    modes: ['crisis_active'],
    intents: ['*'],
    priority: 8,
    text: `I'm here with you, and I'm glad you said something.\n\nThis is not something you should carry alone right now. Please contact emergency support or ask someone nearby to stay with you.\n\nI can help you find nearby emergency care if you allow location access.`,
    hasQuestion: false,
  },

  // ── ACTIVE CRISIS REPEAT ──
  {
    id: 'active_crisis_repeat_01',
    modes: ['crisis_active'],
    intents: [INTENTS.ACTIVE_CRISIS_REPEAT, INTENTS.UNKNOWN],
    priority: 5,
    text: `I'm here with you.\n\nThis still sounds urgent. Please contact emergency support now or get someone physically near you.\n\nAre you alone right now?`,
    hasQuestion: true,
  },
  {
    id: 'active_crisis_repeat_02',
    modes: ['crisis_active'],
    intents: [INTENTS.ACTIVE_CRISIS_REPEAT, INTENTS.UNKNOWN],
    priority: 5,
    text: `I'm taking this seriously.\n\nPlease do not stay alone with this feeling. Contact emergency support or someone you trust who can be with you now.\n\nIs there someone nearby you can call or message?`,
    hasQuestion: true,
  },
  {
    id: 'active_crisis_repeat_03',
    modes: ['crisis_active'],
    intents: [INTENTS.ACTIVE_CRISIS_REPEAT, INTENTS.UNKNOWN],
    priority: 5,
    text: `Your safety is the only priority right now.\n\nPlease reach out to emergency support or a trusted person nearby.\n\nCan you move closer to another person or a safer shared space right now?`,
    hasQuestion: true,
  },

  // ── UNSURE OR OVERWHELMED ──
  {
    id: 'unsure_01',
    modes: ['crisis_active'],
    intents: [INTENTS.UNSURE_OR_OVERWHELMED],
    priority: 5,
    text: `That makes sense. When everything feels too much, even the next step can feel unclear.\n\nLet's keep it very small: are you alone right now?`,
    hasQuestion: true,
  },
  {
    id: 'unsure_02',
    modes: ['crisis_active'],
    intents: [INTENTS.UNSURE_OR_OVERWHELMED],
    priority: 5,
    text: `Okay. We don't need to solve everything right now.\n\nFirst step: get another real person involved. Is there anyone nearby you can contact?`,
    hasQuestion: true,
  },
  {
    id: 'unsure_03',
    modes: ['crisis_active'],
    intents: [INTENTS.UNSURE_OR_OVERWHELMED],
    priority: 5,
    text: `I hear you.\n\nFor this moment, don't try to figure out the whole situation. Just tell me this: are you somewhere safe and not alone?`,
    hasQuestion: true,
  },

  // ── WANTS TO SHARE ──
  {
    id: 'wants_to_share_01',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.WANTS_TO_SHARE],
    priority: 5,
    text: `Yes. You can share.\n\nI'll slow down and listen. What part of this is hurting the most right now?`,
    hasQuestion: true,
  },
  {
    id: 'wants_to_share_02',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.WANTS_TO_SHARE],
    priority: 5,
    text: `I'm here to listen.\n\nYou don't have to organize it perfectly. Tell me what happened in your own words.`,
    hasQuestion: false,
  },
  {
    id: 'wants_to_share_03',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.WANTS_TO_SHARE],
    priority: 5,
    text: `Go ahead. I'm with you for this moment.\n\nWhat do you most need someone to understand right now?`,
    hasQuestion: true,
  },
  {
    id: 'wants_to_share_04',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.WANTS_TO_SHARE],
    priority: 5,
    text: `You can tell me.\n\nI won't jump into advice. Start wherever it feels easiest.`,
    hasQuestion: false,
  },

  // ── ANGRY AT BOT ──
  {
    id: 'angry_at_bot_01',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.ANGRY_AT_BOT, INTENTS.HOSTILE_LANGUAGE],
    priority: 8,
    text: `You're right. I gave too many suggestions.\n\nI'll slow down and just listen.\n\nWhat is the part that hurts the most right now?`,
    hasQuestion: true,
  },
  {
    id: 'angry_at_bot_02',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.ANGRY_AT_BOT, INTENTS.HOSTILE_LANGUAGE],
    priority: 8,
    text: `I hear you. I moved too fast into advice.\n\nNo more lists for now. Tell me what you want me to understand first.`,
    hasQuestion: false,
  },
  {
    id: 'angry_at_bot_03',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.ANGRY_AT_BOT, INTENTS.HOSTILE_LANGUAGE],
    priority: 8,
    text: `Fair. That response wasn't what you needed.\n\nI'll stay with you and listen. What happened?`,
    hasQuestion: false,
  },
  {
    id: 'angry_at_bot_04',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.ANGRY_AT_BOT, INTENTS.HOSTILE_LANGUAGE],
    priority: 8,
    text: `Okay, I'll stop giving suggestions.\n\nYou can just say what you're feeling, even if it comes out messy.`,
    hasQuestion: false,
  },

  // ── SAYS NO ONE ──
  {
    id: 'says_no_one_01',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SAYS_NO_ONE],
    priority: 6,
    text: `I'm here with you for this moment.\n\nI still want you connected to real-world support if you might be unsafe. Are you alone right now?`,
    hasQuestion: true,
  },
  {
    id: 'says_no_one_02',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SAYS_NO_ONE],
    priority: 6,
    text: `That sounds really lonely, and I'm sorry you're sitting with it alone.\n\nFor safety, I still want us to find one real person or emergency support. Is there anyone physically nearby, even if you don't feel close to them?`,
    hasQuestion: true,
  },
  {
    id: 'says_no_one_03',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SAYS_NO_ONE],
    priority: 6,
    text: `I hear that you feel like there's no one.\n\nFor the next few minutes, let's focus on not being isolated. Are you in a place where another person is nearby?`,
    hasQuestion: true,
  },
  {
    id: 'says_no_one_04',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SAYS_NO_ONE],
    priority: 6,
    text: `I'm listening.\n\nEven if it feels like no one understands, you deserve support right now. Are you alone where you are?`,
    hasQuestion: true,
  },

  // ── CRYING OR BREAKUP ──
  {
    id: 'breakup_01',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.CRYING_OR_BREAKUP_CONTEXT],
    priority: 5,
    text: `That kind of hurt can feel unbearable in the moment.\n\nI'm here to listen. What happened between you two today?`,
    hasQuestion: true,
  },
  {
    id: 'breakup_02',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.CRYING_OR_BREAKUP_CONTEXT],
    priority: 5,
    text: `Breakups can make everything feel sharp and personal.\n\nBefore we go deeper, I want to check: are you safe right now?`,
    hasQuestion: true,
  },
  {
    id: 'breakup_03',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.CRYING_OR_BREAKUP_CONTEXT],
    priority: 5,
    text: `I'm sorry. That sounds very painful.\n\nTell me the part that keeps replaying in your mind the most.`,
    hasQuestion: false,
  },
  {
    id: 'breakup_04',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.CRYING_OR_BREAKUP_CONTEXT],
    priority: 5,
    text: `You don't have to pretend this is small.\n\nI'll listen. What do you wish they understood?`,
    hasQuestion: true,
  },

  // ── ASKS WHY RELATIONSHIP ──
  {
    id: 'why_relationship_01',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.ASKS_WHY_RELATIONSHIP],
    priority: 5,
    text: `I know you want an answer that makes the pain make sense.\n\nI may not know their reasons, but I can help you untangle what happened. What did they say when things ended?`,
    hasQuestion: true,
  },
  {
    id: 'why_relationship_02',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.ASKS_WHY_RELATIONSHIP],
    priority: 5,
    text: `That question can loop painfully in your head.\n\nLet's take it slowly. What explanation did they give, if any?`,
    hasQuestion: true,
  },
  {
    id: 'why_relationship_03',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.ASKS_WHY_RELATIONSHIP],
    priority: 5,
    text: `It's natural to search for why.\n\nRather than guessing their mind, let's start with what you know. What exactly happened?`,
    hasQuestion: true,
  },

  // ── SAYS FEELS SAFER ──
  {
    id: 'feels_safer_01',
    modes: ['crisis_active'],
    intents: [INTENTS.SAYS_FEELS_SAFER],
    priority: 10,
    text: `I'm relieved you told me things feel a little safer right now.\n\nLet's keep this simple for the next few minutes. Are you currently with someone you trust, or are you alone?`,
    hasQuestion: true,
    nextMode: 'post_crisis_support',
  },
  {
    id: 'feels_safer_02',
    modes: ['crisis_active'],
    intents: [INTENTS.SAYS_FEELS_SAFER],
    priority: 10,
    text: `I'm really glad things feel a little safer right now.\n\nLet's stay gentle and simple. Are you alone, or is someone with you?`,
    hasQuestion: true,
    nextMode: 'post_crisis_support',
  },
  {
    id: 'feels_safer_03',
    modes: ['crisis_active'],
    intents: [INTENTS.SAYS_FEELS_SAFER],
    priority: 10,
    text: `Thank you for telling me. I'm relieved this moment feels a little less intense.\n\nCan you tell me whether you're alone right now?`,
    hasQuestion: true,
    nextMode: 'post_crisis_support',
  },

  // ── SAYS ALONE ──
  {
    id: 'says_alone_01',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SAYS_ALONE],
    priority: 6,
    text: `Thank you for telling me.\n\nFor safety, please try to move closer to another person or contact someone who can be with you. Can you message or call one person now?`,
    hasQuestion: true,
  },
  {
    id: 'says_alone_02',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SAYS_ALONE],
    priority: 6,
    text: `Okay. Being alone can make this feel heavier.\n\nCan you move to a shared space or contact someone nearby?`,
    hasQuestion: true,
  },
  {
    id: 'says_alone_03',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SAYS_ALONE],
    priority: 6,
    text: `I hear you.\n\nLet's focus on getting one real person connected. Who is the easiest person to message, even if the message is simple?`,
    hasQuestion: true,
  },

  // ── SAYS WITH SOMEONE ──
  {
    id: 'with_someone_01',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SAYS_WITH_SOMEONE],
    priority: 6,
    text: `That's good to hear.\n\nPlease stay near them for now. Would you feel okay telling them you're having a really hard moment and shouldn't be alone?`,
    hasQuestion: true,
  },
  {
    id: 'with_someone_02',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SAYS_WITH_SOMEONE],
    priority: 6,
    text: `I'm glad someone is nearby.\n\nCan you ask them to stay with you for a while?`,
    hasQuestion: true,
  },
  {
    id: 'with_someone_03',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SAYS_WITH_SOMEONE],
    priority: 6,
    text: `Good. Please don't handle this alone right now.\n\nCan you let them know you need support?`,
    hasQuestion: true,
  },

  // ── REFUSES HELP ──
  {
    id: 'refuses_help_01',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.REFUSES_HELP],
    priority: 6,
    text: `I hear that you don't want help right now.\n\nI still care about your safety. Can we at least keep this very small: are you in a place where another person could reach you if needed?`,
    hasQuestion: true,
  },
  {
    id: 'refuses_help_02',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.REFUSES_HELP],
    priority: 6,
    text: `Okay. I won't push a long list at you.\n\nBut I do want you to stay connected to safety. Are you alone right now?`,
    hasQuestion: true,
  },
  {
    id: 'refuses_help_03',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.REFUSES_HELP],
    priority: 6,
    text: `I understand you may not want anyone involved.\n\nFor this moment, can you move to a safer, more public or shared space?`,
    hasQuestion: true,
  },

  // ── SHORT ACKNOWLEDGEMENT ──
  {
    id: 'short_ack_01',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SHORT_ACKNOWLEDGEMENT],
    priority: 4,
    text: `Thank you for replying.\n\nCan you tell me a bit more — are you saying you're able to contact someone, or that you want help finding nearby emergency care?`,
    hasQuestion: true,
  },
  {
    id: 'short_ack_02',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SHORT_ACKNOWLEDGEMENT],
    priority: 4,
    text: `Okay. I'm staying with this carefully.\n\nAre you alone right now?`,
    hasQuestion: true,
  },
  {
    id: 'short_ack_03',
    modes: ['crisis_active', 'post_crisis_support'],
    intents: [INTENTS.SHORT_ACKNOWLEDGEMENT],
    priority: 4,
    text: `Thanks for answering.\n\nWhat feels most urgent in this moment: being alone, the thoughts, or the emotional pain?`,
    hasQuestion: true,
  },

  // ─── POST CRISIS SUPPORT ─────────────────────────────────────

  {
    id: 'post_crisis_general_01',
    modes: ['post_crisis_support'],
    intents: ['*'],
    priority: 3,
    text: `Let's keep this gentle.\n\nYou don't have to fix everything right now. What would feel most helpful: talking, sitting quietly, or making sure someone is nearby?`,
    hasQuestion: true,
  },
  {
    id: 'post_crisis_general_02',
    modes: ['post_crisis_support'],
    intents: ['*'],
    priority: 3,
    text: `We can go slowly.\n\nWhat is your body feeling right now: heavy, restless, numb, tired, or something else?`,
    hasQuestion: true,
  },
  {
    id: 'post_crisis_general_03',
    modes: ['post_crisis_support'],
    intents: ['*'],
    priority: 3,
    text: `I'm here.\n\nFor the next few minutes, let's stay with one thing only. What is the strongest feeling right now?`,
    hasQuestion: true,
  },
  {
    id: 'post_crisis_general_04',
    modes: ['post_crisis_support'],
    intents: ['*'],
    priority: 3,
    text: `No rush.\n\nDo you want to tell me what happened, or would you rather just have a quiet check-in?`,
    hasQuestion: true,
  },

  {
    id: 'post_crisis_share_01',
    modes: ['post_crisis_support'],
    intents: [INTENTS.WANTS_TO_SHARE],
    priority: 5,
    text: `I'll listen.\n\nStart wherever you want. What happened?`,
    hasQuestion: false,
  },
  {
    id: 'post_crisis_share_02',
    modes: ['post_crisis_support'],
    intents: [INTENTS.WANTS_TO_SHARE],
    priority: 5,
    text: `Go ahead. I won't turn it into a checklist.\n\nWhat do you want to say first?`,
    hasQuestion: false,
  },
  {
    id: 'post_crisis_share_03',
    modes: ['post_crisis_support'],
    intents: [INTENTS.WANTS_TO_SHARE],
    priority: 5,
    text: `You can share it here.\n\nWhat part feels hardest to say out loud?`,
    hasQuestion: true,
  },

  {
    id: 'post_crisis_breakup_01',
    modes: ['post_crisis_support'],
    intents: [INTENTS.CRYING_OR_BREAKUP_CONTEXT, INTENTS.ASKS_WHY_RELATIONSHIP],
    priority: 5,
    text: `That kind of relationship pain can shake your whole sense of self.\n\nTell me what happened, one piece at a time.`,
    hasQuestion: false,
  },
  {
    id: 'post_crisis_breakup_02',
    modes: ['post_crisis_support'],
    intents: [INTENTS.CRYING_OR_BREAKUP_CONTEXT, INTENTS.ASKS_WHY_RELATIONSHIP],
    priority: 5,
    text: `I'm sorry. That sounds deeply painful.\n\nWhat did they say or do that hurt the most?`,
    hasQuestion: true,
  },
  {
    id: 'post_crisis_breakup_03',
    modes: ['post_crisis_support'],
    intents: [INTENTS.CRYING_OR_BREAKUP_CONTEXT, INTENTS.ASKS_WHY_RELATIONSHIP],
    priority: 5,
    text: `I won't rush you.\n\nWhat are you replaying in your head right now?`,
    hasQuestion: true,
  },

  {
    id: 'post_crisis_angry_01',
    modes: ['post_crisis_support'],
    intents: [INTENTS.ANGRY_AT_BOT, INTENTS.HOSTILE_LANGUAGE],
    priority: 8,
    text: `You're right to call that out.\n\nI'll stop giving suggestions and just stay with what you're saying.`,
    hasQuestion: false,
  },
  {
    id: 'post_crisis_angry_02',
    modes: ['post_crisis_support'],
    intents: [INTENTS.ANGRY_AT_BOT, INTENTS.HOSTILE_LANGUAGE],
    priority: 8,
    text: `Understood.\n\nNo advice right now. Tell me what you want me to hear.`,
    hasQuestion: false,
  },
  {
    id: 'post_crisis_angry_03',
    modes: ['post_crisis_support'],
    intents: [INTENTS.ANGRY_AT_BOT, INTENTS.HOSTILE_LANGUAGE],
    priority: 8,
    text: `Okay. I'll keep it simple.\n\nI'm listening.`,
    hasQuestion: false,
  },

  // ── CONTINUE NORMAL ──
  {
    id: 'continue_normal_01',
    modes: ['post_crisis_support'],
    intents: [INTENTS.ASKS_TO_CONTINUE_NORMAL],
    priority: 10,
    text: `Okay. We can return to the wellness setup.\n\nBefore we do, one quick check: do you feel safe enough to continue right now?`,
    hasQuestion: true,
    pendingTransition: 'normal',
  },
  {
    id: 'continue_normal_02',
    modes: ['post_crisis_support'],
    intents: [INTENTS.ASKS_TO_CONTINUE_NORMAL],
    priority: 10,
    text: `We can continue.\n\nJust to be careful, do you feel safe and able to focus on the setup now?`,
    hasQuestion: true,
    pendingTransition: 'normal',
  },
  {
    id: 'continue_normal_03',
    modes: ['post_crisis_support'],
    intents: [INTENTS.ASKS_TO_CONTINUE_NORMAL],
    priority: 10,
    text: `Alright. I'll move slowly.\n\nDo you want to continue with your wellness profile, or just keep talking for a little longer?`,
    hasQuestion: true,
    pendingTransition: 'normal',
  },
];

// ─────────────────────────────────────────────
// 3. TEMPLATE SELECTION
// ─────────────────────────────────────────────

const COOLDOWN_COUNT = 5;

function parseTemplateHistory(json) {
  try {
    return json ? JSON.parse(json) : [];
  } catch {
    return [];
  }
}

function getRecentlyUsedIds(history) {
  return new Set(history.slice(-COOLDOWN_COUNT).map(h => h.templateId));
}

function scoreTemplate(template, intent, mode, recentIds) {
  let score = template.priority || 0;

  // Intent match
  if (template.intents.includes(intent)) score += 5;
  else if (template.intents.includes('*')) score += 1;
  else return -100; // not eligible

  // Mode match
  if (!template.modes.includes(mode)) return -100; // not eligible

  // Cooldown penalty
  if (recentIds.has(template.id)) score -= 10;

  // Prefer templates with exactly one question in crisis_active
  if (mode === 'crisis_active' && template.hasQuestion) score += 2;

  return score;
}

function selectTemplate(intent, mode, templateHistory) {
  const recentIds = getRecentlyUsedIds(templateHistory);

  const scored = TEMPLATE_BANK
    .map(t => ({ template: t, score: scoreTemplate(t, intent, mode, recentIds) }))
    .filter(({ score }) => score > -50)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // Absolute fallback
    return TEMPLATE_BANK.find(t => t.modes.includes(mode) && t.intents.includes('*')) || TEMPLATE_BANK[0];
  }

  // Among top scorers, pick one (deterministic tiebreak by stable id sort, with light shuffle at the top)
  const top = scored.filter(s => s.score === scored[0].score);
  // Use stable index-based pick to avoid pure randomness
  const pick = top[templateHistory.length % top.length];
  return pick.template;
}

// ─────────────────────────────────────────────
// 4. SLOT FILLING
// ─────────────────────────────────────────────

function fillSlots(text, profile) {
  // Only use name sparingly (every ~3rd message) — passed via context
  return text;
}

// ─────────────────────────────────────────────
// 5. MAIN HANDLER
// ─────────────────────────────────────────────

/**
 * handleCrisisMessage
 * @param {object} params
 * @param {string} params.message - raw user message
 * @param {object} params.stateRow - full patient_states row
 * @param {object} params.safety - result from routeSafety
 * @param {object} params.profile - merged profile
 * @returns {{ nextMode, reply, templateId, ui, pendingTransition? }}
 */
export function handleCrisisMessage({ message, stateRow, safety, profile }) {
  const currentMode = (stateRow && stateRow.safety_mode) || 'crisis_active';
  const templateHistory = parseTemplateHistory(stateRow && stateRow.crisis_template_history_json);

  const intent = detectCrisisIntent(message);

  // Override: if safety router is still RED regardless of current mode, keep crisis active
  let effectiveMode = currentMode;
  if (safety && safety.level === 'RED' && safety.domain === 'mental_health_crisis' && currentMode === 'post_crisis_support') {
    effectiveMode = 'crisis_active';
  }

  // Select template
  const template = selectTemplate(intent, effectiveMode, templateHistory);
  const reply = fillSlots(template.text, profile);

  // Determine next mode
  let nextMode = effectiveMode;
  let pendingTransition = null;

  if (template.nextMode) {
    nextMode = template.nextMode;
  } else if (template.pendingTransition) {
    pendingTransition = template.pendingTransition;
  } else if (effectiveMode === 'post_crisis_support' && intent === INTENTS.ACTIVE_CRISIS_REPEAT) {
    nextMode = 'crisis_active'; // escalate back
  }

  // Update history
  const updatedHistory = [
    ...templateHistory,
    { templateId: template.id, usedAt: new Date().toISOString() },
  ].slice(-20); // keep last 20 only

  // Build UI
  let ui;
  if (nextMode === 'crisis_active' || effectiveMode === 'crisis_active') {
    ui = {
      cardType: 'urgent_mental_health',
      showEmergencyButton: true,
      showMapsButton: true,
      showTrustedContactButton: true,
      showPharmacy: false,
    };
  } else {
    ui = {
      cardType: 'post_crisis_support',
      showEmergencyButton: true,
      showTrustedContactButton: true,
      showMapsButton: false,
      showContinueWellnessButton: true,
    };
  }

  return {
    nextMode,
    pendingTransition,
    reply,
    templateId: template.id,
    detectedIntent: intent,
    updatedTemplateHistory: updatedHistory,
    ui,
  };
}
