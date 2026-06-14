import { apiClient } from './apiClient.js';
import { showAutosave } from './app.js';

let appState;
let callbacks = {};
let accountSetupPanel;
let dashboardPanel;
let accountSetupForm;
let accountSetupError;
let accountSetupSubmitBtn;
let dashboardGreeting;
let dashboardProfilesGrid;

export function initDashboard(stateRef, callbackRef = {}) {
  appState = stateRef;
  callbacks = callbackRef;

  accountSetupPanel = document.getElementById('accountSetupPanel');
  dashboardPanel = document.getElementById('dashboardPanel');
  accountSetupForm = document.getElementById('accountSetupForm');
  accountSetupError = document.getElementById('accountSetupError');
  accountSetupSubmitBtn = document.getElementById('accountSetupSubmitBtn');
  dashboardGreeting = document.getElementById('dashboardGreeting');
  dashboardProfilesGrid = document.getElementById('dashboardProfilesGrid');

  document.getElementById('dashboardBtn')?.addEventListener('click', () => {
    callbacks.showDashboard?.({ refreshProfiles: true });
  });

  accountSetupForm?.addEventListener('submit', submitAccountSetup);

  dashboardProfilesGrid?.addEventListener('click', async (event) => {
    const profileButton = event.target.closest('[data-dashboard-profile-id]');
    if (profileButton) {
      await openProfile(profileButton.dataset.dashboardProfileId);
      return;
    }

    if (event.target.closest('[data-dashboard-add-profile]')) {
      window.dispatchEvent(new CustomEvent('profile:create-requested'));
    }
  });
}

export function accountSetupComplete(user = appState?.currentUser) {
  return Boolean(user?.accountSetupCompletedAt || user?.account_setup_completed_at);
}

export function showAccountSetupPanel() {
  accountSetupPanel?.classList.remove('hidden');
  dashboardPanel?.classList.add('hidden');
  fillAccountSetupForm();
}

export function showDashboardPanel() {
  accountSetupPanel?.classList.add('hidden');
  dashboardPanel?.classList.remove('hidden');
  renderDashboard();
}

export function renderDashboard() {
  if (!dashboardPanel || !dashboardProfilesGrid) return;

  const firstName = getFirstName();
  const period = appState?.greetingPeriod || 'morning';
  if (dashboardGreeting) {
    dashboardGreeting.textContent = `Good ${period}, ${firstName}!`;
  }

  dashboardProfilesGrid.innerHTML = '';
  (appState.profiles || []).forEach(profile => {
    dashboardProfilesGrid.appendChild(createProfileTile(profile));
  });
  dashboardProfilesGrid.appendChild(createAddProfileTile());
}

function fillAccountSetupForm() {
  if (!accountSetupForm) return;
  const user = appState?.currentUser || {};
  const email = accountSetupForm.querySelector('#accountSetupEmail');
  const firstName = accountSetupForm.querySelector('#accountSetupFirstName');
  const lastName = accountSetupForm.querySelector('#accountSetupLastName');
  const dob = accountSetupForm.querySelector('#accountSetupDob');
  const gender = accountSetupForm.querySelector('#accountSetupGender');

  if (email) email.value = user.email || '';
  if (firstName && !firstName.value) firstName.value = user.firstName || '';
  if (lastName && !lastName.value) lastName.value = user.lastName || '';
  if (dob && !dob.value) dob.value = user.dateOfBirth || '';
  if (gender && !gender.value) gender.value = user.gender || '';

  if (accountSetupError) {
    accountSetupError.textContent = '';
    accountSetupError.style.display = 'none';
  }
  firstName?.focus();
}

async function submitAccountSetup(event) {
  event.preventDefault();
  if (!accountSetupForm) return;

  const payload = {
    firstName: accountSetupForm.querySelector('#accountSetupFirstName')?.value.trim(),
    lastName: accountSetupForm.querySelector('#accountSetupLastName')?.value.trim(),
    email: accountSetupForm.querySelector('#accountSetupEmail')?.value.trim(),
    dateOfBirth: accountSetupForm.querySelector('#accountSetupDob')?.value,
    gender: accountSetupForm.querySelector('#accountSetupGender')?.value,
  };

  accountSetupSubmitBtn.disabled = true;
  accountSetupSubmitBtn.textContent = 'Creating account…';
  showAutosave('saving');

  try {
    const result = await apiClient.post('/api/auth/account-setup', payload);
    appState.currentUser = result.user;
    appState.profiles = result.profiles || [];
    appState.activeProfileId = result.activeProfileId || result.profileId || null;
    appState.serverNow = result.serverNow;
    appState.serverTimezone = result.serverTimezone;
    appState.greetingPeriod = result.greetingPeriod;

    callbacks.renderProfilesList?.();
    await callbacks.showDashboard?.();
    showAutosave('saved');
  } catch (error) {
    if (accountSetupError) {
      accountSetupError.textContent = error.message;
      accountSetupError.style.display = 'block';
    }
    showAutosave('error');
  } finally {
    accountSetupSubmitBtn.disabled = false;
    accountSetupSubmitBtn.textContent = 'Create account';
  }
}

async function openProfile(profileId) {
  if (!profileId) return;
  showAutosave('saving');
  try {
    appState.activeProfileId = profileId;
    await apiClient.post(`/api/profiles/${profileId}/activate`);
    await callbacks.loadActiveProfile?.();
    showAutosave('saved');
  } catch (error) {
    console.error('Failed to open profile from dashboard', error);
    showAutosave('error');
    alert('Could not open this profile. Please try again.');
  }
}

function createProfileTile(profile) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dashboard-profile-tile';
  button.dataset.dashboardProfileId = profile.id;

  const avatar = document.createElement('div');
  avatar.className = 'dashboard-profile-avatar';
  avatar.style.backgroundColor = profile.avatar_color || '#D95C2B';

  if (profile.photo_path) {
    const img = document.createElement('img');
    img.src = profile.photo_path;
    img.alt = '';
    avatar.appendChild(img);
  } else {
    avatar.textContent = profile.avatar_initials || getInitials(profile.name);
  }

  const name = document.createElement('span');
  name.className = 'dashboard-profile-name';
  name.textContent = profile.name || 'Profile';

  const relation = document.createElement('span');
  relation.className = 'dashboard-profile-relation';
  relation.textContent = relationLabel(profile);

  button.append(avatar, name, relation);
  return button;
}

function createAddProfileTile() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dashboard-profile-tile dashboard-profile-tile--add';
  button.dataset.dashboardAddProfile = 'true';
  button.innerHTML = `
    <span class="dashboard-add-box" aria-hidden="true">+</span>
    <span class="dashboard-profile-name">Add profile</span>
    <span class="dashboard-profile-relation">New person</span>
  `;
  return button;
}

function getFirstName() {
  const user = appState?.currentUser || {};
  if (user.firstName) return user.firstName;
  const emailName = String(user.email || 'there').split('@')[0];
  return emailName ? emailName.split(/[._-]/)[0] : 'there';
}

function getInitials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function relationLabel(profile = {}) {
  const relation = profile.relation === 'Other' ? profile.relation_other : profile.relation;
  if (String(relation || '').toLowerCase() === 'myself') return 'Self';
  return relation || 'Profile';
}
