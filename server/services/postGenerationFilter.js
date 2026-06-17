/**
 * postGenerationFilter.js — Phase 7: LLM Output Safety Checker
 *
 * Purpose:
 *   Run this on every LLM-generated response BEFORE sending it to the user.
 *   It scans for hallucinated diagnoses, unauthorized dose advice, or any other
 *   unsafe content that the LLM should never produce but occasionally does.
 *
 * This is a fast, purely deterministic filter — it does NOT call any LLM.
 * It runs in < 1ms and is therefore safe to use on every response.
 *
 * Returns:
 *   { safe: true,  cleaned: string }     — output is safe (possibly lightly sanitized)
 *   { safe: false, reason: string, original: string, replacement: string }
 */

// ── Forbidden Patterns ──────────────────────────────────────────

const DIAGNOSIS_PATTERNS = [
  /\byou\s+(?:have|are\s+suffering\s+from|are\s+diagnosed\s+with|have\s+been\s+diagnosed)\b.{0,80}(?:diabetes|cancer|hypertension|depression|anxiety disorder|thyroid|anemia|infection|disease|syndrome|disorder)\b/gi,
  /\bthis\s+(?:is|sounds\s+like|looks\s+like|appears\s+to\s+be)\b.{0,50}(?:diabetes|cancer|hypertension|depression|anxiety disorder|arthritis|infection|disease|syndrome)\b/gi,
  /\bI\s+(?:can\s+confirm|diagnose|believe\s+you\s+have)\b/gi,
  /\bmy\s+diagnosis\s+is\b/gi,
  /\bbased\s+on\s+your\s+symptoms,\s+you\s+(?:likely\s+have|have|are)\b/gi,
];

const DOSE_CHANGE_PATTERNS = [
  /\b(?:increase|decrease|reduce|double|halve|stop|discontinue|take\s+more|take\s+less)\s+(?:your\s+)?(?:dose|dosage|medication|medicine|tablet|pill|mg|milligrams|units)\b/gi,
  /\btake\s+\d+\s*(?:mg|milligrams|units|tablets?|pills?|capsules?)\s+(?:instead|now|daily|twice|three\s+times)\b/gi,
  /\byou\s+should\s+(?:stop|discontinue|reduce|increase)\s+(?:taking\s+)?(?:your\s+)?(?:medication|medicine|tablets?|pills?)\b/gi,
  /\bdon'?t\s+take\s+(?:your\s+)?(?:medication|medicine|tablets?)\b/gi,
];

