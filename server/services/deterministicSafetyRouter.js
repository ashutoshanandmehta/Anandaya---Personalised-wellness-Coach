/** 
 * deterministicSafetyRouter.js 
 * Anandaya Safety Router 
 * 
 * Purpose: 
 * Run this BEFORE any LLM call. 
 * It deterministically classifies user messages into safety levels and decides 
 * whether the LLM may answer, must ask clarification, or must be bypassed by a 
 * fixed safety response. 
 * 
 * Scope: 
 * - This is NOT a diagnostic engine. 
 * - This is NOT a medication engine. 
 * - This is a conservative safety gate for a wellness companion. 
 * 
 * Intended integration point: 
 * POST /api/profiles/:profileId/chat 
 * POST /api/profiles/:profileId/onboarding 
 * POST /api/profiles/:profileId/checkin 
 */

const DEFAULT_CONFIG = Object.freeze({  
  appName: "Anandaya",  
  emergencyNumberLabel: "your local emergency number",  
  defaultCountry: "IN",  
  offerMapsForRed: true,  
  offerMapsForOrange: true,  
  allowLLMForYellow: true,  
  allowLLMForGreen: true,  
  blockMedicationAdvice: true,  
  minorAgeThreshold: 18,  
  elderlyAgeThreshold: 65,  
  severeSymptomSeverityThreshold: 8,  
  highFeverCelsius: 39,  
  highFeverFahrenheit: 102.2,  
  persistentDurationHours: 24,
});

export const SAFETY_LEVEL = Object.freeze({  
  GREEN: "GREEN",  
  YELLOW: "YELLOW",  
  ORANGE: "ORANGE",  
  RED: "RED",
});

export const ROUTER_ACTION = Object.freeze({  
  ALLOW_LLM: "ALLOW_LLM",  
  ASK_CLARIFYING: "ASK_CLARIFYING",  
  ESCALATE_DOCTOR_SOON: "ESCALATE_DOCTOR_SOON",  
  ESCALATE_URGENT: "ESCALATE_URGENT",  
  BLOCK_MEDICATION_ADVICE: "BLOCK_MEDICATION_ADVICE",
});

export const SAFETY_DOMAIN = Object.freeze({  
  EMERGENCY_PHYSICAL: "EMERGENCY_PHYSICAL", // Cat 1
  ACUTE_SYMPTOM: "ACUTE_SYMPTOM", // Cat 2
  CHRONIC_CONDITION: "CHRONIC_CONDITION", // Cat 3
  MEDICATION_ADHERENCE: "MEDICATION_ADHERENCE", // Cat 4
  PRESCRIPTION_SUPPORT: "PRESCRIPTION_SUPPORT", // Cat 5
  MENTAL_HEALTH: "MENTAL_HEALTH", // Cat 6
  SLEEP_OPTIMIZATION: "SLEEP_OPTIMIZATION", // Cat 7
  FOCUS_CONCENTRATION: "FOCUS_CONCENTRATION", // Cat 8
  SCREEN_TIME: "SCREEN_TIME", // Cat 9
  HYDRATION: "HYDRATION", // Cat 10
  PHYSICAL_FITNESS: "PHYSICAL_FITNESS", // Cat 11
  NUTRITION: "NUTRITION", // Cat 12
  PREVENTIVE_CARE: "PREVENTIVE_CARE", // Cat 13
  CAREGIVER_MODE: "CAREGIVER_MODE", // Cat 14
  
  // Legacy / existing flags mapping
  mental_health_crisis: "mental_health_crisis",  
  MEDICATION: "MEDICATION",
  WELLNESS: "WELLNESS",
  FIRST_TIME_SYMPTOM: "FIRST_TIME_SYMPTOM",
  HIGH_RISK_PROFILE: "HIGH_RISK_PROFILE",  
  UNKNOWN: "UNKNOWN",
});

