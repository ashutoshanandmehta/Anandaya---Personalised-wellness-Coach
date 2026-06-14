import { apiClient } from './apiClient.js';
import { showAutosave } from './app.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

let appState;
const pendingCheckinOffers = new Map();
let offerSequence = 0;

const CHECKIN_RESPONSE_LABELS = {
  yes: 'Yes',
  no: 'No',
  partially: 'Partially',
  faced_issue: 'Faced an issue',
  better: 'Better',
  same: 'Same',
  worse: 'Worse',
  improving: 'Improving',
  done: 'Done',
  skipped: 'Skipped',
  not_sure: 'Not sure',
};

export function initChat(stateRef) {
  appState = stateRef;

  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const parseProfileBtn = document.getElementById('parseProfileBtn');
  const profileInput = document.getElementById('profileInput');

  // Auto-grow textarea
  chatInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 160) + 'px';
    sendBtn.classList.toggle('active', this.value.trim().length > 0);
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  window.addEventListener('checkin:opened', (event) => {
    if (event.detail?.checkin) {
      appendOpenedScheduleItem(event.detail.checkin);
    }
  });

  window.addEventListener('checkin-progress:updated', () => {
    renderProfileData();
  });

  window.addEventListener('active-reminders:updated', () => {
    renderProfileData();
  });

  // Left Nav toggle
  const leftNavToggle = document.getElementById('leftNavToggle');
  if (leftNavToggle) {
    leftNavToggle.addEventListener('click', () => {
      const leftNav = document.getElementById('leftNav');
      if (window.innerWidth <= 768) {
        leftNav.classList.toggle('open');
      } else {
        leftNav.classList.toggle('collapsed');
      }
    });
  }

  // Right Sidebar toggle
  const rightSidebarToggle = document.getElementById('rightSidebarToggle');
  if (rightSidebarToggle) {
    rightSidebarToggle.addEventListener('click', () => {
      const rightSidebar = document.getElementById('rightSidebar');
      const overlay = document.getElementById('rightSidebarOverlay');
      if (window.innerWidth <= 1100) {
        const isOpen = rightSidebar.classList.toggle('open');
        overlay.classList.toggle('hidden', !isOpen);
      } else {
        rightSidebar.classList.toggle('collapsed');
      }
    });
  }

  // Mobile overlay click to close right sidebar
  const rightSidebarOverlay = document.getElementById('rightSidebarOverlay');
  if (rightSidebarOverlay) {
    rightSidebarOverlay.addEventListener('click', () => {
      document.getElementById('rightSidebar').classList.remove('open');
      rightSidebarOverlay.classList.add('hidden');
    });
  }

  // New Profile Button in Left Nav
  const leftNavNewProfileBtn = document.getElementById('leftNavNewProfileBtn');
  if (leftNavNewProfileBtn) {
    leftNavNewProfileBtn.addEventListener('click', () => {
      document.getElementById('profileDropdownContainer').querySelector('#dropdownNewProfileBtn').click();
    });
  }
}

// ── Rendering ──────────────────────────────────────────────────

