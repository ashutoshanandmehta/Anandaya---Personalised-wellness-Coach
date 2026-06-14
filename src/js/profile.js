import { apiClient } from './apiClient.js';
import { loadActiveProfile } from './app.js';

let appStateRef;

// DOM refs (set when initProfiles is called)
let profileDropdownContainer, profileBtn, headerAvatarEl, profileDropdown,
    dropdownEmail, dropdownProfilesList, dropdownNewProfileBtn;
let profileModal, closeProfileModal, cancelProfileModal, createProfileForm,
    newProfileRelation, newProfileRelationOtherGroup, profileFormError;
let editProfileModal, closeEditProfileModal, cancelEditProfileModal, editProfileForm,
    editProfileName, editProfileAge, editProfileSex, editProfileHeight, editProfileWeight,
    editProfileRelation, editProfileRelationOtherGroup, editProfileRelationOther,
    editProfileCategory, editProfileSeverity, editProfileRedFlags,
    editProfileConditions, editProfileAllergies, editProfileMedications,
    editProfileProgramDuration, editProfileGoalInput, editProfileAddGoalBtn, editProfileGoalsList,
    editProfileFormError, deleteProfileBtn, psbSettingsBtn;

let editGoals = [];


// ── Color palette for deterministic avatars ──
const AVATAR_COLORS = [
  '#2563EB', '#0891B2', '#059669', '#7C3AED',
  '#B45309', '#DC2626', '#0F5FAE', '#5BA04E'
];

function getAvatarColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function initProfiles(appState) {
  appStateRef = appState;

  profileDropdownContainer = document.getElementById('profileDropdownContainer');
  profileBtn = document.getElementById('profileBtn');
  headerAvatarEl = document.getElementById('headerAvatar');
  profileDropdown = document.getElementById('profileDropdown');
  dropdownEmail = document.getElementById('dropdownEmail');
  dropdownProfilesList = document.getElementById('dropdownProfilesList');
  dropdownNewProfileBtn = document.getElementById('dropdownNewProfileBtn');

  profileModal = document.getElementById('profileModal');
  closeProfileModal = document.getElementById('closeProfileModal');
  cancelProfileModal = document.getElementById('cancelProfileModal');
  createProfileForm = document.getElementById('createProfileForm');
  newProfileRelation = document.getElementById('newProfileRelation');
  newProfileRelationOtherGroup = document.getElementById('newProfileRelationOtherGroup');
  profileFormError = document.getElementById('profileFormError');

  editProfileModal = document.getElementById('editProfileModal');
  closeEditProfileModal = document.getElementById('closeEditProfileModal');
  cancelEditProfileModal = document.getElementById('cancelEditProfileModal');
  editProfileForm = document.getElementById('editProfileForm');
  editProfileName = document.getElementById('editProfileName');
  editProfileAge = document.getElementById('editProfileAge');
  editProfileSex = document.getElementById('editProfileSex');
  editProfileHeight = document.getElementById('editProfileHeight');
  editProfileWeight = document.getElementById('editProfileWeight');
  editProfileRelation = document.getElementById('editProfileRelation');
  editProfileRelationOtherGroup = document.getElementById('editProfileRelationOtherGroup');
  editProfileRelationOther = document.getElementById('editProfileRelationOther');
  editProfileCategory = document.getElementById('editProfileCategory');
  editProfileSeverity = document.getElementById('editProfileSeverity');
  editProfileRedFlags = document.getElementById('editProfileRedFlags');
  editProfileConditions = document.getElementById('editProfileConditions');
  editProfileAllergies = document.getElementById('editProfileAllergies');
  editProfileMedications = document.getElementById('editProfileMedications');
  editProfileProgramDuration = document.getElementById('editProfileProgramDuration');
  editProfileGoalInput = document.getElementById('editProfileGoalInput');
  editProfileAddGoalBtn = document.getElementById('editProfileAddGoalBtn');
  editProfileGoalsList = document.getElementById('editProfileGoalsList');
  editProfileFormError = document.getElementById('editProfileFormError');
  deleteProfileBtn = document.getElementById('deleteProfileBtn');
  psbSettingsBtn = document.getElementById('psbSettingsBtn');


  // Dropdown toggle
  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = profileDropdown.classList.contains('active');
    if (!isOpen) {
      window.dispatchEvent(new CustomEvent('app-popover:open', { detail: { source: 'profile' } }));
    }
    profileDropdown.classList.toggle('active', !isOpen);
    profileBtn.setAttribute('aria-expanded', String(!isOpen));
  });

  document.addEventListener('click', (e) => {
    if (!profileDropdownContainer.contains(e.target)) {
      profileDropdown.classList.remove('active');
      profileBtn.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      profileDropdown.classList.remove('active');
      profileBtn.setAttribute('aria-expanded', 'false');
    }
  });

  window.addEventListener('app-popover:open', (event) => {
    if (event.detail?.source !== 'profile') closeProfileDropdown();
  });

  // New profile buttons
  dropdownNewProfileBtn.addEventListener('click', () => {
    profileDropdown.classList.remove('active');
    openProfileModal();
  });

  document.getElementById('createFirstProfileBtn')?.addEventListener('click', () => {
    openProfileModal();
  });
  window.addEventListener('profile:create-requested', () => {
    openProfileModal();
  });

  // Modal handlers
  function openProfileModal() {
    createProfileForm.reset();
    newProfileRelationOtherGroup.classList.add('hidden');
    if (profileFormError) { profileFormError.textContent = ''; profileFormError.style.display = 'none'; }
    updateAvatarPreview('');
    profileModal.classList.remove('hidden');
    document.getElementById('newProfileName').focus();
  }

  function closeProfileModalFn() {
    profileModal.classList.add('hidden');
  }

  closeProfileModal.addEventListener('click', closeProfileModalFn);
  cancelProfileModal.addEventListener('click', closeProfileModalFn);
  profileModal.addEventListener('click', (e) => {
    if (e.target === profileModal) closeProfileModalFn();
  });

  // Avatar/Photo preview update
  document.getElementById('newProfileName').addEventListener('input', (e) => {
    updateAvatarPreview(e.target.value);
  });

  const photoInput = document.getElementById('modalPhotoFile');
  const photoPreview = document.getElementById('modalPhotoPreview');
  const photoAvatar = document.getElementById('modalPhotoAvatar');
  let selectedPhotoFile = null;

  photoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        if (profileFormError) { profileFormError.textContent = 'Photo must be under 5 MB'; profileFormError.style.display = 'block'; }
        photoInput.value = '';
        return;
      }
      selectedPhotoFile = file;
      const reader = new FileReader();
      reader.onload = (evt) => {
        photoPreview.src = evt.target.result;
        photoPreview.classList.remove('hidden');
        photoAvatar.classList.add('hidden');
        if (profileFormError) profileFormError.style.display = 'none';
      };
      reader.readAsDataURL(file);
    }
  });

  function updateAvatarPreview(name) {
    if (selectedPhotoFile) return; // don't overwrite if photo is set
    const initials = name ? getInitials(name) : '?';
    const color = name ? getAvatarColor(name) : '#26303A';
    if (photoAvatar) {
      photoAvatar.textContent = initials;
      photoAvatar.style.backgroundColor = color;
      photoAvatar.classList.remove('hidden');
    }
    if (photoPreview) {
      photoPreview.classList.add('hidden');
      photoPreview.src = '';
    }
  }

  // Relation "Other" toggle
  newProfileRelation.addEventListener('change', (e) => {
    if (e.target.value === 'Other') {
      newProfileRelationOtherGroup.classList.remove('hidden');
      document.getElementById('newProfileRelationOther').required = true;
    } else {
      newProfileRelationOtherGroup.classList.add('hidden');
      document.getElementById('newProfileRelationOther').required = false;
    }
  });

  // Profile form submit
  createProfileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('saveProfileBtn');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const name = document.getElementById('newProfileName').value.trim();
      const relation = newProfileRelation.value;
      const relation_other = relation === 'Other'
        ? document.getElementById('newProfileRelationOther').value.trim()
        : null;

      const formData = new FormData();
      formData.append('name', name);
      formData.append('relation', relation);
      if (relation_other) formData.append('relation_other', relation_other);
      if (selectedPhotoFile) formData.append('photo', selectedPhotoFile);

      // Using fetch directly since apiClient might not natively support FormData with the right headers
      const token = localStorage.getItem('auth_token');
      const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: {
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: formData
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP error! status: ${res.status}`);
      }

      const data = await res.json();
      closeProfileModalFn();
      appStateRef.activeProfileId = data.profileId;
      selectedPhotoFile = null;
      window.dispatchEvent(new CustomEvent('dashboard:show', {
        detail: { createdProfileId: data.profileId }
      }));
    } catch (error) {
      if (profileFormError) {
        profileFormError.textContent = error.message;
        profileFormError.style.display = 'block';
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create profile';
    }
  });

  // Edit Profile / Settings listeners
  if (psbSettingsBtn) {
    psbSettingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      
      const active = appStateRef.profiles?.find(p => p.id === appStateRef.activeProfileId);
      if (!active) {
        console.warn('[Settings] No active profile found. State:', { 
          profiles: appStateRef.profiles?.length, 
          activeProfileId: appStateRef.activeProfileId 
        });
        return;
      }

      editProfileName.value = active.name || '';
      if (editProfileRelation) editProfileRelation.value = active.relation || 'Myself';
      if (editProfileRelationOther) editProfileRelationOther.value = active.relation_other || '';
      updateEditRelationOtherVisibility();
      
      const prof = appStateRef.patientState?.structured_profile || {};
      editProfileAge.value = prof.age != null ? prof.age : '';
      editProfileSex.value = prof.sex || '';
      editProfileHeight.value = prof.height || '';
      editProfileWeight.value = prof.weight || '';
      if (editProfileCategory) editProfileCategory.value = prof.category || '';
      if (editProfileSeverity) editProfileSeverity.value = prof.severity || '';
      if (editProfileRedFlags) editProfileRedFlags.value = arrayToLines(prof.red_flags || prof.redFlags);
      if (editProfileConditions) editProfileConditions.value = arrayToLines(prof.conditions);
      if (editProfileAllergies) editProfileAllergies.value = arrayToLines(prof.allergies);
      if (editProfileMedications) editProfileMedications.value = arrayToLines(prof.medications);
      if (editProfileProgramDuration) editProfileProgramDuration.value = prof.program_duration_days || '';
      editGoals = normalizeGoals(prof.goals);
      renderEditGoals();

      if (editProfileFormError) {
        editProfileFormError.textContent = '';
        editProfileFormError.style.display = 'none';
      }

      editProfileModal.classList.remove('hidden');
      editProfileName.focus();
    });
  }

  if (editProfileRelation) {
    editProfileRelation.addEventListener('change', updateEditRelationOtherVisibility);
  }

  if (editProfileAddGoalBtn) {
    editProfileAddGoalBtn.addEventListener('click', addGoalFromInput);
  }

  if (editProfileGoalInput) {
    editProfileGoalInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addGoalFromInput();
      }
    });
  }

  function closeEditProfileModalFn() {
    if (editProfileModal) editProfileModal.classList.add('hidden');
  }

  if (closeEditProfileModal) closeEditProfileModal.addEventListener('click', closeEditProfileModalFn);
  if (cancelEditProfileModal) cancelEditProfileModal.addEventListener('click', closeEditProfileModalFn);
  if (editProfileModal) {
    editProfileModal.addEventListener('click', (e) => {
      if (e.target === editProfileModal) closeEditProfileModalFn();
    });
  }

  if (editProfileForm) {
    editProfileForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saveBtn = document.getElementById('saveEditProfileBtn');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
      }
      try {
        const name = editProfileName.value.trim();
        const age = editProfileAge.value ? parseInt(editProfileAge.value) : null;
        const sex = editProfileSex.value || null;
        const height = editProfileHeight.value.trim() || null;
        const weight = editProfileWeight.value.trim() || null;
        const relation = editProfileRelation?.value || null;
        const relation_other = relation === 'Other'
          ? (editProfileRelationOther?.value.trim() || null)
          : null;
        const category = editProfileCategory?.value.trim() || null;
        const severity = editProfileSeverity?.value || null;
        const red_flags = linesToArray(editProfileRedFlags?.value);
        const conditions = linesToArray(editProfileConditions?.value);
        const allergies = linesToArray(editProfileAllergies?.value);
        const medications = linesToArray(editProfileMedications?.value);
        const program_duration_days = editProfileProgramDuration?.value
          ? parseInt(editProfileProgramDuration.value, 10)
          : null;

        await apiClient.put(`/api/profiles/${appStateRef.activeProfileId}`, {
          name,
          relation,
          relation_other,
          age,
          sex,
          height,
          weight,
          category,
          severity,
          red_flags,
          conditions,
          allergies,
          medications,
          goals: editGoals,
          program_duration_days,
          goals_confirmed: editGoals.length > 0
        });

        closeEditProfileModalFn();
        await loadActiveProfile();
      } catch (error) {
        if (editProfileFormError) {
          editProfileFormError.textContent = error.message;
          editProfileFormError.style.display = 'block';
        }
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save changes';
        }
      }
    });
  }

  if (deleteProfileBtn) {
    deleteProfileBtn.addEventListener('click', async () => {
      const active = appStateRef.profiles?.find(p => p.id === appStateRef.activeProfileId);
      const name = active ? active.name : 'this profile';
      if (!confirm(`Are you sure you want to delete the profile for "${name}"? This will permanently erase all check-ins, messages, and settings for this patient.`)) {
        return;
      }

      deleteProfileBtn.disabled = true;
      deleteProfileBtn.textContent = 'Deleting…';
      try {
        const result = await apiClient.delete(`/api/profiles/${appStateRef.activeProfileId}`);
        closeEditProfileModalFn();
        
        if (result.nextProfileId) {
          appStateRef.activeProfileId = result.nextProfileId;
          await loadActiveProfile();
        } else {
          appStateRef.activeProfileId = null;
          appStateRef.patientState = null;
          appStateRef.profiles = [];
          
          document.getElementById('mainAppLayout').classList.add('hidden');
          document.getElementById('emptyStateShell').classList.remove('hidden');
          renderProfilesList();
        }
      } catch (error) {
        if (editProfileFormError) {
          editProfileFormError.textContent = error.message;
          editProfileFormError.style.display = 'block';
        }
      } finally {
        deleteProfileBtn.disabled = false;
        deleteProfileBtn.textContent = 'Delete profile';
      }
    });
  }
}

export function renderProfilesList() {
  if (!appStateRef) return;

  dropdownEmail.textContent = appStateRef.currentUser?.email || '';

  const profiles = appStateRef.profiles || [];

  if (profiles.length === 0) {
    headerAvatarEl.textContent = '?';
    headerAvatarEl.style.backgroundColor = '#26303A';
    dropdownProfilesList.innerHTML = '<div style="padding: 12px 20px; font-size: 0.8125rem; color: var(--text-muted);">No profiles yet</div>';
    return;
  }

  // Update header avatar
  const active = profiles.find(p => p.id === appStateRef.activeProfileId) || profiles[0];
  const initials = getInitials(active.name);
  const color = getAvatarColor(active.name || active.id);
  headerAvatarEl.textContent = initials;
  headerAvatarEl.style.backgroundColor = color;

  // Render list
  dropdownProfilesList.innerHTML = '';
  profiles.forEach(profile => {
    const isActive = profile.id === appStateRef.activeProfileId;
    const el = document.createElement('button');
    el.className = `profile-item${isActive ? ' active' : ''}`;
    el.setAttribute('role', 'menuitem');

    const pInitials = getInitials(profile.name);
    const pColor = getAvatarColor(profile.name || profile.id);
    const relationText = profile.relation === 'Other' ? profile.relation_other : profile.relation;

    el.innerHTML = `
      <div class="avatar avatar-sm" style="background-color: ${pColor};">${pInitials}</div>
      <div class="profile-item-info">
        <span class="profile-item-name">${escapeHtml(profile.name)}</span>
        <span class="profile-item-relation">${escapeHtml(relationText || '')}</span>
      </div>
      ${isActive ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-left:auto;color:var(--brand-blue-soft);flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
    `;

    el.addEventListener('click', async () => {
      if (isActive) { closeProfileDropdown(); return; }
      closeProfileDropdown();
      appStateRef.activeProfileId = profile.id;
      try {
        await apiClient.post(`/api/profiles/${profile.id}/activate`);
        await loadActiveProfile();
      } catch (err) {
        console.error('Failed to activate profile', err);
      }
    });

    dropdownProfilesList.appendChild(el);
  });
}

function closeProfileDropdown() {
  profileDropdown?.classList.remove('active');
  profileBtn?.setAttribute('aria-expanded', 'false');
}

function updateEditRelationOtherVisibility() {
  if (!editProfileRelation || !editProfileRelationOtherGroup || !editProfileRelationOther) return;
  const show = editProfileRelation.value === 'Other';
  editProfileRelationOtherGroup.classList.toggle('hidden', !show);
  editProfileRelationOther.required = show;
}

function addGoalFromInput() {
  const value = editProfileGoalInput?.value.trim();
  if (!value) return;
  if (!editGoals.some(goal => goal.toLowerCase() === value.toLowerCase())) {
    editGoals.push(value);
    renderEditGoals();
  }
  editProfileGoalInput.value = '';
  editProfileGoalInput.focus();
}

function renderEditGoals() {
  if (!editProfileGoalsList) return;
  if (!editGoals.length) {
    editProfileGoalsList.innerHTML = '<div class="settings-empty">No confirmed goals yet</div>';
    return;
  }

  editProfileGoalsList.innerHTML = editGoals.map((goal, index) => `
    <div class="settings-goal-row">
      <span>${escapeHtml(goal)}</span>
      <button type="button" class="settings-goal-remove" data-remove-goal="${index}" aria-label="Remove ${escapeHtml(goal)}">Remove</button>
    </div>
  `).join('');

  editProfileGoalsList.querySelectorAll('[data-remove-goal]').forEach(button => {
    button.addEventListener('click', () => {
      editGoals.splice(Number(button.dataset.removeGoal), 1);
      renderEditGoals();
    });
  });
}

function normalizeGoals(value) {
  return Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : [];
}

function linesToArray(value = '') {
  return String(value || '')
    .split(/\n|,/)
    .map(item => item.trim())
    .filter(Boolean);
}

function arrayToLines(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}