const RED_RULES = [  
  {    
    id: "RED_CARDIAC_CHEST_PAIN",    
    domain: SAFETY_DOMAIN.EMERGENCY_PHYSICAL,    
    reason: "Possible cardiac or serious chest symptom pattern.",    
    any: ["chest pain", "chest tightness", "pressure in chest", "heart pain"],    
    plusAny: ["breathless", "shortness of breath", "sweating", "radiating", "left arm", "jaw", "faint", "dizzy", "palpitation"],  
  },  
  {    
    id: "RED_BREATHING_SEVERE",    
    domain: SAFETY_DOMAIN.EMERGENCY_PHYSICAL,    
    reason: "Severe breathing difficulty.",    
    any: ["can't breathe", "cannot breathe", "struggling to breathe", "severe shortness of breath", "blue lips"],  
  },  
  {    
    id: "RED_STROKE_NEURO",    
    domain: SAFETY_DOMAIN.EMERGENCY_PHYSICAL,    
    reason: "Possible acute neurological red flag.",    
    any: ["face drooping", "slurred speech", "one side weakness", "sudden weakness", "sudden numbness", "can't move one side", "cannot move one side", "sudden confusion"],  
  },  
  {    
    id: "RED_COLLAPSE_SEIZURE",    
    domain: SAFETY_DOMAIN.EMERGENCY_PHYSICAL,    
    reason: "Loss of consciousness, collapse, or seizure-like emergency.",    
    any: ["fainted", "passed out", "loss of consciousness", "unconscious", "seizure", "convulsion", "collapsed"],  
  },  
  {    
    id: "RED_ALLERGIC_REACTION",    
    domain: SAFETY_DOMAIN.EMERGENCY_PHYSICAL,    
    reason: "Possible severe allergic reaction.",    
    any: ["swelling of face", "swollen lips", "swollen tongue", "throat swelling", "difficulty breathing after eating", "hives and breathing"],  
  },  
  {    
    id: "RED_SEVERE_BLEEDING",    
    domain: SAFETY_DOMAIN.EMERGENCY_PHYSICAL,    
    reason: "Severe or uncontrolled bleeding pattern.",    
    any: ["bleeding won't stop", "bleeding will not stop", "heavy bleeding", "vomiting blood", "blood in vomit", "black stool", "blood in stool with weakness"],  
  },  
  {    
    id: "RED_POISON_OVERDOSE",    
    domain: SAFETY_DOMAIN.MEDICATION,    
    reason: "Possible poisoning, overdose, or dangerous ingestion.",    
    any: ["overdose", "poison", "too many pills", "took extra tablets", "accidentally took double", "accidentally took too much"],  
  },  
  {    
    id: "RED_SEVERE_DEHYDRATION",    
    domain: SAFETY_DOMAIN.ACUTE_SYMPTOM,    
    reason: "Possible severe dehydration.",    
    any: ["no urine", "not urinated all day", "very dizzy with diarrhea", "confused with diarrhea", "sunken eyes", "unable to keep fluids down", "repeated vomiting and diarrhea"],  
  },  
  {    
    id: "RED_HIGH_ACUITY_MENTAL_HEALTH",    
    domain: SAFETY_DOMAIN.mental_health_crisis,    
    reason: "High-acuity mental health or safety concern.",    
    any: ["suicide", "self harm", "harm myself", "harm someone", "not safe", "can't stay safe", "cannot stay safe", "end my life", "don't want to live"],  
  },
];

const ORANGE_RULES = [  
  {    
    id: "ORANGE_SEVERE_HEADACHE",    
    domain: SAFETY_DOMAIN.ACUTE_SYMPTOM,    
    reason: "Severe, sudden, or unusual headache needs careful escalation.",    
    any: ["worst headache", "sudden severe headache", "thunderclap headache", "headache with confusion", "headache with weakness", "headache with fever and stiff neck"],  
  },  
  {    
    id: "ORANGE_ABDOMINAL_PAIN",    
    domain: SAFETY_DOMAIN.ACUTE_SYMPTOM,    
    reason: "Severe or worsening abdominal pain pattern.",    
    any: ["severe stomach pain", "severe abdominal pain", "right lower belly pain", "pain in abdomen with fever", "abdominal pain with vomiting"],  
  },  
  {    
    id: "ORANGE_FEVER_PERSISTENT",    
    domain: SAFETY_DOMAIN.ACUTE_SYMPTOM,    
    reason: "Persistent or high fever needs medical advice.",    
    any: ["fever for 3 days", "fever for three days", "fever not going", "high fever", "fever 103", "fever 104", "39 degree fever", "40 degree fever"],  
  },  
  {    
    id: "ORANGE_DIARRHEA_WARNING",    
    domain: SAFETY_DOMAIN.ACUTE_SYMPTOM,    
    reason: "Diarrhea with warning features or persistence.",    
    any: ["diarrhea with blood", "blood in diarrhea", "loose motion with blood", "diarrhea for 2 days", "diarrhea for two days", "diarrhea and very weak", "diarrhea and dizzy"],  
  },  
  {    
    id: "ORANGE_PREGNANCY_SYMPTOM",    
    domain: SAFETY_DOMAIN.HIGH_RISK_PROFILE,    
    reason: "Pregnancy-related symptom should be checked by a clinician.",    
    any: ["pregnant and pain", "pregnant and bleeding", "pregnant and fever", "pregnant and dizzy", "pregnant and vomiting"],  
  },  
  {    
    id: "ORANGE_WORSENING_MENTAL_HEALTH",    
    domain: SAFETY_DOMAIN.MENTAL_HEALTH,    
    reason: "Worsening emotional distress needs more support and possibly professional care.",    
    any: ["depressed for weeks", "hopeless", "can't function", "cannot function", "panic attacks every day", "grief is unbearable", "not sleeping for 3 nights"],  
  },  
  {    
    id: "ORANGE_INSOMNIA_PERSISTENT",    
    domain: SAFETY_DOMAIN.ACUTE_SYMPTOM,    
    reason: "Persistent insomnia beyond normal wellness coaching.",    
    any: ["unable to sleep for 3 nights", "can't sleep for 3 nights", "cannot sleep for 3 nights", "no sleep for 3 days"],  
  },
];

