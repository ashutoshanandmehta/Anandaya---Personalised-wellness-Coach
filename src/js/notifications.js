import { apiClient } from './apiClient.js';

let appState;
let loadActiveProfileCallback;
let notificationBtn;
let notificationBadge;
let notificationPanel;
let notificationSummary;
let notificationList;
let notificationCloseBtn;
let notificationPollHandle;

export function initNotifications(stateRef, options = {}) {
  appState = stateRef;
  loadActiveProfileCallback = options.loadActiveProfile;

  notificationBtn = document.getElementById('notificationBtn');
  notificationBadge = document.getElementById('notificationBadge');
  notificationPanel = document.getElementById('notificationPanel');
  notificationSummary = document.getElementById('notificationSummary');
  notificationList = document.getElementById('notificationList');
  notificationCloseBtn = document.getElementById('notificationCloseBtn');

  if (!notificationBtn || !notificationPanel) return;

  notificationBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = notificationPanel.classList.contains('active');
    if (!isOpen) {
      window.dispatchEvent(new CustomEvent('app-popover:open', { detail: { source: 'notifications' } }));
    }
    setPanelOpen(!isOpen);
    if (!isOpen) loadNotifications();
  });

  notificationCloseBtn?.addEventListener('click', () => setPanelOpen(false));

  document.addEventListener('click', (event) => {
    const container = document.getElementById('notificationContainer');
    if (container && !container.contains(event.target)) {
      setPanelOpen(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setPanelOpen(false);
  });

  window.addEventListener('notifications:refresh', () => {
    loadNotifications();
    loadActiveReminders();
    loadActiveCheckinProgress();
  });

  window.addEventListener('app-popover:open', (event) => {
    if (event.detail?.source !== 'notifications') setPanelOpen(false);
  });

  if (!notificationPollHandle) {
    notificationPollHandle = window.setInterval(() => {
      if (!appState?.currentUser) return;
      loadNotifications();
      loadActiveReminders();
    }, 30_000);
  }
}

export async function loadNotifications() {
  if (!appState?.currentUser || !notificationList) return [];

  try {
    const rows = await apiClient.get('/api/reminders');
    appState.checkinNotifications = rows;
    renderNotifications(rows);
    return rows;
  } catch (error) {
    console.warn('Failed to load check-in notifications', error);
    renderNotifications([]);
    return [];
  }
}

export async function loadActiveReminders() {
  if (!appState?.activeProfileId) return [];

  try {
    const rows = await apiClient.get(`/api/reminders?profileId=${encodeURIComponent(appState.activeProfileId)}&status=active&limit=8`);
    appState.activeReminders = rows;
    window.dispatchEvent(new CustomEvent('active-reminders:updated'));
    return rows;
  } catch (error) {
    console.warn('Failed to load active reminders', error);
    appState.activeReminders = [];
    window.dispatchEvent(new CustomEvent('active-reminders:updated'));
    return [];
  }
}

export async function loadActiveCheckinProgress() {
  if (!appState?.activeProfileId) return [];

  try {
    const rows = await apiClient.get(`/api/profiles/${appState.activeProfileId}/checkins/progress`);
    appState.checkinProgress = rows;
    window.dispatchEvent(new CustomEvent('checkin-progress:updated'));
    return rows;
  } catch (error) {
    console.warn('Failed to load check-in progress', error);
    appState.checkinProgress = [];
    return [];
  }
}

function setPanelOpen(open) {
  notificationPanel?.classList.toggle('active', open);
  notificationBtn?.classList.toggle('active', open);
  notificationBtn?.setAttribute('aria-expanded', String(open));
}

function renderNotifications(rows) {
  const dueCount = rows.filter(item => item.status === 'due' || item.status === 'sent').length;
  const missedCount = rows.filter(item => item.status === 'missed').length;
  const scheduledCount = rows.filter(item => item.status === 'scheduled').length;
  const badgeCount = dueCount + missedCount;

  if (notificationBadge) {
    notificationBadge.textContent = String(Math.min(badgeCount, 99));
    notificationBadge.classList.toggle('hidden', badgeCount === 0);
  }

  if (notificationSummary) {
    notificationSummary.textContent = buildSummary({ dueCount, missedCount, scheduledCount });
  }

  if (!rows.length) {
    notificationList.innerHTML = '<div class="notification-empty">No scheduled items</div>';
    return;
  }

  notificationList.innerHTML = rows.map(renderNotificationItem).join('');
  notificationList.querySelectorAll('[data-open-checkin]').forEach(button => {
    button.addEventListener('click', () => {
      openCheckin(button.dataset.openCheckin);
    });
  });
}

function buildSummary({ dueCount, missedCount, scheduledCount }) {
  if (dueCount) return `${dueCount} ready item${dueCount === 1 ? '' : 's'}`;
  if (missedCount) return `${missedCount} missed item${missedCount === 1 ? '' : 's'}`;
  if (scheduledCount) return `${scheduledCount} scheduled item${scheduledCount === 1 ? '' : 's'}`;
  return 'No scheduled items';
}

function renderNotificationItem(item) {
  const statusClass = `${escapeHtml(item.status || 'scheduled')} ${escapeHtml(item.displayState || '')}`.trim();
  const canOpen = item.canOpen === true;
  const friendly = buildFriendlyNotificationCopy(item);
  const title = friendly.title;
  const body = friendly.body;
  const meta = getNotificationMeta(item);

  return `
    <div class="notification-item ${statusClass}">
      <div class="notification-item-row">
        <span class="notification-dot" aria-hidden="true"></span>
        <div class="notification-copy">
          <div class="notification-title">${escapeHtml(title)}</div>
          <div class="notification-body">${escapeHtml(body)}</div>
          <div class="notification-meta">${escapeHtml(meta)}</div>
        </div>
      </div>
      ${canOpen ? `
        <div class="notification-actions">
          <button class="notification-action-btn" type="button" data-open-checkin="${escapeHtml(item.id)}">Open</button>
        </div>
      ` : ''}
    </div>
  `;
}

async function openCheckin(checkinId) {
  const item = appState.checkinNotifications?.find(row => row.id === checkinId);
  if (!item) return;

  try {
    if (item.profileId && item.profileId !== appState.activeProfileId) {
      appState.activeProfileId = item.profileId;
      await apiClient.post(`/api/profiles/${item.profileId}/activate`);
      if (typeof loadActiveProfileCallback === 'function') {
        await loadActiveProfileCallback();
      }
    }

    const opened = await apiClient.post(`/api/scheduled-checkins/${checkinId}/open`, {});
    setPanelOpen(false);
    window.dispatchEvent(new CustomEvent('checkin:opened', { detail: { checkin: opened } }));
    await loadNotifications();
  } catch (error) {
    console.error('Failed to open check-in', error);
    alert('Could not open this check-in. Please try again.');
  }
}

function getNotificationMeta(item) {
  if (item.displayMeta) return item.displayMeta;
  if (item.status === 'completed') {
    return item.completedAt ? `Updated ${formatTime(item.completedAt)}` : 'Completed';
  }
  if (item.status === 'missed') return 'Missed';
  if (item.status === 'due' || item.status === 'sent') return 'Due now';
  if (item.formattedDueText) return item.formattedDueText;

  const target = new Date(item.scheduledFor);
  if (Number.isNaN(target.getTime())) return 'Scheduled';

  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return 'Due now';

  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return `Due in ${diffMin} min`;

  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return `Due in ${diffHours} hr`;

  return `Due ${target.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
}

function buildFriendlyNotificationCopy(item = {}) {
  const rawTitle = item.displayTitle || item.inAppTitle || item.pushTitle || item.title || 'Check-in';
  const rawBody = item.displayBody || item.inAppBody || item.pushBody || 'Open to update progress.';
  const kind = item.kind || item.metadata?.kind || 'checkin';

  if (kind !== 'checkin' || !isGenericCheckinCopy(rawTitle, rawBody)) {
    return { title: rawTitle, body: rawBody };
  }

  const profileName = item.profileName || item.metadata?.profileName || 'this profile';
  const isSelf = /^your|you\b/i.test(rawTitle) || item.relation === 'self';
  const taxonomy = String(item.metadata?.taxonomy || item.category || item.type || '').toLowerCase();

  if (/sleep|wind/.test(taxonomy)) {
    return {
      title: isSelf ? 'Morning sleep detective moment 🌙' : `Sleep detective moment for ${profileName} 🌙`,
      body: 'Tap in when you are ready to rate last night.',
    };
  }
  if (/medicine|medication|pill|dose/.test(taxonomy)) {
    return {
      title: isSelf ? 'Quick medicine follow-up 💊' : `Medicine follow-up for ${profileName} 💊`,
      body: 'Tap to log whether the prescribed reminder happened.',
    };
  }
  if (/water|hydrat/.test(taxonomy)) {
    return {
      title: isSelf ? 'Sip check, no pressure 💧' : `Sip check for ${profileName} 💧`,
      body: 'Tap for a tiny sip report.',
    };
  }
  if (/meal|food|nutrition|cook/.test(taxonomy)) {
    return {
      title: isSelf ? 'Meal check, real life edition 🍽️' : `Meal check for ${profileName} 🍽️`,
      body: 'Tap for a quick real-life meal check.',
    };
  }
  if (/recover|symptom|pain|stomach|health/.test(taxonomy)) {
    return {
      title: isSelf ? 'Tiny health check 🙂' : `Tiny health check for ${profileName} 🙂`,
      body: 'Tap for a tiny health update.',
    };
  }
  if (/habit|stress|movement/.test(taxonomy)) {
    return {
      title: isSelf ? 'Reality check, kindly 😄' : `Reality check for ${profileName} 😄`,
      body: 'Tap for a no-judgment progress check.',
    };
  }

  return {
    title: isSelf ? 'Tiny progress ping ✨' : `Tiny progress ping for ${profileName} ✨`,
    body: 'Tap to share a quick update.',
  };
}

function isGenericCheckinCopy(title = '', body = '') {
  const combined = `${title} ${body}`.toLowerCase();
  return /time for .*check-in|time for your check-in|tap to update today/.test(combined);
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str ?? '')));
  return div.innerHTML;
}
