// user-settings.js — Modal dialog for user settings
// Account management and logout

import { refreshIcons } from './icons.js';
import { showToast } from './utils.js';
import { applyServerThemePrefs } from './theme.js';
import { mountThemeChoice } from './theme-choice.js';
import { mountChatWidthChoice } from './chat-width-choice.js';
import { applyServerChatWidth } from './chat-width.js';
import {
  sessionListAvatarsEnabled, setSessionListAvatars, onSessionListAvatarsChange,
  applyServerSessionListAvatars
} from './session-list-avatars.js';
import { setSTTLang } from './stt.js';
import { userAvatarUrl } from './avatar.js';
import { showOverlay } from './overlay.js';
import { isPhoneSettingsLayout } from './settings-access.js';
import { mountSettingsBack } from './settings-nav.js';

var ctx = null;
var settingsEl = null;
var openBtn = null;
// The handle of the last panel open (overlay.js); null until the panel is first
// opened and kept after it closes. isOpen() says whether it is open now.
var panelHandle = null;
var navItems = null;
var sections = null;
var pinForm = null;
var pinSetBtn = null;
var pinCancelBtn = null;
var pinEnabled = false;
var currentProfile = null;
var backBar = null;

export function initUserSettings(appCtx) {
  ctx = appCtx;
  settingsEl = document.getElementById('user-settings');
  openBtn = document.getElementById('user-settings-btn');

  if (!settingsEl || !openBtn) return;

  navItems = settingsEl.querySelectorAll('.us-nav-item');
  sections = settingsEl.querySelectorAll('.us-section');
  pinForm = document.getElementById('us-pin-form');

  openBtn.addEventListener('click', function () {
    openUserSettings();
  });

  for (var i = 0; i < navItems.length; i++) {
    navItems[i].addEventListener('click', function () {
      var section = this.dataset.section;
      switchSection(section);
    });
  }

  // Phone: the Back bar stands in for the section list, which the shared
  // Settings list replaces there.
  backBar = mountSettingsBack(settingsEl.querySelector('.us-modal-nav'), {
    label: 'Back to Settings',
    onBack: closeUserSettings,
  });

  // PIN save button
  var pinInput = document.getElementById('us-pin-input');
  var pinConfirmInput = document.getElementById('us-pin-confirm-input');
  var pinCurrentInput = document.getElementById('us-pin-current-input');
  var pinSave = document.getElementById('us-pin-save');
  pinSetBtn = document.getElementById('us-pin-set-btn');
  pinCancelBtn = document.getElementById('us-pin-cancel');
  if (pinInput && pinConfirmInput && pinSave) {
    function validatePin() {
      var validNew = /^\d{6}$/.test(pinInput.value);
      var validConfirm = /^\d{6}$/.test(pinConfirmInput.value);
      var validCurrent = !pinEnabled || (pinCurrentInput && /^\d{6}$/.test(pinCurrentInput.value));
      pinSave.disabled = !(validNew && validConfirm && validCurrent && pinInput.value === pinConfirmInput.value);
    }
    pinInput.addEventListener('input', validatePin);
    pinConfirmInput.addEventListener('input', validatePin);
    if (pinCurrentInput) pinCurrentInput.addEventListener('input', validatePin);
    pinInput.addEventListener('keyup', function (e) { e.stopPropagation(); validatePin(); });
    pinConfirmInput.addEventListener('keyup', function (e) { e.stopPropagation(); validatePin(); });
    if (pinCurrentInput) pinCurrentInput.addEventListener('keyup', function (e) { e.stopPropagation(); validatePin(); });
    pinInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        savePin(pinInput.value);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hidePinForm();
      }
    });
    pinConfirmInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        savePin(pinInput.value);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hidePinForm();
      }
    });
    if (pinCurrentInput) {
      pinCurrentInput.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          savePin(pinInput.value);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hidePinForm();
        }
      });
    }
    pinInput.addEventListener('keypress', stopProp);
    pinConfirmInput.addEventListener('keypress', stopProp);
    if (pinCurrentInput) pinCurrentInput.addEventListener('keypress', stopProp);
    pinSave.addEventListener('click', function () {
      savePin(pinInput.value);
    });
  }
  if (pinSetBtn) {
    pinSetBtn.addEventListener('click', function () {
      showPinForm();
    });
  }
  if (pinCancelBtn) {
    pinCancelBtn.addEventListener('click', function () {
      hidePinForm();
    });
  }

  var langSelect = document.getElementById('us-lang-select');
  if (langSelect) {
    langSelect.addEventListener('change', function () {
      saveProfileChange({ lang: this.value });
    });
  }

  // Auto-continue toggle
  var autoContinueToggle = document.getElementById('us-auto-continue');
  if (autoContinueToggle) {
    autoContinueToggle.addEventListener('change', function () {
      fetch('/api/user/auto-continue', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: this.checked }),
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data.ok) showToast(data.autoContinueOnRateLimit ? 'Auto-continue on' : 'Auto-continue off');
      }).catch(function () {});
    });
  }

  // Theme choice (Dark, Light, Follow system, custom themes): the shared component
  var themeSwitcher = document.getElementById('us-theme-switcher');
  if (themeSwitcher) {
    mountThemeChoice(themeSwitcher, { layout: 'cards' });
  }

  // Chat width (Compact, Comfortable, Wide, Full): the shared component, beside the theme
  var widthSwitcher = document.getElementById('us-width-switcher');
  if (widthSwitcher) {
    mountChatWidthChoice(widthSwitcher, { showDescriptions: true });
  }

  // Avatars in session list: applied at once, saved per user. The checkbox follows
  // the setting, so a change from another device or surface updates it too.
  var listAvatarsToggle = document.getElementById('us-session-list-avatars');
  if (listAvatarsToggle) {
    listAvatarsToggle.checked = sessionListAvatarsEnabled();
    listAvatarsToggle.addEventListener('change', function () {
      setSessionListAvatars(this.checked);
    });
    onSessionListAvatarsChange(function (on) { listAvatarsToggle.checked = on; });
  }

  // Logout button
  var logoutBtn = document.getElementById('us-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      fetch('/auth/logout', { method: 'POST' }).then(function () {
        window.location.reload();
      }).catch(function () {
        window.location.reload();
      });
    });
  }

}