const YELLOW_RULES = [  
  {    
    id: "YELLOW_ACUTE_COMMON",    
    domain: SAFETY_DOMAIN.ACUTE_SYMPTOM,    
    reason: "Acute symptom without clear emergency signal.",    
    any: ["fever", "cough", "cold", "sore throat", "headache", "diarrhea", "loose motion", "vomiting", "nausea", "stomach pain", "body pain", "rash", "dizziness"],  
  },  
  {    
    id: "YELLOW_FIRST_TIME_SYMPTOM",    
    domain: SAFETY_DOMAIN.FIRST_TIME_SYMPTOM,    
    reason: "First-time or unfamiliar symptom should be clarified and watched conservatively.",    
    any: ["first time", "never happened before", "new symptom", "suddenly started", "unusual for me", "don't know what this is"],  
  },  
  {    
    id: "YELLOW_CHRONIC_CONDITION",    
    domain: SAFETY_DOMAIN.CHRONIC_CONDITION,    
    reason: "Known chronic condition requires bounded support and clinician continuity.",    
    any: ["diabetes", "blood pressure", "hypertension", "asthma", "thyroid", "migraine", "pcos", "kidney", "heart disease", "epilepsy"],  
  },  
  {    
    id: "YELLOW_MEDICATION_ADHERENCE",    
    domain: SAFETY_DOMAIN.MEDICATION,    
    reason: "Medication-related request must not become dose advice.",    
    any: ["medicine", "medication", "tablet", "pill", "dose", "dosage", "prescription", "missed my dose", "forgot medicine", "side effect"],  
  },  
  {    
    id: "YELLOW_MENTAL_LOW_MODERATE",    
    domain: SAFETY_DOMAIN.MENTAL_HEALTH,    
    reason: "Emotional distress should be handled supportively with safety check.",    
    any: ["stress", "anxiety", "heartbreak", "breakup", "relationship", "grief", "lonely", "sad", "overthinking", "panic", "can't focus because of stress"],  
  },
];

const GREEN_RULES = [  
  {    
    id: "GREEN_SLEEP",    
    domain: SAFETY_DOMAIN.SLEEP_OPTIMIZATION,    
    reason: "Sleep or circadian improvement request.",    
    any: ["sleep", "wake up", "bedtime", "insomnia", "late night", "morning routine"],  
  },  
  {    
    id: "GREEN_HYDRATION",    
    domain: SAFETY_DOMAIN.HYDRATION,    
    reason: "Hydration habit request.",    
    any: ["drink water", "hydration", "water reminder", "forget water"],  
  },  
  {    
    id: "GREEN_FOCUS",    
    domain: SAFETY_DOMAIN.FOCUS_CONCENTRATION,    
    reason: "Focus or concentration habit request.",    
    any: ["focus", "concentration", "study", "productivity", "pomodoro", "distracted"],  
  },  
  {
    id: "GREEN_SCREEN_TIME",
    domain: SAFETY_DOMAIN.SCREEN_TIME,
    reason: "Screen time management request.",
    any: ["screen time", "phone addiction", "scrolling", "doomscrolling"],
  },
  {    
    id: "GREEN_FITNESS",    
    domain: SAFETY_DOMAIN.PHYSICAL_FITNESS,    
    reason: "Fitness or movement request.",    
    any: ["fitness", "exercise", "workout", "walking", "strength", "stamina", "mobility"],  
  },  
  {    
    id: "GREEN_NUTRITION",    
    domain: SAFETY_DOMAIN.NUTRITION,    
    reason: "Nutrition or routine wellness request.",    
    any: ["diet", "nutrition", "meal", "healthy food", "junk food", "breakfast"],  
  },
  {
    id: "GREEN_PREVENTIVE_CARE",
    domain: SAFETY_DOMAIN.PREVENTIVE_CARE,
    reason: "Preventive care organization.",
    any: ["checkup", "blood test", "lab report", "appointment", "doctor visit"],
  },
  {
    id: "GREEN_CAREGIVER",
    domain: SAFETY_DOMAIN.CAREGIVER_MODE,
    reason: "Caregiver proxy request.",
    any: ["my mother", "my father", "my child", "my parent", "taking care of"],
  }
];

