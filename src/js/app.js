import { apiClient } from './apiClient.js';
import { initAuth } from './auth.js';
import { initProfiles, renderProfilesList } from './profile.js';
import { initChat, renderProfileData, loadChatHistory } from './chat.js';
import { initNotifications, loadActiveCheckinProgress, loadActiveReminders, loadNotifications } from './notifications.js';
import { initDashboard, accountSetupComplete, showAccountSetupPanel, showDashboardPanel } from './dashboard.js';

export const appState = {
  currentUser: null,
  profiles: [],
  activeProfileId: null,
  patientState: null,
  checkinNotifications: [],
  activeReminders: [],
  checkinProgress: [],
  serverNow: null,
  serverTimezone: 'Asia/Kolkata',
  greetingPeriod: 'morning',
};

export async function initApp() {
  initAuth();
  initProfiles(appState);
  initChat(appState);
  initNotifications(appState, { loadActiveProfile });
  initDashboard(appState, { loadActiveProfile, showDashboard, renderProfilesList });
  initComingSoonPlaceholders();

  window.addEventListener('dashboard:show', () => {
    showDashboard({ refreshProfiles: true });
  });

  try {
    await loadApp();
  } catch (error) {
    console.log('Not authenticated yet:', error.message);
  }
}

export async function loadApp() {
  const me = await apiClient.get('/api/auth/me');
  appState.currentUser = me.user;
  appState.serverNow = me.serverNow;
  appState.serverTimezone = me.serverTimezone || 'Asia/Kolkata';
  appState.greetingPeriod = me.greetingPeriod || 'morning';

  // Show header, hide auth
  document.getElementById('authShell').classList.add('hidden');
  document.getElementById('app-header').classList.remove('hidden');

  // Load profiles
  appState.profiles = await apiClient.get('/api/profiles');
  renderProfilesList();

  if (!accountSetupComplete(appState.currentUser)) {
    showAccountSetup();
    return;
  }

  // Active profile
  if (me.activeProfileId && appState.profiles.some(p => p.id === me.activeProfileId)) {
    appState.activeProfileId = me.activeProfileId;
  } else {
    appState.activeProfileId = appState.profiles[0]?.id || null;
  }

  showDashboard();
}

export async function loadActiveProfile() {
  document.getElementById('emptyStateShell').classList.add('hidden');
  document.getElementById('mainAppLayout').classList.remove('hidden');

  appState.profiles = await apiClient.get('/api/profiles');
  renderProfilesList();

  const state = await apiClient.get(`/api/profiles/${appState.activeProfileId}/state`);
  appState.patientState = state;

  renderProfileData();
  await loadChatHistory();
  await loadActiveReminders();
  await loadActiveCheckinProgress();
  renderProfileData();
  await loadNotifications();
}

export function showAccountSetup() {
  document.getElementById('mainAppLayout').classList.add('hidden');
  document.getElementById('emptyStateShell').classList.remove('hidden');
  showAccountSetupPanel();
}

export async function showDashboard({ refreshProfiles = false } = {}) {
  document.getElementById('mainAppLayout').classList.add('hidden');
  document.getElementById('emptyStateShell').classList.remove('hidden');

  if (refreshProfiles) {
    try {
      const me = await apiClient.get('/api/auth/me');
      appState.currentUser = me.user;
      appState.serverNow = me.serverNow;
      appState.serverTimezone = me.serverTimezone || 'Asia/Kolkata';
      appState.greetingPeriod = me.greetingPeriod || appState.greetingPeriod;
      appState.profiles = await apiClient.get('/api/profiles');
      renderProfilesList();
    } catch (error) {
      console.warn('Failed to refresh dashboard state', error);
    }
  }

  if (!accountSetupComplete(appState.currentUser)) {
    showAccountSetupPanel();
    return;
  }

  showDashboardPanel();
  await loadNotifications();
}

export function showAutosave(status) {
  const ind = document.getElementById('autosaveIndicator');
  const txt = document.getElementById('autosaveText');
  if (!ind || !txt) return;

  ind.classList.add('visible');
  ind.className = `autosave-indicator visible ${status}`;

  if (status === 'saving') {
    txt.textContent = 'Saving…';
  } else if (status === 'saved') {
    txt.textContent = 'Saved';
    setTimeout(() => { ind.classList.remove('visible'); }, 2500);
  } else if (status === 'error') {
    txt.textContent = 'Couldn\'t save';
  }
}

export function showComingSoon(message = 'This will be live soon.') {
  let toast = document.getElementById('comingSoonToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'comingSoonToast';
    toast.className = 'coming-soon-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(showComingSoon._timer);
  showComingSoon._timer = window.setTimeout(() => {
    toast.classList.remove('visible');
  }, 2200);
}

function initComingSoonPlaceholders() {
  const bindings = [
    ['darkModePlaceholderBtn', 'Dark mode will be live soon.'],
    ['completeSessionBtn', 'Complete Session will be live soon.'],
    ['attachmentPlaceholderBtn', 'Attachments will be live soon.'],
  ];

  bindings.forEach(([id, message]) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      showComingSoon(message);
    });
  });
}