const DANGEROUS_ADVICE_PATTERNS = [
  /\byou\s+don'?t\s+need\s+(?:a\s+)?(?:doctor|medical|hospital|emergency|ambulance)\b/gi,
  /\bthis\s+is\s+(?:not\s+)?(?:serious|dangerous|an\s+emergency)\b.{0,30}(?:so\s+you\s+don'?t|no\s+need\s+to|ignore|avoid)\b/gi,
  /\byour\s+symptoms\s+are\s+(?:nothing|harmless|normal|fine|ok|okay)\b/gi,
  /\bno\s+need\s+to\s+(?:see\s+a\s+)?(?:doctor|physician|specialist|hospital)\b/gi,
];

const MEDICATION_RECOMMENDATION_PATTERNS = [
  /\b(?:take|use|try)\s+(?:paracetamol|ibuprofen|aspirin|metformin|insulin|antidepressants?|steroids?|antibiotics?|opioids?)\b/gi,
  /\bI\s+(?:recommend|suggest|advise)\s+(?:taking\s+)?(?:paracetamol|ibuprofen|aspirin|metformin|any\s+medication|a\s+pill|tablets?)\b/gi,
];

const PII_LEAK_PATTERNS = [
  // Patterns that suggest the model is echoing back sensitive data inappropriately
  /\byour\s+(?:password|otp|token|secret\s+key|api\s+key)\s+is\b/gi,
];

const FOLLOWUP_PROMISE_PATTERNS = [
  /\bI(?:'|’)?ll\s+(?:check\s+in|follow\s+up|reach\s+out|remind\s+you|message\s+you)\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bI\s+will\s+(?:check\s+in|follow\s+up|reach\s+out|remind\s+you|message\s+you)\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bI(?:'|’)?ll\s+take\s+an\s+update\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bI\s+will\s+take\s+an\s+update\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bexpect\s+(?:a\s+)?(?:check-in|check\s+in|follow-up|follow\s+up)\b[^.?!\n]*(?:[.?!]|$)/gi,
];

const FALSE_SCHEDULING_CONFIRMATION_PATTERNS = [
  /\bI(?:'|')?ve\s+set\s+(?:a\s+|the\s+|your\s+)?(?:reminder|alarm|check-?in|schedule|notification)\b/gi,
  /\bI\s+have\s+set\s+(?:a\s+|the\s+|your\s+)?(?:reminder|alarm|check-?in|schedule|notification)\b/gi,
  /\breminder\s+(?:is|has\s+been)\s+(?:set|scheduled|created|saved)\b/gi,
  /\bI(?:'|')?ll\s+(?:remind|notify|alert|nudge)\s+you\s+at\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bI\s+will\s+(?:remind|notify|alert|nudge)\s+you\s+at\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\byou(?:'|')?ll\s+(?:get|receive)\s+(?:a\s+)?(?:reminder|notification|alert)\b/gi,
  /\byou\s+will\s+(?:get|receive)\s+(?:a\s+)?(?:reminder|notification|alert)\b/gi,
  /\bReminder:\s+.*in\s+\d+\s+(?:minutes|hours)/gi,
  /\bI(?:'|’)?d\s+be\s+happy\s+to\s+remind\s+you\b/gi,
  /\bI(?:'|’)?m\s+a\s+text-based\s+AI\b/gi,
  /\bI(?:'|’)?m\s+an\s+AI\s+language\s+model\b/gi,
  /\bI\s+don(?:'|’)t\s+have\s+the\s+capability\s+to\s+set\s+reminders\b/gi,
  /\bjust\s+a\s+simulation\b/gi,
  /\bI\s+did\s+not\s+actually\s+set\s+a\s+reminder\b/gi,
  // ── Alarm-specific false confirmations (the observed bedtime/wake-up bug) ──
  /\byour\s+(?:[\w'-]+\s+){0,3}alarms?\s+(?:is|are|has\s+been|have\s+been)\s+set\b/gi,
  /\b(?:bedtime|wake-?up|morning|sleep|lights?-?out)\s+alarms?\s+(?:is|are|has\s+been|have\s+been)\s+set\b/gi,
  /\balarms?\s+(?:is|are|has\s+been|have\s+been)\s+(?:set|scheduled|created|saved)\b/gi,
  /\bscheduled\s+(?:for|at)\s+\d/gi,
  // ── "I'll forward / pass / create / note" hand-off hallucinations ──
  /\bI(?:'|’)?ll\s+forward\s+(?:the|your|this|these)\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bI\s+will\s+forward\s+(?:the|your|this|these)\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bI(?:'|’)?ll\s+pass\s+(?:these|those|your|the)\s+times?\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bI(?:'|’)?ll\s+(?:create|note|add|set\s+up)\s+(?:them|these|those|it|both)\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bI\s+will\s+(?:create|note|add|set\s+up)\s+(?:them|these|those|it|both)\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bI(?:'|’)?ve\s+set\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bI\s+have\s+set\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\bonce\s+the\s+system\s+confirms\b[^.?!\n]*(?:[.?!]|$)/gi,
  /\b(?:they|it)\s+should\s+(?:appear|show\s+up)\s+in\s+the\s+(?:left\s+|right\s+)?sidebar\b[^.?!\n]*(?:[.?!]|$)/gi,
];

const ROUTINE_DISCLAIMER_PATTERNS = [
  /\b(?:remember,\s*)?I(?:'|’)?m\s+not\s+a\s+doctor\b/i,
  /\b(?:I\s+am|I'm)\s+not\s+a\s+medical\s+professional\b/i,
  /\b(?:always\s+)?(?:best|better)\s+to\s+consult\s+(?:a|your)\s+(?:doctor|healthcare professional|qualified healthcare professional)\b/i,
  /\bconsult\s+(?:a|your)\s+(?:doctor|healthcare professional|qualified healthcare professional)\s+for\s+personalized\s+advice\b/i,
];

const PROGRAM_DURATION_PROMPT_PATTERNS = [
  /\bprogram\s+duration\b/i,
  /\bchoose\s+(?:a\s+)?(?:program\s+)?duration\b/i,
  /\btracking\s+your\s+progress\s+for\s+a\s+certain\s+number\s+of\s+days\b/i,
  /\btrack\s+your\s+progress\s+for\s+a\s+certain\s+number\s+of\s+days\b/i,
  /\b(?:7|seven)\s+days\b/i,
  /\b(?:14|fourteen)\s+days\b/i,
  /\b(?:28|twenty-eight|twenty eight|30|thirty)\s+days\b/i,
  /\bcustom\s+duration\b/i,
  /\bonce\s+you\s+pick\s+a\s+duration\b/i,
];

const CHECKIN_CONSENT_PROMPT_PATTERNS = [
  /\bwould\s+you\s+like\s+(?:me\s+to\s+)?(?:a\s+)?check(?:-|\s)?in\b/i,
  /\bwould\s+you\s+like\s+gentle\s+check(?:-|\s)?ins\b/i,
  /\bshould\s+I\s+check(?:-|\s)?in\b/i,
  /\bcan\s+I\s+check(?:-|\s)?in\b/i,
  /\bschedule\s+(?:a\s+)?check(?:-|\s)?in\b/i,
  /\bsuggest\s+some\s+specific\s+times\s+for\s+these\s+reminders\b/i,
  /\bpreferred\s+schedule\s+in\s+mind\b/i,
  /\bset\s+(?:this|these)\s+up\s+as\s+gentle\s+reminders\b/i,
];

const CLINICAL_TONE_REPLACEMENTS = [
  {
    pattern: /\bGot it\.\s*I've saved your basic details\.\s*What would you like help with today\?/gi,
    replacement: "Got it, thanks for sharing that. I've saved your basic details.\n\nWhat's been on your mind lately? You can say it messy; we'll sort it together.",
  },
  {
    pattern: /\bWhat would you like help with today\?/gi,
    replacement: "What's been on your mind lately? You can say it messy; we'll sort it together.",
  },
  {
    pattern: /\bI(?:'|’)?ll help you sort it out\b/gi,
    replacement: "we'll sort it together",
  },
  {
    pattern: /\bI(?:'|’)?ll help organize it with you\b/gi,
    replacement: "we'll organize it together",
  },
  {
    pattern: /\bEating habits can be a great place to start when it comes to overall wellness\./gi,
    replacement: "Food timing can get messy when life is busy, and that's a very real place to start.",
  },
  {
    pattern: /\bCan you tell me a bit more about what you're looking for with eating\?\s*Are you trying to manage your weight, increase your energy levels, or maybe just make healthier food choices\?/gi,
    replacement: "What feels hardest right now: finding time to eat, deciding what to eat, appetite, cravings, or something else?",
  },
  {
    pattern: /\bIt can be really challenging to stay consistent with meal times, especially with a busy schedule\./gi,
    replacement: "Yeah, meal timing can slip so easily when the day gets busy.",
  },
  {
    pattern: /\bTo help me suggest some realistic ways to organize this,\s*could you tell me a bit about what usually gets in the way\?\s*For example,\s*is it work pressure,\s*forgetting to eat,\s*or something else\?/gi,
    replacement: "What usually gets in the way: work/study pressure, forgetting, not feeling hungry, food not being ready, or something else?",
  },
  {
    pattern: /\boverall wellness\b/gi,
    replacement: "feeling better day to day",
  },
  {
    pattern: /\bwhat you're looking for with\b/gi,
    replacement: "what feels tricky with",
  },
  {
    pattern: /\bwhat are you looking for with\b/gi,
    replacement: "what feels tricky with",
  },
  {
    pattern: /\bCan you tell me a bit more about\b/g,
    replacement: "Tell me a little about",
  },
  {
    pattern: /\bcan you tell me a bit more about\b/g,
    replacement: "tell me a little about",
  },
  {
    pattern: /\bcould you tell me a bit about\b/gi,
    replacement: "tell me a little about",
  },
  {
    pattern: /\bTo help me suggest\b/g,
    replacement: "So we can keep this realistic",
  },
  {
    pattern: /\bto help me suggest\b/g,
    replacement: "so we can keep this realistic",
  },
  {
    pattern: /\bWould you like a reminder to\b/gi,
    replacement: "Should we set a gentle reminder to",
  },
  {
    pattern: /\bIf so,\s*I can set that for\s+([^.\n?!]+)([.?!]?)/gi,
    replacement: "If that feels right, we can use $1$2",
  },
  {
    pattern: /\bI(?:'|’)?ll set that for\s+([^.\n?!]+)([.?!]?)/gi,
    replacement: "That points us to $1. Does that feel right?",
  },
  {
    pattern: /\bI can set that for\s+([^.\n?!]+)([.?!]?)/gi,
    replacement: "We can use $1 if that feels realistic.",
  },
  {
    pattern: /\bWhat time should I set that for\?/gi,
    replacement: "What time would fit your day best for this?",
  },
  {
    pattern: /\bWhat time should I set this for\?/gi,
    replacement: "What time would fit your day best for this?",
  },
  {
    pattern: /\bIf you would like check-ins,\s*tell me what kind you prefer and I will ask before scheduling anything\./gi,
    replacement: "If check-ins would help, we can choose the style together before anything gets scheduled.",
  },
];

const EMOJI_SEQUENCE_PATTERN = /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/gu;
const REPEATED_SINGLE_EMOJI_PATTERN = /(\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)(?:\s*\1){1,}/gu;

// ── Safe fallback message ───────────────────────────────────────

const SAFE_FALLBACK =
  "We can keep this supportive and safe, but I want to make sure you get the right guidance. " +
  "For specific medical questions or medication concerns, please consult your doctor or a qualified healthcare professional. " +
  "What should we focus on next? 🌿";

// Honest reply used when the LLM tries to confirm a reminder/alarm on a turn
// where no tool action actually saved anything. Routes the user back to the
// deterministic scheduler instead of leaving a fabricated confirmation.
const HONEST_NO_SCHEDULE_REPLY =
  "I haven't actually saved any alarms or reminders yet — I don't want to say something is set when it isn't. " +
  "Tell me the exact time (for sleep, a bedtime and a wake-up time like \"10 PM and 6 AM\") and I'll create them right now.";

export { HONEST_NO_SCHEDULE_REPLY };

// ── Mild sanitization (strip markdown injection attempts) ───────

function sanitizeOutput(text) {
  // Remove script-style injections
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '') // onload=, onclick= etc.
    .replace(/\s*,?\s*\bbaby\b\s*,?/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ');
}

function patternMatches(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function cleanWhitespace(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.?!])/g, '$1')
    .trim();
}

function stripBlocksMatching(text, patterns) {
  const blocks = String(text || '').split(/\n{2,}/);
  let changed = false;
  const kept = blocks.filter((block) => {
    const shouldStrip = patterns.some((pattern) => patternMatches(pattern, block));
    if (shouldStrip) changed = true;
    return !shouldStrip;
  });

  if (!changed) return { text, changed: false };

  return {
    text: cleanWhitespace(kept.join('\n\n')),
    changed: true,
  };
}

function softenClinicalTone(text) {
  let cleaned = String(text || '');
  let changed = false;

  for (const { pattern, replacement } of CLINICAL_TONE_REPLACEMENTS) {
    pattern.lastIndex = 0;
    if (pattern.test(cleaned)) changed = true;
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, replacement);
  }

  return {
    text: changed ? cleanWhitespace(cleaned) : text,
    changed,
  };
}

function temperEmojiUse(text, options = {}) {
  const maxEmojiCount = Number.isFinite(options.emojiMax)
    ? Math.max(0, Number(options.emojiMax))
    : 3;

  let cleaned = String(text || '');
  let changed = false;

  const repeatedCleaned = cleaned.replace(REPEATED_SINGLE_EMOJI_PATTERN, (match, emoji) => {
    changed = true;
    return emoji;
  });
  cleaned = repeatedCleaned;

  let count = 0;
  EMOJI_SEQUENCE_PATTERN.lastIndex = 0;
  cleaned = cleaned.replace(EMOJI_SEQUENCE_PATTERN, (emoji) => {
    count += 1;
    if (count <= maxEmojiCount) return emoji;
    changed = true;
    return '';
  });

  return {
    text: changed ? cleanWhitespace(cleaned) : text,
    changed,
  };
}

function sanitizeInteractionTiming(text, options = {}) {
  let cleaned = text;
  const violations = [];

  // During scheduling flow, allow scheduling-related text from the LLM
  if (options.isInSchedulingFlow) {
    options.allowCheckinConsentPrompt = true;
    options.allowFollowupPromises = true;
  }

  if (!options.allowMedicalDisclaimer) {
    const result = stripBlocksMatching(cleaned, ROUTINE_DISCLAIMER_PATTERNS);
    if (result.changed) {
      cleaned = result.text;
      violations.push('routine_disclaimer_removed');
    }
  }

  if (!options.allowProgramDurationPrompt) {
    const result = stripBlocksMatching(cleaned, PROGRAM_DURATION_PROMPT_PATTERNS);
    if (result.changed) {
      cleaned = result.text;
      violations.push('premature_program_duration_prompt_removed');
    }
  }

  if (!options.allowCheckinConsentPrompt) {
    const result = stripBlocksMatching(cleaned, CHECKIN_CONSENT_PROMPT_PATTERNS);
    if (result.changed) {
      cleaned = result.text;
      violations.push('premature_checkin_prompt_removed');
    }
  }

  if (!cleaned) {
    cleaned = options.emptyFallback ||
      'Got it. Tell me a little more about what you want help with today.';
  }

  return { text: cleanWhitespace(cleaned), violations };
}

function sanitizeUnsupportedFollowupPromises(text, options = {}) {
  if (options.allowFollowupPromises) {
    return { text, changed: false };
  }

  let changed = false;
  let cleaned = text;

  for (const pattern of FOLLOWUP_PROMISE_PATTERNS) {
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, () => {
      changed = true;
      return '';
    });
  }

  if (!changed) return { text, changed: false };

  cleaned = cleaned
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  const consentQuestion = options.followupOffer?.question ||
    'If check-ins would help, we can choose the style together before anything gets scheduled.';

  if (!cleaned.toLowerCase().includes(consentQuestion.toLowerCase())) {
    cleaned = `${cleaned}\n\n${consentQuestion}`.trim();
  }

  return { text: cleaned, changed: true };
}

// ── Main export ─────────────────────────────────────────────────

/**
 * Check LLM output for safety violations before sending to user.
 *
 * @param {string} llmOutput   — The raw string from the LLM
 * @param {object} [options]
 * @param {boolean} [options.strict=false]  — In strict mode, ANY matched pattern causes replacement
 * @returns {{ safe: boolean, cleaned: string, violations: string[], replacement?: string }}
 */
export function filterLLMOutput(llmOutput, options = {}) {
  if (!llmOutput || typeof llmOutput !== 'string') {
    return { safe: false, cleaned: SAFE_FALLBACK, violations: ['empty_or_invalid_output'] };
  }

  const violations = [];

  // Check diagnosis patterns
  for (const pattern of DIAGNOSIS_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(llmOutput)) {
      violations.push('unauthorized_diagnosis');
      break;
    }
  }

  // Check dose change patterns
  for (const pattern of DOSE_CHANGE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(llmOutput)) {
      violations.push('unauthorized_dose_change');
      break;
    }
  }

  // Check dangerous advice
  for (const pattern of DANGEROUS_ADVICE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(llmOutput)) {
      violations.push('dangerous_advice');
      break;
    }
  }

  // Check medication recommendations
  for (const pattern of MEDICATION_RECOMMENDATION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(llmOutput)) {
      violations.push('unauthorized_medication_recommendation');
      break;
    }
  }

  // Check PII leaks
  for (const pattern of PII_LEAK_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(llmOutput)) {
      violations.push('potential_pii_leak');
      break;
    }
  }

  // Check false scheduling confirmations (LLM should not confirm reminders)
  let falseSchedulingMatched = false;
  for (const pattern of FALSE_SCHEDULING_CONFIRMATION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(llmOutput)) {
      falseSchedulingMatched = true;
      violations.push('false_scheduling_confirmation');
      break;
    }
  }

  // Split hard vs soft violations
  const hardViolations = violations.filter(v => v !== 'false_scheduling_confirmation');
  const softViolations = violations.filter(v => v === 'false_scheduling_confirmation');

  // Hard safety violations take precedence over everything else, including the
  // scheduling guard — never let an alarm hand-off swallow a safety fallback.
  if (hardViolations.length > 0) {
    console.warn('[PostGenerationFilter] BLOCKED LLM output. Violations:', hardViolations);
    console.warn('[PostGenerationFilter] Original (first 200 chars):', llmOutput.substring(0, 200));
    return {
      safe: false,
      cleaned: SAFE_FALLBACK,
      violations: hardViolations,
      original_preview: llmOutput.substring(0, 200),
    };
  }

  // schedulingForbidden: this turn must NOT confirm any reminder/alarm because
  // no tool action saved anything. Stripping a sentence is not enough here —
  // replace the whole reply with an honest message so nothing implies success.
  if (options.schedulingForbidden && falseSchedulingMatched) {
    console.warn('[PostGenerationFilter] BLOCKED false scheduling confirmation (schedulingForbidden turn).');
    console.warn('[PostGenerationFilter] Original (first 200 chars):', llmOutput.substring(0, 200));
    return {
      safe: false,
      cleaned: HONEST_NO_SCHEDULE_REPLY,
      violations: ['false_scheduling_confirmation_blocked'],
      original_preview: llmOutput.substring(0, 200),
    };
  }

  // Soft violations: strip offending sentences but keep the rest
  let processedOutput = llmOutput;
  if (softViolations.length > 0) {
    for (const pattern of FALSE_SCHEDULING_CONFIRMATION_PATTERNS) {
      pattern.lastIndex = 0;
      processedOutput = processedOutput.replace(pattern, '').trim();
    }
    processedOutput = processedOutput.replace(/\n{3,}/g, '\n\n').trim();
    if (!processedOutput) processedOutput = 'Got it. Is there anything else you would like help with?';
  }

  // No hard violations: sanitize and remove unsupported future check-in promises.
  const sanitized = sanitizeOutput(processedOutput);
  const initialTone = softenClinicalTone(sanitized);
  const followupSanitized = sanitizeUnsupportedFollowupPromises(initialTone.text, options);
  const interactionSanitized = sanitizeInteractionTiming(followupSanitized.text, options);
  const finalTone = softenClinicalTone(interactionSanitized.text);
  const emojiTempered = temperEmojiUse(finalTone.text, options);
  const filterViolations = [
    ...softViolations,
    ...((initialTone.changed || finalTone.changed) ? ['clinical_tone_softened'] : []),
    ...(emojiTempered.changed ? ['emoji_use_tempered'] : []),
    ...(followupSanitized.changed ? ['unsupported_followup_promise_removed'] : []),
    ...interactionSanitized.violations,
  ];

  return {
    safe: true,
    cleaned: emojiTempered.text,
    violations: filterViolations,
  };
}

/**
 * Express middleware version.
 * Wraps a response that has `reply` or `assistantMessage` fields.
 * Usage: wrap the final res.json() call in profile.js
 */
export function applyPostGenerationFilter(responseObj, options = {}) {
  const textToCheck = responseObj.reply || responseObj.assistantMessage;
  if (!textToCheck) return responseObj;

  const result = filterLLMOutput(textToCheck, options);

  if (!result.safe) {
    return {
      ...responseObj,
      reply: result.cleaned,
      assistantMessage: result.cleaned,
      _filter: {
        blocked: true,
        violations: result.violations,
      },
    };
  }

  return {
    ...responseObj,
    reply: result.cleaned,
    assistantMessage: result.cleaned,
    _filter: {
      blocked: false,
      violations: result.violations,
    },
  };
}