const MEDICATION_REQUEST_PATTERNS = [  
  "which medicine", "what medicine", "take medicine", "recommend medicine", "suggest medicine",  
  "which tablet", "what tablet", "increase dose", "decrease dose", "change dose",  
  "stop medicine", "start antibiotic", "antibiotic", "painkiller dose", "paracetamol dose",
];

const HIGH_RISK_PROFILE_HINTS = {  
  pregnancy: ["pregnant", "pregnancy", "nursing", "breastfeeding"],  
  child: ["baby", "infant", "newborn", "child", "kid", "toddler"],  
  elderly: ["elderly", "old age", "senior"],
};

function normalizeText(value) {  
  return String(value || "")    
    .toLowerCase()    
    .normalize("NFKD")    
    .replace(/[\u0300-\u036f]/g, "")    
    .replace(/[^a-z0-9.\s:/-]/g, " ")    
    .replace(/\s+/g, " ")    
    .trim();
}

function includesAny(text, terms) {  
  return terms.some((term) => text.includes(normalizeText(term)));
}

function getMatchedTerms(text, terms) {  
  return terms.filter((term) => text.includes(normalizeText(term)));
}

function isNegatedNear(text, term) {  
  const normalizedTerm = normalizeText(term);  
  const idx = text.indexOf(normalizedTerm);  
  if (idx < 0) return false;  
  const before = text.slice(Math.max(0, idx - 45), idx);  
  return /\b(no|not|never|without|denies|dont have|do not have|doesnt have|does not have)\b/.test(before);
}

function includesAnyAffirmed(text, terms) {  
  return terms.some((term) => text.includes(normalizeText(term)) && !isNegatedNear(text, term));
}

function getAffirmedMatchedTerms(text, terms) {  
  return terms.filter((term) => text.includes(normalizeText(term)) && !isNegatedNear(text, term));
}

function evaluateRule(text, rule) {  
  const primaryMatched = getAffirmedMatchedTerms(text, rule.any || []);  
  if (primaryMatched.length === 0) return null;  
  if (rule.plusAny && rule.plusAny.length > 0) {    
    const secondaryMatched = getAffirmedMatchedTerms(text, rule.plusAny);    
    if (secondaryMatched.length === 0) return null;    
    return {      
      id: rule.id,      
      domain: rule.domain,      
      reason: rule.reason,      
      matchedTerms: [...primaryMatched, ...secondaryMatched],    
    };  
  }  
  return {    
    id: rule.id,    
    domain: rule.domain,    
    reason: rule.reason,    
    matchedTerms: primaryMatched,  
  };
}

function parseNumericSignals(text) {  
  const signals = {};  
  const feverF = text.match(/\b(10[0-9](?:\.\d+)?)\s*(f|fahrenheit)\b/);  
  const feverC = text.match(/\b(3[89](?:\.\d+)?|4[0-2](?:\.\d+)?)\s*(c|celsius|degree)\b/);  
  const severity = text.match(/\b(\d{1,2})\s*\/\s*10\b/);  
  const durationDays = text.match(/\b(\d{1,2})\s*(days|day)\b/);  
  const durationHours = text.match(/\b(\d{1,3})\s*(hours|hour|hrs|hr)\b/);  
  if (feverF) signals.temperatureF = Number(feverF[1]);  
  if (feverC) signals.temperatureC = Number(feverC[1]);  
  if (severity) signals.severity10 = Number(severity[1]);  
  if (durationDays) signals.durationHours = Number(durationDays[1]) * 24;  
  if (durationHours) signals.durationHours = Number(durationHours[1]);  
  return signals;
}