// Optional `initialSection` lets callers deep-link directly into a specific
// settings tab. Falls back to Account so existing callers and the icon click are unchanged.
export function openUserSettings(initialSection) {
  // On a phone the panel is a page of the Settings list, so a back swipe
  // closes it like the other settings panels (the history option); desktop
  // holds no entry.
  panelHandle = showOverlay({
    kind: 'modal', panel: true, el: settingsEl, history: isPhoneSettingsLayout,
    onRemove: function () { openBtn.classList.remove('active'); },
  });
  // Refused while a dialog is open (overlay-registry.js isPanelBlocked).
  if (!panelHandle.isOpen()) return;
  openBtn.classList.add('active');
  refreshIcons(settingsEl);
  populateAccount();
  hidePinForm();
  switchSection(initialSection || 'us-account');
}

export function closeUserSettings() {
  if (panelHandle) panelHandle.close();
}

export function isUserSettingsOpen() {
  return !!panelHandle && panelHandle.isOpen();
}

function switchSection(sectionName) {
  for (var i = 0; i < navItems.length; i++) {
    navItems[i].classList.toggle('active', navItems[i].dataset.section === sectionName);
  }
  for (var j = 0; j < sections.length; j++) {
    sections[j].classList.toggle('active', sections[j].dataset.section === sectionName);
  }
  if (backBar) {
    for (var k = 0; k < navItems.length; k++) {
      if (navItems[k].dataset.section === sectionName) backBar.setTitle(navItems[k].textContent.trim());
    }
  }
}

function stopProp(e) {
  e.stopPropagation();
}