export function renderProfileData() {
  const activeProfile = appState.profiles?.find(p => p.id === appState.activeProfileId);
  const name = activeProfile?.name || '—';
  const relText = activeProfile ? (activeProfile.relation === 'Other' ? activeProfile.relation_other : activeProfile.relation) : '';

  // 1. Update Left Nav Name
  const leftNavProfileName = document.getElementById('leftNavProfileName');
  const leftNavProfileRelation = document.getElementById('leftNavProfileRelation');
  if (leftNavProfileName) leftNavProfileName.textContent = name;
  if (leftNavProfileRelation) leftNavProfileRelation.textContent = relText || '';

  // 2. Update Right Sidebar (Patient Sidebar) Identity Module
  const psbName = document.getElementById('psbName');
  const psbRelation = document.getElementById('psbRelation');
  const psbAvatar = document.getElementById('psbAvatar');
  const psbPhotoRing = document.getElementById('psbPhotoRing');
  
  if (psbName) psbName.textContent = name;
  if (psbRelation) psbRelation.textContent = relText || '';

  if (activeProfile?.photo_path) {
    let img = document.getElementById('psbRealPhoto');
    if (!img) {
      img = document.createElement('img');
      img.id = 'psbRealPhoto';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.borderRadius = '50%';
      img.style.objectFit = 'cover';
      img.style.position = 'absolute';
      img.style.inset = '0';
      psbPhotoRing.appendChild(img);
    }
    img.src = activeProfile.photo_path;
    if (psbAvatar) psbAvatar.style.display = 'none';
  } else if (psbAvatar) {
    psbAvatar.style.display = 'flex';
    psbAvatar.textContent = activeProfile?.avatar_initials || '?';
    psbAvatar.style.backgroundColor = activeProfile?.avatar_color || '#2563EB';
  }

  const state = appState.patientState;
  const prof = state?.structured_profile || {};
  
  const day = state?.displayDay ?? state?.display_day ?? state?.current_day ?? 0;
  
  // Show Stepper & trackers if Day >= 1
  const dayStepperBar = document.getElementById('dayStepperBar');
  const psbDayBadge = document.getElementById('psbDayBadge');
  
  if (dayStepperBar) dayStepperBar.style.display = 'flex';
  if (day >= 1) {
    if (psbDayBadge) {
      psbDayBadge.style.display = 'inline-block';
      psbDayBadge.textContent = `Day ${day} · Active`;
    }
    
    // Render stepper dots
    let phase = state?.displayPhase || state?.display_phase || 'Getting started';
    if (!state?.displayPhase && !state?.display_phase) {
      if (day >= 2 && day <= 3) phase = 'Early awareness';
      if (day >= 4 && day <= 7) phase = 'Building habits';
      if (day > 7) phase = 'Staying consistent';
    }
    
    const dayBadge = document.getElementById('dayBadge');
    const phaseLabel = document.getElementById('phaseLabel');
    if (dayBadge) dayBadge.textContent = `Day ${day}`;
    if (phaseLabel) phaseLabel.textContent = phase;
    
    const stepperInner = document.getElementById('dayStepperInner');
    if (stepperInner) {
      let dotsHtml = '';
      const duration = state?.programDurationDays || prof.program_duration_days || 28;
      for (let i = 1; i <= duration; i++) {
        let statusClass = 'day-step--upcoming';
        if (i < day) statusClass = 'day-step--completed';
        else if (i === day) statusClass = 'day-step--active';
        dotsHtml += `<div class="day-step ${statusClass}" title="Day ${i}">${i}</div>`;
      }
      stepperInner.innerHTML = dotsHtml;
    }
  } else {
    const dayBadge = document.getElementById('dayBadge');
    const phaseLabel = document.getElementById('phaseLabel');
    const stepperInner = document.getElementById('dayStepperInner');
    if (dayBadge) dayBadge.textContent = 'Day 0';
    if (phaseLabel) phaseLabel.textContent = 'Intake';
    if (stepperInner) {
      const duration = state?.programDurationDays || prof.program_duration_days || 7;
      stepperInner.innerHTML = Array.from({ length: Math.min(duration, 28) }, (_, index) =>
        `<div class="day-step day-step--upcoming" title="Day ${index + 1}">${index + 1}</div>`
      ).join('');
    }
    if (psbDayBadge) {
      psbDayBadge.style.display = 'inline-block';
      psbDayBadge.textContent = `Day 0 · Intake`;
    }
  }

  // 3. Progressive Disclosure Modules
  
  // Basic Info (shows if any vital is present)
  const psbBasicInfo = document.getElementById('psbBasicInfo');
  if (prof.age || prof.sex || prof.height || prof.weight) {
    psbBasicInfo.classList.remove('hidden');
    document.getElementById('psbAge').textContent = prof.age ? `${prof.age} years` : 'Not added yet';
    document.getElementById('psbSex').textContent = prof.sex || 'Not added yet';
    document.getElementById('psbHeight').textContent = prof.height || 'Not added yet';
    document.getElementById('psbWeight').textContent = prof.weight || 'Not added yet';
  } else {
    psbBasicInfo.classList.add('hidden');
  }

  // Current Concern (shows if parsed)
  const psbConcern = document.getElementById('psbConcern');
  if (prof.category || prof.severity) {
    psbConcern.classList.remove('hidden');
    const quote = document.getElementById('psbConcernQuote');
    if (quote) {
      const quoteText = buildConcernQuote(prof);
      quote.textContent = quoteText ? `“${quoteText}”` : '';
      quote.classList.toggle('hidden', !quoteText);
    }
    document.getElementById('psbCategory').textContent = prof.category || 'Not classified yet';
    document.getElementById('psbSeverity').textContent = prof.severity || 'Not assessed yet';
    document.getElementById('psbRedFlags').textContent = formatArrayValue(prof.red_flags || prof.redFlags, 'Not checked yet');
  } else {
    psbConcern.classList.add('hidden');
  }

  // Health Context
  const psbHealthContext = document.getElementById('psbHealthContext');
  if (prof.conditions?.length || prof.allergies?.length || prof.medications?.length) {
    psbHealthContext.classList.remove('hidden');
    document.getElementById('psbConditions').innerHTML = renderSidebarChips(prof.conditions, 'None reported');
    document.getElementById('psbAllergies').innerHTML = renderSidebarChips(prof.allergies, 'None reported');
    document.getElementById('psbMedicines').innerHTML = renderSidebarChips(prof.medications, 'None reported');
  } else {
    psbHealthContext.classList.add('hidden');
  }

  // Goals
  const psbGoals = document.getElementById('psbGoals');
  const goalsConfirmed = Boolean(prof.goals_confirmed || prof.program_duration_days || day >= 1);
  if (prof.goals?.length && goalsConfirmed) {
    psbGoals.classList.remove('hidden');
    document.getElementById('psbGoalsBody').innerHTML = `<ul class="tag-list">${prof.goals.map(g => `<li>${escapeHtml(g)}</li>`).join('')}</ul>`;
  } else {
    psbGoals.classList.add('hidden');
  }

  const psbReminders = document.getElementById('psbReminders');
  const psbRemindersBody = document.getElementById('psbRemindersBody');
  const reminders = appState.activeReminders || [];
  if (psbReminders && psbRemindersBody && reminders.length) {
    psbReminders.classList.remove('hidden');
    psbRemindersBody.innerHTML = reminders.map(item => `
      <div class="psb-reminder-row ${escapeHtml(item.displayState || item.status || 'scheduled')}">
        <div class="psb-reminder-copy">
          <span class="psb-reminder-title">${escapeHtml(item.title || item.displayTitle || 'Reminder')}</span>
          <span class="psb-reminder-meta">${escapeHtml(formatReminderDue(item))}</span>
        </div>
        <span class="psb-reminder-kind">${escapeHtml(item.kind === 'checkin' ? 'Check-in' : 'Reminder')}</span>
      </div>
    `).join('');
  } else if (psbReminders) {
    psbReminders.classList.add('hidden');
  }

  const psbProgress = document.getElementById('psbProgress');
  const psbProgressBody = document.getElementById('psbProgressBody');
  const progressRows = appState.checkinProgress || [];
  if (psbProgress && psbProgressBody && progressRows.length) {
    psbProgress.classList.remove('hidden');
    psbProgressBody.innerHTML = progressRows.map(row => {
      const total = Math.max(Number(row.totalScheduledCheckins) || 0, 1);
      const score = Number(row.score) || 0;
      const percent = Math.max(0, Math.min(100, Math.round((score / total) * 100)));
      return `
        <div class="progress-card">
          <div class="progress-card-top">
            <span>${escapeHtml(row.goalTitle || 'Check-ins')}</span>
            <strong>${percent}%</strong>
          </div>
          <div class="progress-bar" aria-hidden="true">
            <span style="width:${percent}%"></span>
          </div>
          <div class="progress-meta">
            <span>${Number(row.completedCheckins) || 0} done</span>
            <span>${Number(row.partialCheckins) || 0} partial</span>
            <span>${Number(row.missedCheckins) || 0} missed</span>
          </div>
        </div>
      `;
    }).join('');
  } else if (psbProgress) {
    psbProgress.classList.add('hidden');
  }
}