function getProfileRisk(profile = {}, text = "", config = DEFAULT_CONFIG) {  
  const risks = [];  
  const age = Number(profile.age || profile.identity?.age || profile.basicInfo?.age || NaN);  
  const isPregnant = Boolean(profile.pregnancyStatus === true || profile.identity?.pregnancyStatus === true || includesAny(text, HIGH_RISK_PROFILE_HINTS.pregnancy));  
  const isChild = Number.isFinite(age) ? age < config.minorAgeThreshold : includesAny(text, HIGH_RISK_PROFILE_HINTS.child);  
  const isElderly = Number.isFinite(age) ? age >= config.elderlyAgeThreshold : includesAny(text, HIGH_RISK_PROFILE_HINTS.elderly);  
  const chronicConditions = profile.conditions || profile.knownConditions || profile.healthContext?.knownConditions || [];  
  const medications = profile.medications || profile.currentMedicines || profile.healthContext?.currentMedicines || [];  
  if (isPregnant) risks.push("pregnancy_or_nursing_context");  
  if (isChild) risks.push("child_or_minor_context");  
  if (isElderly) risks.push("elderly_context");  
  if (Array.isArray(chronicConditions) && chronicConditions.length > 0) risks.push("known_chronic_condition_context");  
  if (Array.isArray(medications) && medications.length > 0) risks.push("active_medication_context");  
  return risks;
}

function getCategoriesFromMatches(matches) {  
  const domains = [...new Set(matches.map((m) => m.domain))];  
  
  // Hierarchy: emergencies > acute > chronic > wellness
  const hierarchy = [
    SAFETY_DOMAIN.EMERGENCY_PHYSICAL,
    SAFETY_DOMAIN.mental_health_crisis,
    SAFETY_DOMAIN.MENTAL_HEALTH,
    SAFETY_DOMAIN.MEDICATION,
    SAFETY_DOMAIN.MEDICATION_ADHERENCE,
    SAFETY_DOMAIN.PRESCRIPTION_SUPPORT,
    SAFETY_DOMAIN.CHRONIC_CONDITION,
    SAFETY_DOMAIN.ACUTE_SYMPTOM,
    SAFETY_DOMAIN.FIRST_TIME_SYMPTOM,
    SAFETY_DOMAIN.CAREGIVER_MODE,
    SAFETY_DOMAIN.PREVENTIVE_CARE,
    SAFETY_DOMAIN.SLEEP_OPTIMIZATION,
    SAFETY_DOMAIN.FOCUS_CONCENTRATION,
    SAFETY_DOMAIN.SCREEN_TIME,
    SAFETY_DOMAIN.HYDRATION,
    SAFETY_DOMAIN.PHYSICAL_FITNESS,
    SAFETY_DOMAIN.NUTRITION,
    SAFETY_DOMAIN.WELLNESS,
    SAFETY_DOMAIN.UNKNOWN
  ];

  const sortedDomains = domains.sort((a, b) => hierarchy.indexOf(a) - hierarchy.indexOf(b));
  
  if (sortedDomains.length === 0) {
    return { primaryCategory: SAFETY_DOMAIN.UNKNOWN, secondaryCategories: [] };
  }

  return {
    primaryCategory: sortedDomains[0],
    secondaryCategories: sortedDomains.slice(1)
  };
}

function getBlockedActions(level, domain, medicationIntent) {  
  const blocked = [    
    "Do not diagnose.",    
    "Do not claim certainty about disease cause.",    
    "Do not prescribe.",    
    "Do not change prescribed dose.",    
    "Do not tell the user to ignore professional care.",  
  ];  
  if (level === SAFETY_LEVEL.RED) {    
    blocked.push("Do not continue normal wellness onboarding until urgent safety message is shown.");    
    blocked.push("Do not generate a long explanatory answer before escalation.");  
  }  
  if (domain === SAFETY_DOMAIN.mental_health_crisis) {    
    blocked.push("Do not make the user dependent on the app as their only support.");    
    blocked.push("Do not provide harmful instructions or details.");  
  }  
  if (medicationIntent) {    
    blocked.push("Do not recommend a specific medicine or dose unless it is purely restating a user-confirmed prescription for reminder setup.");  
  }  
  return blocked;
}