function showPinForm() {
  if (!pinForm) return;
  pinForm.classList.remove('hidden');
  var pinCurrentRow = document.getElementById('us-pin-current-row');
  var pinInput = document.getElementById('us-pin-input');
  var pinConfirmInput = document.getElementById('us-pin-confirm-input');
  var pinCurrentInput = document.getElementById('us-pin-current-input');
  var pinSave = document.getElementById('us-pin-save');
  var pinMsg = document.getElementById('us-pin-msg');
  var pinFormTitle = document.getElementById('us-pin-form-title');
  if (pinFormTitle) {
    pinFormTitle.textContent = pinEnabled ? 'Change PIN' : 'Set PIN';
  }
  if (pinCurrentRow) {
    pinCurrentRow.classList.toggle('hidden', !pinEnabled);
  }
  if (pinInput) {
    pinInput.value = '';
  }
  if (pinConfirmInput) pinConfirmInput.value = '';
  if (pinCurrentInput) pinCurrentInput.value = '';
  if (pinSave) pinSave.disabled = true;
  if (pinSave) pinSave.textContent = 'Save';
  if (pinMsg) {
    pinMsg.textContent = '';
    pinMsg.className = 'settings-hint settings-pin-error hidden';
  }
  if (pinEnabled && pinCurrentInput) {
    pinCurrentInput.focus();
  } else if (pinInput) {
    pinInput.focus();
  }
}

function hidePinForm() {
  if (!pinForm) return;
  pinForm.classList.add('hidden');
  var pinCurrentRow = document.getElementById('us-pin-current-row');
  var pinInput = document.getElementById('us-pin-input');
  var pinConfirmInput = document.getElementById('us-pin-confirm-input');
  var pinCurrentInput = document.getElementById('us-pin-current-input');
  var pinSave = document.getElementById('us-pin-save');
  var pinMsg = document.getElementById('us-pin-msg');
  if (pinCurrentRow) {
    pinCurrentRow.classList.remove('hidden');
  }
  if (pinInput) pinInput.value = '';
  if (pinConfirmInput) pinConfirmInput.value = '';
  if (pinCurrentInput) pinCurrentInput.value = '';
  if (pinSave) pinSave.disabled = true;
  if (pinSave) pinSave.textContent = 'Save';
  if (pinMsg) {
    pinMsg.textContent = '';
    pinMsg.className = 'settings-hint settings-pin-error hidden';
  }
}

// --- Account population ---

function populateAccount() {
  fetch('/api/profile').then(function (r) {
    if (!r.ok) return null;
    return r.json();
  }).then(function (data) {
    if (!data) return;
    currentProfile = data;
    var displayName = data.name || data.displayName || data.username || 'User';
    var avatarImg = document.getElementById('us-account-avatar-img');
    var avatarFallback = document.getElementById('us-account-avatar-fallback');
    var accountName = document.getElementById('us-account-name');
    var accountSubline = document.getElementById('us-account-subline');
    var langSelect = document.getElementById('us-lang-select');
    var pinSetBtnEl = document.getElementById('us-pin-set-btn');
    var pinFormTitle = document.getElementById('us-pin-form-title');
    if (accountName) {
      accountName.textContent = displayName;
    }
    if (accountSubline) {
      var parts = [];
      if (data.username) parts.push('@' + data.username);
      if (data.role) parts.push(data.role.charAt(0).toUpperCase() + data.role.slice(1));
      accountSubline.textContent = parts.length ? parts.join(' · ') : 'Local profile';
    }
    pinEnabled = !!data.pinEnabled;
    if (pinSetBtnEl) {
      pinSetBtnEl.textContent = pinEnabled ? 'Change PIN' : 'Set PIN';
    }
    if (pinFormTitle) {
      pinFormTitle.textContent = pinEnabled ? 'Change PIN' : 'Set PIN';
    }
    if (langSelect) {
      langSelect.value = data.lang || 'en-US';
    }
    if (data.lang) {
      setSTTLang(data.lang);
    }
    if (avatarImg && avatarFallback) {
      var avatarUrl = getCurrentUserAvatarSrc(data);
      avatarImg.alt = displayName;
      avatarImg.classList.remove('hidden');
      avatarFallback.classList.remove('hidden');
      avatarFallback.textContent = avatarInitials(displayName);
      avatarImg.onload = function () {
        avatarFallback.classList.add('hidden');
      };
      avatarImg.onerror = function () {
        avatarFallback.classList.remove('hidden');
      };
      avatarImg.src = avatarUrl;
      if (avatarImg.complete && avatarImg.naturalWidth > 0) {
        avatarFallback.classList.add('hidden');
      }
    }
    // Auto-continue toggle
    var acToggle = document.getElementById('us-auto-continue');
    if (acToggle) acToggle.checked = !!data.autoContinueOnRateLimit;
    // Apply server-side theme preferences (overrides stale localStorage on mobile/cross-device)
    // (the theme choice component re-renders itself when the theme changes)
    applyServerThemePrefs({ themeMode: data.themeMode, themeId: data.themeId });
    // Chat width: the server's value applies (the component re-renders itself)
    applyServerChatWidth({ chatWidth: data.chatWidth });
    applyServerSessionListAvatars({ sessionListAvatars: data.sessionListAvatars });
  }).catch(function () {});
}