export async function loadChatHistory() {
  const chatMessages = document.getElementById('chatMessages');
  chatMessages.innerHTML = '';

  try {
    const messages = await apiClient.get(`/api/profiles/${appState.activeProfileId}/messages`);

    if (messages.length === 0) {
      const activeProfile = appState.profiles?.find(p => p.id === appState.activeProfileId);
      const name = activeProfile?.name || 'you';
      
      const msg = `Hi 😊\nI’ve created a profile for ${name}.\n\nTo keep guidance safe and personal, share just these basics when you can:\n\n1. Age\n2. Sex assigned at birth\n3. Height\n4. Weight\n\nA rough format is fine, like: 34 male 170 cm 67 kg.`;
      
      appendMessage('assistant', msg);
    } else {
      messages.forEach(msg => appendMessage(msg.role, msg.content, false));
      scrollToBottom();
    }
  } catch (err) {
    console.error('Failed to load messages', err);
  }
}

function appendMessage(role, text, animate = true) {
  const chatMessages = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `message ${role}`;

  // Fully parse markdown for lists, tables, bold, and spacing
  const formatted = DOMPurify.sanitize(marked.parse(cleanVisibleMessageText(text)));

  if (role === 'assistant') {
    div.innerHTML = `
      <div class="message-avatar">
        <img src="/brand/anand-icon.png" alt="Anandaya">
      </div>
      <div class="message-stack">
        <div class="message-content">${formatted}</div>
        <div class="message-meta">${formatMessageTime()}</div>
      </div>`;
  } else {
    div.innerHTML = `<div class="message-content">${formatted}</div>`;
  }

  chatMessages.appendChild(div);
  if (animate) scrollToBottom();
}