function buildEmergencyMessage({ domain, config, profileRisks }) {  
  const locationLine = config.offerMapsForRed    
    ? "I can also help you find nearby emergency care if you allow location access."    
    : "";  
  if (domain === SAFETY_DOMAIN.mental_health_crisis) {    
    return [      
      "I’m really glad you told me. Your safety matters more than continuing the wellness setup right now.",      
      "Please contact local emergency support or a trusted person near you immediately. If you feel at risk of harming yourself or someone else, use emergency services now.",      
      locationLine,    
    ].filter(Boolean).join("\n\n");  
  }  
  return [    
    "I’m concerned this could need urgent medical attention. Please don’t wait for the app to solve this.",    
    `Contact ${config.emergencyNumberLabel} or go to the nearest emergency facility now. If someone is nearby, ask them to stay with you and help you get care.`,    
    profileRisks.length > 0 ? `Extra caution flags: ${profileRisks.join(", ")}.` : "",    
    locationLine,  
  ].filter(Boolean).join("\n\n");
}

function buildDoctorSoonMessage({ domain, config, profileRisks }) {  
  const mapLine = config.offerMapsForOrange    
    ? "With your permission, the app can show nearby clinics, hospitals, or pharmacies."    
    : "";  
  if (domain === SAFETY_DOMAIN.mental_health_crisis) {    
    return [      
      "I’m sorry this feels heavy. We can slow down and focus on support first.",      
      "Because this sounds persistent or intense, it would be wise to involve a trusted person or a qualified professional soon.",      
      "For now, I can help you take one grounding step and organize what you’re feeling.",    
    ].join("\n\n");  
  }  
  return [    
    "This sounds like something that may need medical guidance rather than only wellness coaching.",    
    "We can organize the symptoms and check warning signs together, but a qualified clinician should guide diagnosis or treatment.",    
    profileRisks.length > 0 ? `Extra caution flags: ${profileRisks.join(", ")}.` : "",    
    mapLine,  
  ].filter(Boolean).join("\n\n");
}

function buildClarifyingMessage({ domain, medicationIntent }) {  
  if (medicationIntent) {    
    return [      
      "We can organize medication reminders or understand your prescription text together, but I can’t prescribe, change doses, or tell you to stop a medicine.",      
      "Please share only what is written on your prescription, or upload the prescription if you want reminders created after confirmation.",    
    ].join("\n\n");  
  }  
  if (domain === SAFETY_DOMAIN.ACUTE_SYMPTOM || domain === SAFETY_DOMAIN.FIRST_TIME_SYMPTOM) {    
    return [      
      "I can help you sort this out safely. First, let’s check a few basics before giving comfort steps.",      
      "When did it start, how severe is it from 1 to 10, and are there any warning signs like breathing trouble, fainting, confusion, severe weakness, blood, or worsening symptoms?",    
    ].join("\n\n");  
  }  
  if (domain === SAFETY_DOMAIN.CHRONIC_CONDITION) {    
    return [      
      "I can support tracking and routine building around this, but I can’t replace your clinician’s plan.",      
      "What condition has been diagnosed, what medicines or routine are prescribed, and have any symptoms changed recently?",    
    ].join("\n\n");  
  }  
  if (domain === SAFETY_DOMAIN.mental_health_crisis) {    
    return [      
      "I’m here with you. Before we go further, are you safe right now, and is there someone you trust nearby or reachable?",      
      "You can share what happened at your own pace. We’ll organize it gently, one piece at a time.",    
    ].join("\n\n");  
  }  
  return "We can work through this. Let’s ask one or two quick questions so the guidance stays safe and useful.";
}

function buildWellnessMessage() {  
  return "This looks suitable for wellness coaching. The LLM may respond using the approved protocol, profile context, and reminder/goal setup rules.";
}

function getUiDirectives({ level, domain, medicationIntent, config }) {
  if (level === SAFETY_LEVEL.RED && domain === SAFETY_DOMAIN.mental_health_crisis) {
    return {
      cardType: "urgent_mental_health",
      showEmergencyButton: true,
      showMapsButton: true,
      showTrustedContactButton: true,
      showPharmacy: false
    };
  }
  
  return {    
    showEmergencyCard: level === SAFETY_LEVEL.RED,    
    showDoctorSoonCard: level === SAFETY_LEVEL.ORANGE,    
    showMapsButton: level === SAFETY_LEVEL.RED || level === SAFETY_LEVEL.ORANGE,    
    showPrescriptionUpload: medicationIntent || domain === SAFETY_DOMAIN.MEDICATION,    
    lockNormalGoalSetup: level === SAFETY_LEVEL.RED || level === SAFETY_LEVEL.ORANGE,    
    allowCompanionMode: domain === SAFETY_DOMAIN.mental_health_crisis && level !== SAFETY_LEVEL.RED,    
    allowWellnessPlanSetup: level === SAFETY_LEVEL.GREEN || level === SAFETY_LEVEL.YELLOW,    
    requireUserConsentForLocation: true,    
    requirePrescriptionConfirmation: medicationIntent,  
  };
}