function saveProfileChange(updates) {
  if (!currentProfile) return;
  var nextProfile = {};
  var payload = {};
  var key;
  for (key in currentProfile) {
    if (Object.prototype.hasOwnProperty.call(currentProfile, key)) {
      nextProfile[key] = currentProfile[key];
    }
  }
  for (key in updates) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      nextProfile[key] = updates[key];
    }
  }
  currentProfile = nextProfile;
  if (updates.lang) {
    setSTTLang(updates.lang);
  }
  payload.name = nextProfile.name;
  payload.lang = nextProfile.lang;
  payload.avatarColor = nextProfile.avatarColor;
  payload.avatarStyle = nextProfile.avatarStyle;
  payload.avatarSeed = nextProfile.avatarSeed;
  payload.avatarCustom = nextProfile.avatarCustom;
  fetch('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(function () {});
}

function avatarInitials(value) {
  var text = (value || '').trim();
  if (!text) return '?';
  var parts = text.split(/\s+/);
  var first = parts[0].charAt(0);
  var second = parts.length > 1 ? parts[1].charAt(0) : parts[0].charAt(1);
  var out = first + (second || '');
  return out.toUpperCase();
}

function getCurrentUserAvatarSrc(data) {
  var islandAvatar = document.querySelector('.user-island-avatar img');
  if (islandAvatar && islandAvatar.src) return islandAvatar.src;
  if (data && data.avatarCustom) return data.avatarCustom;
  return userAvatarUrl(data, 96);
}

function savePin(pin) {
  var pinInput = document.getElementById('us-pin-input');
  var pinConfirmInput = document.getElementById('us-pin-confirm-input');
  var pinCurrentInput = document.getElementById('us-pin-current-input');
  var pinSave = document.getElementById('us-pin-save');
  var pinMsg = document.getElementById('us-pin-msg');
  var currentPin = pinCurrentInput ? pinCurrentInput.value.trim() : '';
  var confirmPin = pinConfirmInput ? pinConfirmInput.value.trim() : '';
  var newPin = pinInput ? pinInput.value.trim() : '';

  if (!/^\d{6}$/.test(newPin)) {
    if (pinMsg) {
      pinMsg.textContent = 'PIN must be exactly 6 digits.';
      pinMsg.className = 'settings-hint settings-pin-error us-pin-msg-err';
      pinMsg.classList.remove('hidden');
    }
    return;
  }
  if (confirmPin !== newPin) {
    if (pinMsg) {
      pinMsg.textContent = 'PINs do not match.';
      pinMsg.className = 'settings-hint settings-pin-error us-pin-msg-err';
      pinMsg.classList.remove('hidden');
    }
    return;
  }
  if (pinEnabled && !/^\d{6}$/.test(currentPin)) {
    if (pinMsg) {
      pinMsg.textContent = 'Current PIN is required.';
      pinMsg.className = 'settings-hint settings-pin-error us-pin-msg-err';
      pinMsg.classList.remove('hidden');
    }
    return;
  }

  pinSave.disabled = true;
  pinSave.textContent = 'Saving\u2026';

  fetch('/api/user/pin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPin: currentPin, newPin: newPin }),
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (data.ok) {
      showToast('PIN changed');
      hidePinForm();
    } else {
      pinSave.disabled = false;
      pinSave.textContent = 'Save';
      if (pinMsg) {
        pinMsg.textContent = data.error || 'Could not change your PIN. Please try again.';
        pinMsg.className = 'settings-hint settings-pin-error us-pin-msg-err';
        pinMsg.classList.remove('hidden');
      }
    }
  }).catch(function () {
    pinSave.disabled = false;
    pinSave.textContent = 'Save';
    if (pinMsg) {
      pinMsg.textContent = 'Connection lost. Check your network and try again.';
      pinMsg.className = 'settings-hint settings-pin-error us-pin-msg-err';
      pinMsg.classList.remove('hidden');
    }
  });
}


function escHtml(str) {
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