function scrollToBottom() {
  const chatMessages = document.getElementById('chatMessages');
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function triggerCheckIn() {
  try {
    showAutosave('saving');
    const res = await apiClient.post(`/api/profiles/${appState.activeProfileId}/checkin`);
    if (res.questions) {
      appendMessage('assistant', `**Daily Check-in (Day ${res.day}):**\n\n${res.questions}`);
    }
    const state = await apiClient.get(`/api/profiles/${appState.activeProfileId}/state`);
    appState.patientState = state;
    renderProfileData();
    showAutosave('saved');
  } catch (err) {
    console.error('Check-in failed:', err);
  }
}

async function sendMessage() {
  const chatInput = document.getElementById('chatInput');
  const text = chatInput.value.trim();
  if (!text) return;

  await submitMessage(text, { resetInput: true });
}

async function submitMessage(text, { resetInput = false } = {}) {
  const chatInput = document.getElementById('chatInput');
  const typingIndicator = document.getElementById('typingIndicator');

  appendMessage('user', text);
  if (resetInput && chatInput) {
    chatInput.value = '';
    chatInput.style.height = 'auto';
    document.getElementById('sendBtn').classList.remove('active');
  }

  typingIndicator.style.display = 'flex';
  scrollToBottom();
  showAutosave('saving');

  try {
    const res = await apiClient.post(`/api/profiles/${appState.activeProfileId}/chat`, { message: text });
    typingIndicator.style.display = 'none';
    
    renderAssistantResponse(res);
    if (res.scheduledCheckin || res.scheduledCheckins || ['checkin_scheduled', 'checkin_declined', 'schedule_confirmed'].includes(res.mode)) {
      window.dispatchEvent(new CustomEvent('notifications:refresh'));
    }
    
    // Dynamically update the right sidebar memory layer
    try {
      const updatedState = await apiClient.get(`/api/profiles/${appState.activeProfileId}/state`);
      if (updatedState) {
        appState.patientState = updatedState;
        renderProfileData();
      }
    } catch (e) {
      console.warn('Failed to refresh patient state', e);
    }

    showAutosave('saved');
  } catch (err) {
    typingIndicator.style.display = 'none';
    appendMessage('assistant', `*Something went wrong: ${err.message}*`);
    showAutosave('error');
  }
}

function renderAssistantResponse(res) {
  const chatMessages = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'message assistant';

  const rawContent = cleanVisibleMessageText(res.assistantMessage || res.reply || '');
  const cardType = res.ui && res.ui.cardType;
  const isCrisis = cardType === 'urgent_mental_health' || cardType === 'post_crisis_support';

  // ── 1. Build message text ──
  let textHtml = '';
  if (isCrisis) {
    // Safe rendering: split on paragraph breaks, use textContent per paragraph
    textHtml = rawContent.split('\n\n').map(para => {
      const p = document.createElement('p');
      p.style.margin = '0 0 10px 0';
      p.style.lineHeight = '1.65';
      p.textContent = para.trim();
      return p.outerHTML;
    }).join('');
  } else {
    // Fully parse markdown for lists, tables, bold, and spacing
    textHtml = DOMPurify.sanitize(marked.parse(rawContent));
  }

  // ── 2. Build card header ──
  let cardHtml = '';
  if (cardType === 'urgent_mental_health') {
    cardHtml = `
      <div class="crisis-card crisis-card--urgent">
        <div class="crisis-card__header">
          <span class="crisis-card__icon">🚨</span>
          <span class="crisis-card__title">Urgent support</span>
        </div>
      </div>
    `;
  } else if (cardType === 'post_crisis_support') {
    cardHtml = `
      <div class="crisis-card crisis-card--support">
        <div class="crisis-card__header">
          <span class="crisis-card__icon">🫂</span>
          <span class="crisis-card__title">Support mode</span>
        </div>
      </div>
    `;
  }

  // ── 3. Build action buttons ──
  const buttons = [];
  if (res.ui) {
    if (res.ui.showEmergencyButton) {
      buttons.push(`
        <button class="crisis-btn crisis-btn--emergency" onclick="alert('Please call 112 or your local emergency number immediately.')">
          📞 Call emergency support
        </button>
      `);
    }
    if (res.ui.showMapsButton) {
      buttons.push(`
        <button class="crisis-btn crisis-btn--maps maps-btn" onclick="window.findNearbyCare()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          Find nearby emergency care
        </button>
      `);
    }
    if (res.ui.showTrustedContactButton) {
      buttons.push(`
        <button class="crisis-btn crisis-btn--contact" onclick="alert('Please reach out to a trusted person near you.')">
          👥 Contact trusted person
        </button>
      `);
    }
    if (res.ui.showContinueWellnessButton) {
      buttons.push(`
        <button class="crisis-btn crisis-btn--continue" onclick="window.requestReturnToNormal()">
          ✓ Continue wellness setup
        </button>
      `);
    }
  }

  // ── 4. Process dynamic UI Actions (e.g. goal setup, uploads) ──
  let dynamicHtml = '';
  if (res.uiActions && Array.isArray(res.uiActions)) {
    res.uiActions.forEach(action => {
      if (action.type === 'show_goal_options') {
        const durations = action.durations || [7, 14, 30];
        const buttonsHtml = durations.map(d => 
          `<button class="btn btn-outline" onclick="window.setupProgram(${d})">${d} days</button>`
        ).join('');
        dynamicHtml += `
          <div class="interactive-card goal-setup-card">
            <h5>Set up your program</h5>
            <p>Select a duration for your wellness plan:</p>
            <div class="duration-buttons">${buttonsHtml}</div>
          </div>
        `;
      } else if (action.type === 'show_upload_card') {
        dynamicHtml += `
          <div class="interactive-card upload-card">
            <h5>Upload Prescription</h5>
            <p>Upload your prescription to set up smart medicine reminders.</p>
            <button class="btn btn-outline" onclick="document.getElementById('prescriptionUpload').click()">Choose file</button>
            <input type="file" id="prescriptionUpload" style="display:none" onchange="window.handleUpload(event, '${action.uploadType}')">
          </div>
        `;
      } else if (action.type === 'show_reminder_setup') {
        dynamicHtml += `
          <div class="interactive-card reminder-setup-card">
            <h5>Setup Reminder</h5>
            <button class="btn btn-primary" onclick="window.setupReminder()">Configure Reminders</button>
          </div>
        `;
      } else if (action.type === 'show_checkin_offer' && action.offer) {
        const offerId = `offer_${Date.now()}_${offerSequence++}`;
        pendingCheckinOffers.set(offerId, action.offer);
        const offerButtons = action.offer.type === 'water_2_hourly'
          ? `
              <button class="btn btn-primary" type="button" data-checkin-offer-accept="${offerId}" data-checkin-offer-preference="every_2_hours">Every 2 hours</button>
              <button class="btn btn-secondary" type="button" data-checkin-offer-accept="${offerId}" data-checkin-offer-preference="daily">Daily</button>
              <button class="btn btn-secondary" type="button" data-checkin-offer-decline="${offerId}">Not now</button>
            `
          : `
              <button class="btn btn-primary" type="button" data-checkin-offer-accept="${offerId}">Schedule</button>
              <button class="btn btn-secondary" type="button" data-checkin-offer-decline="${offerId}">Not now</button>
            `;
        dynamicHtml += `
          <div class="interactive-card checkin-offer-card" data-checkin-offer-card="${offerId}">
            <h5>${escapeHtml(action.offer.title || 'Follow-up check-in')}</h5>
            <p>${escapeHtml(action.offer.question || 'Would you like me to schedule a follow-up check-in for this plan?')}</p>
            <div class="checkin-card-actions">
              ${offerButtons}
            </div>
            <div class="checkin-card-status" aria-live="polite"></div>
          </div>
        `;
      }
    });
  }

  const buttonsHtml = buttons.length
    ? `<div class="crisis-actions">${buttons.join('')}</div>`
    : '';

  div.innerHTML = `
    <div class="message-avatar">
      <img src="/brand/anand-icon.png" alt="Anandaya">
    </div>
    <div class="message-stack">
      <div class="message-content ${isCrisis ? 'message-content--crisis' : ''}">
        ${cardHtml}
        <div class="crisis-text">${textHtml}</div>
        ${buttonsHtml}
        ${dynamicHtml}
      </div>
      <div class="message-meta">${formatMessageTime()}</div>
    </div>`;

  chatMessages.appendChild(div);
  bindCheckinOfferActions(div);
  scrollToBottom();
}

function bindCheckinOfferActions(root) {
  root.querySelectorAll('[data-checkin-offer-accept]').forEach(button => {
    button.addEventListener('click', () => acceptCheckinOffer(
      button.dataset.checkinOfferAccept,
      button.closest('.checkin-offer-card'),
      button.dataset.checkinOfferPreference
    ));
  });

  root.querySelectorAll('[data-checkin-offer-decline]').forEach(button => {
    button.addEventListener('click', () => declineCheckinOffer(button.dataset.checkinOfferDecline, button.closest('.checkin-offer-card')));
  });
}

async function acceptCheckinOffer(offerId, card, preference) {
  const offer = pendingCheckinOffers.get(offerId);
  if (!offer || !appState?.activeProfileId) return;

  setCardDisabled(card, true);
  setCardStatus(card, 'Asking for timings...');
  showAutosave('saving');

  try {
    const userMessage = preference === 'daily'
      ? 'Yes, schedule one daily hydration check-in.'
      : preference === 'every_2_hours'
        ? 'Yes, schedule water check-ins every 2 hours.'
        : 'Yes, schedule it.';

    pendingCheckinOffers.delete(offerId);
    await submitMessage(userMessage);
    setCardStatus(card, 'Timing requested');
    showAutosave('saved');
  } catch (error) {
    console.error('Failed to continue scheduling flow', error);
    setCardDisabled(card, false);
    setCardStatus(card, 'Could not continue. Please try again.');
    showAutosave('error');
  }
}

async function declineCheckinOffer(offerId, card) {
  pendingCheckinOffers.delete(offerId);
  setCardDisabled(card, true);
  setCardStatus(card, 'Not scheduled');
  await submitMessage('No, not now.');
}

function appendCheckinPrompt(checkin) {
  const chatMessages = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'message assistant';
  const options = Array.isArray(checkin.responseOptions) && checkin.responseOptions.length
    ? checkin.responseOptions
    : ['yes', 'no', 'partially', 'faced_issue'];
  const formatted = DOMPurify.sanitize(marked.parse(cleanVisibleMessageText(checkin.detailedChatMessage || 'A check-in is ready.')));
  const buttons = options
    .map(normalizeCheckinOption)
    .filter(option => CHECKIN_RESPONSE_LABELS[option])
    .map(option => `<button class="btn btn-secondary" type="button" data-checkin-response="${option}">${CHECKIN_RESPONSE_LABELS[option]}</button>`)
    .join('');
  const cardTitle = checkin.inAppTitle || checkin.title || 'Check-in';
  const cardBody = friendlyCheckinCardBody(checkin);

  div.innerHTML = `
    <div class="message-avatar">
      <img src="/brand/anand-icon.png" alt="Anandaya">
    </div>
    <div class="message-stack">
      <div class="message-content">
        <div class="crisis-text">${formatted}</div>
        <div class="checkin-response-card" data-checkin-response-card="${escapeHtml(checkin.id)}">
          <h5>${escapeHtml(cardTitle)}</h5>
          <p>${escapeHtml(cardBody)}</p>
          <div class="checkin-card-actions">${buttons}</div>
          <div class="checkin-card-status" aria-live="polite"></div>
        </div>
      </div>
      <div class="message-meta">${formatMessageTime()}</div>
    </div>`;

  div.querySelectorAll('[data-checkin-response]').forEach(button => {
    button.addEventListener('click', () => respondToCheckin(checkin.id, button.dataset.checkinResponse, button.closest('.checkin-response-card')));
  });

  chatMessages.appendChild(div);
  scrollToBottom();
}

function appendOpenedScheduleItem(item) {
  const kind = item?.kind || item?.metadata?.kind || 'checkin';
  if (kind === 'reminder') {
    appendMessage('assistant', item.detailedChatMessage || `${item.title || 'Reminder'}\n\nThis reminder is due now.`);
    return;
  }

  appendCheckinPrompt(item);
}

async function respondToCheckin(checkinId, response, card) {
  if (!checkinId || !response) return;

  setCardDisabled(card, true);
  setCardStatus(card, 'Logging...');
  showAutosave('saving');
  appendMessage('user', CHECKIN_RESPONSE_LABELS[response] || response);

  try {
    const res = await apiClient.post(`/api/scheduled-checkins/${checkinId}/respond`, { response });
    if (res.assistantMessage) {
      appendMessage('assistant', res.assistantMessage);
    }
    setCardStatus(card, 'Logged');
    if (res.progress) appState.checkinProgress = [res.progress];
    window.dispatchEvent(new CustomEvent('notifications:refresh'));
    showAutosave('saved');
  } catch (error) {
    console.error('Failed to respond to check-in', error);
    setCardDisabled(card, false);
    setCardStatus(card, 'Could not log this check-in. Please try again.');
    showAutosave('error');
  }
}

function setCardDisabled(card, disabled) {
  if (!card) return;
  card.querySelectorAll('button').forEach(button => {
    button.disabled = disabled;
  });
}

function setCardStatus(card, message) {
  const status = card?.querySelector('.checkin-card-status');
  if (status) status.textContent = message;
}

function cleanVisibleMessageText(value = '') {
  return String(value || '')
    .split('\n')
    .filter(line => !isBracketOptionLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isBracketOptionLine(line = '') {
  const text = String(line || '').trim();
  if (!text) return false;
  const bracketMatches = text.match(/\[[^\]]+\]/g) || [];
  if (bracketMatches.length < 2) return false;
  const withoutOptions = text.replace(/\[[^\]]+\]/g, '').trim();
  return withoutOptions.length === 0;
}

function normalizeCheckinOption(option = '') {
  return String(option || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function friendlyCheckinCardBody(checkin = {}) {
  const taxonomy = String(checkin.metadata?.taxonomy || checkin.category || checkin.type || '').toLowerCase();
  if (/sleep|wind/.test(taxonomy)) return 'Pick what fits. No perfect streaks needed.';
  if (/recover|symptom|pain|stomach|health/.test(taxonomy)) return 'Tiny update, big help. How is it now?';
  if (/water|hydrat/.test(taxonomy)) return 'A tiny sip report is enough. What happened?';
  if (/nutrition|meal|food/.test(taxonomy)) return 'Real-life meal check. Choose the closest fit.';
  if (/medicine|medication|dose|pill/.test(taxonomy)) return 'Only log whether the prescribed reminder happened as planned.';
  if (/stress|habit|movement/.test(taxonomy)) return 'Quick reality check, no judgment. How did it go?';
  return 'Choose what fits best. We will adjust from there.';
}

function formatArrayValue(value, fallback) {
  return Array.isArray(value) && value.length ? value.join(', ') : fallback;
}

function renderSidebarChips(values, fallback) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!list.length) return `<span class="psb-chip psb-chip--muted">${escapeHtml(fallback)}</span>`;
  return list.map(value => `<span class="psb-chip">${escapeHtml(value)}</span>`).join('');
}

function buildConcernQuote(prof = {}) {
  const source =
    prof.current_concern ||
    prof.currentConcern ||
    prof.concern_summary ||
    prof.concernSummary ||
    (Array.isArray(prof.conditions) ? prof.conditions[0] : '') ||
    prof.category ||
    '';
  return String(source || '').trim();
}

function formatMessageTime() {
  return new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  }).replace(/\s/g, ' ');
}