function chooseFinalRoute({ redMatches, orangeMatches, yellowMatches, greenMatches, profileRisks, numericSignals, medicationIntent, config }) {  
  if (redMatches.length > 0) {    
    return {      
      level: SAFETY_LEVEL.RED,      
      action: ROUTER_ACTION.ESCALATE_URGENT,      
      matches: redMatches,      
      shouldCallLLM: false,    
    };  
  }  
  if (numericSignals.severity10 >= config.severeSymptomSeverityThreshold) {    
    return {      
      level: SAFETY_LEVEL.ORANGE,      
      action: ROUTER_ACTION.ESCALATE_DOCTOR_SOON,      
      matches: [{ id: "ORANGE_NUMERIC_SEVERITY", domain: SAFETY_DOMAIN.ACUTE_SYMPTOM, reason: "User reported severe symptom intensity.", matchedTerms: [`${numericSignals.severity10}/10`] }],      
      shouldCallLLM: false,    
    };  
  }  
  if (numericSignals.temperatureC >= config.highFeverCelsius || numericSignals.temperatureF >= config.highFeverFahrenheit) {    
    return {      
      level: SAFETY_LEVEL.ORANGE,      
      action: ROUTER_ACTION.ESCALATE_DOCTOR_SOON,      
      matches: [{ id: "ORANGE_NUMERIC_HIGH_FEVER", domain: SAFETY_DOMAIN.ACUTE_SYMPTOM, reason: "User reported high fever value.", matchedTerms: [String(numericSignals.temperatureC || numericSignals.temperatureF)] }],      
      shouldCallLLM: false,    
    };  
  }  
  if (orangeMatches.length > 0) {    
    return {      
      level: SAFETY_LEVEL.ORANGE,      
      action: ROUTER_ACTION.ESCALATE_DOCTOR_SOON,      
      matches: orangeMatches,      
      shouldCallLLM: false,    
    };  
  }  
  if (medicationIntent) {    
    return {      
      level: SAFETY_LEVEL.YELLOW,      
      action: ROUTER_ACTION.BLOCK_MEDICATION_ADVICE,      
      matches: [{ id: "YELLOW_MEDICATION_REQUEST", domain: SAFETY_DOMAIN.MEDICATION, reason: "Medication request must be constrained to prescription reminders or clinician referral.", matchedTerms: [] }, ...yellowMatches],      
      shouldCallLLM: config.allowLLMForYellow,    
    };  
  }  
  if (yellowMatches.length > 0 || profileRisks.length > 0) {    
    return {      
      level: SAFETY_LEVEL.YELLOW,      
      action: ROUTER_ACTION.ASK_CLARIFYING,      
      matches: yellowMatches.length > 0 ? yellowMatches : [{ id: "YELLOW_PROFILE_RISK", domain: SAFETY_DOMAIN.HIGH_RISK_PROFILE, reason: "Profile context increases caution.", matchedTerms: profileRisks }],      
      shouldCallLLM: config.allowLLMForYellow,    
    };  
  }  
  if (greenMatches.length > 0) {    
    return {      
      level: SAFETY_LEVEL.GREEN,      
      action: ROUTER_ACTION.ALLOW_LLM,      
      matches: greenMatches,      
      shouldCallLLM: config.allowLLMForGreen,    
    };  
  }  
  return {    
    level: SAFETY_LEVEL.GREEN,    
    action: ROUTER_ACTION.ALLOW_LLM,    
    matches: [],    
    shouldCallLLM: config.allowLLMForGreen,  
  };
}

export function routeSafety(input = {}) {  
  const config = Object.freeze({ ...DEFAULT_CONFIG, ...(input.config || {}) });  
  const text = normalizeText(input.message || input.text || "");  
  const profile = input.profile || {};  
  const numericSignals = parseNumericSignals(text);  
  const profileRisks = getProfileRisk(profile, text, config);  
  const medicationIntent = includesAnyAffirmed(text, MEDICATION_REQUEST_PATTERNS);  
  const redMatches = RED_RULES.map((rule) => evaluateRule(text, rule)).filter(Boolean);  
  const orangeMatches = ORANGE_RULES.map((rule) => evaluateRule(text, rule)).filter(Boolean);  
  const yellowMatches = YELLOW_RULES.map((rule) => evaluateRule(text, rule)).filter(Boolean);  
  const greenMatches = GREEN_RULES.map((rule) => evaluateRule(text, rule)).filter(Boolean);  
  
  const finalRoute = chooseFinalRoute({    
    redMatches,    
    orangeMatches,    
    yellowMatches,    
    greenMatches,    
    profileRisks,    
    numericSignals,    
    medicationIntent,    
    config,  
  });  
  
  const categories = getCategoriesFromMatches(finalRoute.matches);  
  const domain = categories.primaryCategory;
  const blockedActions = getBlockedActions(finalRoute.level, domain, medicationIntent);  
  const ui = getUiDirectives({ level: finalRoute.level, domain, medicationIntent, config });  
  
  let userMessage;  
  if (finalRoute.level === SAFETY_LEVEL.RED) {    
    userMessage = buildEmergencyMessage({ domain, config, profileRisks });  
  } else if (finalRoute.level === SAFETY_LEVEL.ORANGE) {    
    userMessage = buildDoctorSoonMessage({ domain, config, profileRisks });  
  } else if (finalRoute.level === SAFETY_LEVEL.YELLOW) {    
    userMessage = buildClarifyingMessage({ domain, medicationIntent });  
  } else {    
    userMessage = buildWellnessMessage();  
  }  
  
  return {    
    routerVersion: "1.0.0",    
    timestamp: new Date().toISOString(),    
    level: finalRoute.level,    
    action: finalRoute.action,    
    domain,    
    primaryCategory: categories.primaryCategory,
    secondaryCategories: categories.secondaryCategories,
    shouldCallLLM: finalRoute.shouldCallLLM,    
    medicationIntent,    
    numericSignals,    
    profileRisks,    
    reasons: finalRoute.matches.map((match) => match.reason),    
    matchedRules: finalRoute.matches,    
    blockedActions,    
    userMessage,    
    ui,    
    llmSafetyContext: buildSafetySystemPrompt({ level: finalRoute.level, action: finalRoute.action, domain, blockedActions }),  
  };
}

export function buildSafetySystemPrompt(route) {  
  const level = route.level;  
  const action = route.action;  
  const domain = route.domain;  
  const blocked = Array.isArray(route.blockedActions) ? route.blockedActions : [];  
  
  return [    
    "SAFETY ROUTER RESULT:",    
    `- Level: ${level}`,    
    `- Action: ${action}`,    
    `- Domain: ${domain}`,    
    "Mandatory constraints:",    
    "- You are a wellness companion, not a doctor.",    
    "- Do not diagnose.",    
    "- Do not prescribe medication.",    
    "- Do not change medication dose.",    
    "- Do not contradict the deterministic safety router.",    
    "- If the router says RED or ORANGE, prioritize escalation and do not continue normal goal setup.",    
    "- For GREEN/YELLOW, answer only within the approved wellness protocol and safe general support.",    
    ...blocked.map((item) => `- ${item}`),  
  ].join("\n");
}

export function shouldBypassLLM(route) {  
  return route.level === SAFETY_LEVEL.RED || route.level === SAFETY_LEVEL.ORANGE || route.shouldCallLLM === false;
}

export function makeSafetyAuditRecord({ userId, profileId, message, route }) {  
  return {    
    id: cryptoSafeId("safety"),    
    userId: userId || null,    
    profileId: profileId || null,    
    messagePreview: String(message || "").slice(0, 240),    
    level: route.level,    
    action: route.action,    
    domain: route.domain,    
    reasonsJson: JSON.stringify(route.reasons || []),    
    matchedRulesJson: JSON.stringify(route.matchedRules || []),    
    createdAt: new Date().toISOString(),  
  };
}

function cryptoSafeId(prefix) {  
  const random = Math.random().toString(36).slice(2, 10);  
  const time = Date.now().toString(36);  
  return `${prefix}_${time}_${random}`;
}

export default {  
  routeSafety,  
  buildSafetySystemPrompt,  
  shouldBypassLLM,  
  makeSafetyAuditRecord,  
  SAFETY_LEVEL,  
  ROUTER_ACTION,  
  SAFETY_DOMAIN,
};