function formatReminderDue(item = {}) {
  if (item.displayState === 'ready' || item.status === 'due' || item.status === 'sent') {
    return 'Due now';
  }
  if (item.formattedDueText) {
    return `${item.formattedDueText}${remainingSuffix(item.scheduledFor)}`;
  }
  return remainingSuffix(item.scheduledFor).replace(/^ · /, '') || 'Scheduled';
}

function remainingSuffix(value) {
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return '';
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return ' · due now';
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return ` · in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return ` · in ${hours} hr`;
  const days = Math.round(hours / 24);
  return ` · in ${days} day${days === 1 ? '' : 's'}`;
}

// Called when user clicks "Continue wellness setup" in post_crisis_support
window.requestReturnToNormal = async function() {
  if (!appState?.activeProfileId) return;
  // Send a soft message asking to continue — crisisModeHandler will detect asks_to_continue_normal intent
  const input = document.getElementById('chatInput');
  if (input) {
    input.value = 'continue wellness setup';
    await sendMessage();
  }
};


window.findNearbyCare = async function() {
  const mapsBtn = document.querySelector('.maps-btn');
  if (mapsBtn) {
    mapsBtn.disabled = true;
    mapsBtn.innerHTML = '📍 Requesting location...';
  }

  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    if (mapsBtn) { mapsBtn.disabled = false; mapsBtn.innerHTML = '📍 Find nearby care'; }
    return;
  }

  navigator.geolocation.getCurrentPosition(async (position) => {
    try {
      if (mapsBtn) mapsBtn.innerHTML = '📍 Searching...';

      const response = await apiClient.post('/api/location/nearby-care', {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        type: 'hospital',
        radius: 5000,
      });

      const results = response.results || [];
      if (results.length === 0) {
        alert('No nearby care facilities found. Please contact emergency services (112) if urgent.');
        return;
      }

      // Build a rich results card in chat
      const card = results.slice(0, 5).map(place => {
        const open = place.opening_hours?.open_now;
        const openBadge = open === true ? '🟢 Open' : open === false ? '🔴 Closed' : '⚪ Hours unknown';
        const dist = place.distance_km ? `· ${place.distance_km} km` : '';
        return `
          <div class="nearby-place-card" style="padding:10px 12px;margin:6px 0;background:rgba(255,255,255,0.05);border-radius:10px;border-left:3px solid #3B82F6">
            <div style="font-weight:600;font-size:0.95rem">${escapeHtml(place.name)}</div>
            <div style="font-size:0.8rem;opacity:0.75;margin-top:2px">${escapeHtml(place.vicinity || '')} ${dist}</div>
            <div style="font-size:0.8rem;margin-top:4px">${openBadge}${place.rating ? ` · ⭐ ${place.rating}` : ''}</div>
            ${place.maps_url ? `<a href="${place.maps_url}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:6px;font-size:0.8rem;color:#60A5FA;text-decoration:none">🗺️ Get directions →</a>` : ''}
          </div>
        `;
      }).join('');

      const disclaimer = response.source === 'mock_data'
        ? '<p style="font-size:0.75rem;opacity:0.5;margin-top:8px">* Showing representative facilities. Set GOOGLE_PLACES_API_KEY for live results.</p>'
        : '';

      appendMessage('assistant',
        `<div>📍 <strong>Nearby care facilities:</strong></div>${card}${disclaimer}`,
        true // isHtml
      );

    } catch (err) {
      console.error('Nearby care error:', err);
      alert('Location search failed. Please use Google Maps or call 112 for emergencies.');
    } finally {
      if (mapsBtn) {
        mapsBtn.disabled = false;
        mapsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg> Find nearby care';
      }
    }
  }, (err) => {
    console.error('Geolocation error:', err);
    alert('Location access denied. Please enable location access in your browser, or use your maps app to search for nearby hospitals.');
    if (mapsBtn) {
      mapsBtn.disabled = false;
      mapsBtn.innerHTML = '📍 Find nearby care';
    }
  }, { timeout: 10000, maximumAge: 60000 });
};


function escapeHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

// ── UI Action Handlers ─────────────────────────────────────────

window.setupProgram = async function(days) {
  try {
    showAutosave('saving');
    // Using a default program type based on current category if available, else 'wellness'
    const programType = appState.patientState?.current_category || 'wellness';
    
    await apiClient.post(`/api/profiles/${appState.activeProfileId}/programs`, {
      program_type: programType,
      duration_days: days
    });
    
    appendMessage('user', `I selected a ${days}-day program.`);
    // Fetch state to update UI
    const state = await apiClient.get(`/api/profiles/${appState.activeProfileId}/state`);
    appState.patientState = state;
    renderProfileData();
    showAutosave('saved');
  } catch (err) {
    console.error('Failed to setup program:', err);
    alert('Failed to set up program.');
    showAutosave('error');
  }
};

window.handleUpload = async function(event, uploadType) {
  const file = event.target.files[0];
  if (!file) return;

  const profileId = appState.activeProfileId || window.activeProfileId;
  if (!profileId) { alert('No active profile selected.'); return; }

  const MAX_SIZE = 10 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    alert('File too large. Maximum size is 10 MB.');
    return;
  }

  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
  if (!allowed.includes(file.type)) {
    alert('Unsupported file type. Please upload a JPEG, PNG, WEBP, or PDF.');
    return;
  }

  appendMessage('user', `📎 Uploading ${uploadType === 'prescription' ? 'prescription' : 'file'}: ${file.name}`);

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_type', uploadType || 'general');

  try {
    showAutosave('saving');
    const response = await fetch(`/api/profiles/${profileId}/uploads`, {
      method: 'POST',
      credentials: 'include',
      body: formData, // Do NOT set Content-Type — browser will set multipart/form-data automatically
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Upload failed');
    }

    const result = await response.json();
    showAutosave('saved');

    if (uploadType === 'prescription' && result.ocr_preview) {
      // Show OCR confirmation card
      const meds = result.ocr_preview;
      const medsHtml = meds.map((m, i) => `
        <div style="padding:8px 10px;margin:4px 0;background:rgba(255,255,255,0.06);border-radius:8px;font-size:0.85rem">
          <strong>${escapeHtml(m.name)}</strong>${m.dose ? ' — ' + escapeHtml(m.dose) : ''}
          <span style="opacity:0.65;margin-left:8px">${escapeHtml(m.frequency || '')} ${escapeHtml(m.duration || '')}</span>
          ${m.instructions ? `<div style="opacity:0.5;font-size:0.78rem;margin-top:2px">${escapeHtml(m.instructions)}</div>` : ''}
        </div>
      `).join('');

      appendMessage('assistant', `
        <div>
          ✅ Prescription uploaded! I extracted these medications — please review and confirm:
          <div style="margin:10px 0">${medsHtml}</div>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
            <button
              class="crisis-btn"
              style="background:linear-gradient(135deg,#10b981,#059669);padding:8px 16px;border-radius:8px"
              onclick="window.confirmPrescription('${result.prescription_id}', true)"
            >✅ Confirm & Create Reminders</button>
            <button
              class="crisis-btn"
              style="background:rgba(255,255,255,0.1);padding:8px 16px;border-radius:8px"
              onclick="window.confirmPrescription('${result.prescription_id}', false)"
            >❌ Reject / Re-upload</button>
          </div>
        </div>
      `, true);

      // Store for confirmation handler
      window._pendingPrescription = { id: result.prescription_id, meds };
    } else {
      appendMessage('assistant', `✅ ${result.message || 'File uploaded successfully.'} (${Math.round(file.size / 1024)} KB)`);
    }

  } catch (err) {
    console.error('Upload error:', err);
    showAutosave('error');
    appendMessage('assistant', `❌ Upload failed: ${err.message}. Please try again.`);
  }
};

window.confirmPrescription = async function(prescriptionId, confirm) {
  if (!confirm) {
    appendMessage('assistant', "No problem! You can re-upload the prescription anytime.");
    window._pendingPrescription = null;
    return;
  }

  const pending = window._pendingPrescription;
  if (!pending) return;

  try {
    showAutosave('saving');
    const response = await apiClient.post(`/api/prescriptions/${prescriptionId}/confirm`, {
      confirmed_medications: pending.meds,
      action: 'confirm',
    });

    showAutosave('saved');
    appendMessage('assistant', `
      🎉 ${response.message || 'Prescription confirmed!'}
      ${response.reminders_created?.length ? '\n💊 Medication reminders have been set up for you.' : ''}
    `);
    window._pendingPrescription = null;
  } catch (err) {
    console.error('Confirm error:', err);
    showAutosave('error');
    appendMessage('assistant', '❌ Failed to confirm prescription. Please try again.');
  }
};

window.setupReminder = async function() {
  const profileId = appState.activeProfileId || window.activeProfileId;
  if (!profileId) return;

  // Simple inline reminder creation via prompt
  const title = prompt('💊 Reminder title (e.g., "Take Metformin 500mg"):');
  if (!title || !title.trim()) return;

  const timeStr = prompt('⏰ Reminder time (24h format, e.g., 08:00 or 20:30):', '08:00');
  if (!timeStr) return;

  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!timeRegex.test(timeStr.trim())) {
    alert('Invalid time format. Please use HH:MM (e.g., 08:00).');
    return;
  }

  try {
    showAutosave('saving');
    await submitMessage(`Remind me to ${title.trim()} at ${formatTime12h(timeStr.trim())}`);
    window.dispatchEvent(new CustomEvent('notifications:refresh'));
    showAutosave('saved');
  } catch (err) {
    console.error('Reminder error:', err);
    showAutosave('error');
    alert('Failed to create reminder. Please try again.');
  }
};

function formatTime12h(value) {
  const [hourRaw, minuteRaw] = String(value || '').split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw || 0);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}
