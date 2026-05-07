// User profile module — Discord-style popover for name, language, avatar
// Stores profile server-side in ~/.clay/profile.json
// Avatar generated via DiceBear API (deterministic SVG from seed)

import { iconHtml, refreshIcons } from './icons.js';
import { setSTTLang } from './stt.js';
import { avatarUrl, AVATAR_STYLES } from './avatar.js';
import { store } from './store.js';

var ctx;
var profile = { name: '', lang: 'en-US', avatarStyle: 'thumbs', avatarSeed: '', avatarColor: '#7c3aed', avatarCustom: '' };
var profileUsername = '';
var popoverEl = null;
var saveTimer = null;
var previewSeed = '';

// AVATAR_STYLES imported from avatar.js

var COLORS = [
  '#7c3aed', '#4f46e5', '#2563eb', '#0891b2',
  '#059669', '#65a30d', '#d97706', '#dc2626',
  '#db2777', '#6366f1', '#0d9488', '#ea580c',
  '#475569', '#1e293b', '#be123c', '#a21caf',
  '#0369a1', '#15803d',
];

// avatarUrl imported from avatar.js

function getAvatarSeed() {
  return profile.avatarSeed || 'anonymous';
}

// --- API ---
function fetchProfile() {
  return fetch('/api/profile').then(function(r) { return r.json(); });
}

function saveProfile() {
  return fetch('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  }).then(function(r) { return r.json(); });
}

export function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function() {
    saveProfile();
    saveTimer = null;
  }, 400);
}

// --- DOM updates ---
export function applyToIsland() {
  var avatarWrap = document.querySelector('.user-island-avatar');
  var nameEl = document.querySelector('.user-island-name');
  if (!avatarWrap || !nameEl) {
    requestAnimationFrame(applyToIsland);
    return;
  }

  var displayName = profile.name || 'Console User';

  // Replace letter fallback with avatar img
  var existingImg = avatarWrap.querySelector('img');
  var existingLetter = avatarWrap.querySelector('.user-island-avatar-letter');
  var url = profile.avatarCustom
    ? profile.avatarCustom
    : avatarUrl(profile.avatarStyle || 'thumbs', getAvatarSeed(), 32);

  if (existingImg) {
    existingImg.src = url;
  } else {
    if (existingLetter) existingLetter.style.display = 'none';
    var img = document.createElement('img');
    img.src = url;
    img.alt = displayName;
    avatarWrap.appendChild(img);
  }

  nameEl.textContent = displayName;

  // Show CTA if user hasn't personalized their name
  var ctaEl = document.querySelector('.user-island-cta');
  if (ctaEl) {
    var isDefault = profileUsername && profile.name === profileUsername;
    if (isDefault) {
      ctaEl.classList.remove('hidden');
    } else {
      ctaEl.classList.add('hidden');
    }
  }
}

// --- Avatar position picker ---
export function showAvatarPositioner(img, objectUrl, onDone) {
  var outputSize = 256;
  var viewSize = 220;

  // State
  var scale = 1;
  var offsetX = 0;
  var offsetY = 0;

  // Fit image so shorter side fills the circle
  var baseScale = Math.max(viewSize / img.width, viewSize / img.height);

  function clampOffsets() {
    var sw = img.width * baseScale * scale;
    var sh = img.height * baseScale * scale;
    var maxX = Math.max(0, (sw - viewSize) / 2);
    var maxY = Math.max(0, (sh - viewSize) / 2);
    if (offsetX > maxX) offsetX = maxX;
    if (offsetX < -maxX) offsetX = -maxX;
    if (offsetY > maxY) offsetY = maxY;
    if (offsetY < -maxY) offsetY = -maxY;
  }

  function updatePreview() {
    var s = baseScale * scale;
    var tx = (viewSize - img.width * s) / 2 + offsetX;
    var ty = (viewSize - img.height * s) / 2 + offsetY;
    previewImg.style.width = (img.width * s) + 'px';
    previewImg.style.height = (img.height * s) + 'px';
    previewImg.style.transform = 'translate(' + tx + 'px, ' + ty + 'px)';
  }

  // Build overlay
  var overlay = document.createElement('div');
  overlay.className = 'avatar-positioner-overlay';

  var container = document.createElement('div');
  container.className = 'avatar-positioner-container';

  var closeBtn = document.createElement('button');
  closeBtn.className = 'avatar-positioner-close';
  closeBtn.innerHTML = '&times;';
  container.appendChild(closeBtn);

  var title = document.createElement('div');
  title.className = 'avatar-positioner-title';
  title.textContent = 'Position your avatar';
  container.appendChild(title);

  var viewport = document.createElement('div');
  viewport.className = 'avatar-positioner-viewport';
  viewport.style.width = viewSize + 'px';
  viewport.style.height = viewSize + 'px';

  var previewImg = document.createElement('img');
  previewImg.src = objectUrl;
  previewImg.className = 'avatar-positioner-img';
  previewImg.draggable = false;
  viewport.appendChild(previewImg);
  container.appendChild(viewport);

  // Zoom slider
  var sliderWrap = document.createElement('div');
  sliderWrap.className = 'avatar-positioner-slider-wrap';
  var slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '1';
  slider.max = '6';
  slider.step = '0.05';
  slider.value = '1';
  slider.className = 'avatar-positioner-slider';
  sliderWrap.appendChild(slider);
  container.appendChild(sliderWrap);

  // Buttons
  var btnRow = document.createElement('div');
  btnRow.className = 'avatar-positioner-buttons';
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'avatar-positioner-btn avatar-positioner-btn-cancel';
  cancelBtn.textContent = 'Cancel';
  var doneBtn = document.createElement('button');
  doneBtn.className = 'avatar-positioner-btn avatar-positioner-btn-done';
  doneBtn.textContent = 'Done';
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(doneBtn);
  container.appendChild(btnRow);

  overlay.appendChild(container);
  document.body.appendChild(overlay);
  updatePreview();

  // Drag
  var dragging = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var startOffsetX = 0;
  var startOffsetY = 0;

  viewport.addEventListener('mousedown', startDrag);
  viewport.addEventListener('touchstart', startDrag, { passive: false });

  function startDrag(e) {
    e.preventDefault();
    dragging = true;
    var pt = e.touches ? e.touches[0] : e;
    dragStartX = pt.clientX;
    dragStartY = pt.clientY;
    startOffsetX = offsetX;
    startOffsetY = offsetY;
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);
    document.addEventListener('touchmove', onDrag, { passive: false });
    document.addEventListener('touchend', endDrag);
  }

  function onDrag(e) {
    if (!dragging) return;
    e.preventDefault();
    var pt = e.touches ? e.touches[0] : e;
    offsetX = startOffsetX + (pt.clientX - dragStartX);
    offsetY = startOffsetY + (pt.clientY - dragStartY);
    clampOffsets();
    updatePreview();
  }

  function endDrag() {
    dragging = false;
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', endDrag);
    document.removeEventListener('touchmove', onDrag);
    document.removeEventListener('touchend', endDrag);
  }

  // Zoom
  slider.addEventListener('input', function() {
    scale = parseFloat(slider.value);
    clampOffsets();
    updatePreview();
  });

  // Scroll to zoom
  viewport.addEventListener('wheel', function(e) {
    e.preventDefault();
    scale += e.deltaY < 0 ? 0.1 : -0.1;
    if (scale < 1) scale = 1;
    if (scale > 6) scale = 6;
    slider.value = scale;
    clampOffsets();
    updatePreview();
  }, { passive: false });

  function cleanup(revoke) {
    overlay.remove();
    if (revoke) URL.revokeObjectURL(objectUrl);
  }

  closeBtn.addEventListener('click', function() { cleanup(true); });
  cancelBtn.addEventListener('click', function() { cleanup(true); });

  doneBtn.addEventListener('click', function() {
    // Render cropped area to canvas
    var canvas = document.createElement('canvas');
    canvas.width = outputSize;
    canvas.height = outputSize;
    var c = canvas.getContext('2d');
    var s = baseScale * scale;
    var tx = (viewSize - img.width * s) / 2 + offsetX;
    var ty = (viewSize - img.height * s) / 2 + offsetY;
    // Map from viewSize coords to outputSize
    var ratio = outputSize / viewSize;
    c.drawImage(img,
      0, 0, img.width, img.height,
      tx * ratio, ty * ratio, img.width * s * ratio, img.height * s * ratio
    );
    canvas.toBlob(function(blob) {
      cleanup(false);
      if (blob) onDone(blob);
    }, 'image/jpeg', 0.9);
  });
}

// --- Popover ---
function showPopover() {
  if (popoverEl) {
    hidePopover();
    return;
  }

  popoverEl = document.createElement('div');
  popoverEl.className = 'profile-popover';

  var displayName = profile.name || '';
  var currentColor = profile.avatarColor || '#7c3aed';
  var currentStyle = profile.avatarStyle || 'thumbs';
  var seed = getAvatarSeed();
  previewSeed = seed;

  var html = '';

  // Banner + close
  html += '<div class="profile-banner" style="background:' + currentColor + '">';
  html += '<button class="profile-close-btn">&times;</button>';
  html += '</div>';

  // Avatar row (overlapping banner)
  html += '<div class="profile-avatar-row">';
  html += '<div class="profile-popover-avatar">';
  html += '<img class="profile-popover-avatar-img" src="' + (profile.avatarCustom || avatarUrl(currentStyle, seed, 80)) + '" alt="avatar">';
  html += '</div>';
  html += '<div class="profile-name-display">' + escapeAttr(displayName || 'Console User') + '</div>';
  html += '</div>';

  // Body
  html += '<div class="profile-popover-body">';

  // Name
  html += '<div class="profile-field">';
  html += '<label class="profile-field-label">Display Name</label>';
  html += '<input type="text" class="profile-field-input" id="profile-name-input" value="' + escapeAttr(displayName) + '" placeholder="Enter your name..." maxlength="50" spellcheck="false" autocomplete="off">';
  html += '</div>';

  // Avatar picker
  html += '<div class="profile-field">';
  html += '<label class="profile-field-label">Avatar <button class="profile-shuffle-btn" title="Shuffle">' + iconHtml('shuffle') + '</button></label>';
  html += '<div class="profile-avatar-grid">';
  // Upload button as first cell
  var uploadActive = profile.avatarCustom ? ' profile-avatar-option-active' : '';
  html += '<button class="profile-avatar-option profile-avatar-upload' + uploadActive + '" title="Upload photo">';
  if (profile.avatarCustom) {
    html += '<img src="' + profile.avatarCustom + '" alt="Custom" class="profile-avatar-custom-preview">';
  } else {
    html += '<span class="profile-avatar-upload-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>';
  }
  html += '</button>';
  html += '<input type="file" id="profile-avatar-file" accept="image/*" style="display:none">';
  for (var j = 0; j < AVATAR_STYLES.length; j++) {
    var st = AVATAR_STYLES[j];
    var activeS = (!profile.avatarCustom && currentStyle === st.id) ? ' profile-avatar-option-active' : '';
    html += '<button class="profile-avatar-option' + activeS + '" data-style="' + st.id + '" title="' + st.name + '">';
    html += '<img src="' + avatarUrl(st.id, seed, 40) + '" alt="' + st.name + '">';
    html += '</button>';
  }
  html += '</div>';
  html += '</div>';

  // Color
  html += '<div class="profile-field">';
  html += '<label class="profile-field-label">Color</label>';
  html += '<div class="profile-color-grid">';
  for (var k = 0; k < COLORS.length; k++) {
    var c = COLORS[k];
    var activeC = (currentColor === c) ? ' profile-color-active' : '';
    html += '<button class="profile-color-swatch' + activeC + '" data-color="' + c + '" style="background:' + c + '"></button>';
  }
  html += '</div>';
  html += '</div>';

  html += '</div>'; // close body

  popoverEl.innerHTML = html;

  // --- Events ---
  popoverEl.querySelector('.profile-close-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    hidePopover();
  });

  var nameInput = popoverEl.querySelector('#profile-name-input');
  nameInput.addEventListener('input', function() {
    profile.name = nameInput.value.trim();
    applyToIsland();
    updatePopoverHeader();
    debouncedSave();
  });

  nameInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      hidePopover();
    }
    e.stopPropagation();
  });
  nameInput.addEventListener('keyup', function(e) { e.stopPropagation(); });
  nameInput.addEventListener('keypress', function(e) { e.stopPropagation(); });

  // Avatar upload button
  var uploadBtn = popoverEl.querySelector('.profile-avatar-upload');
  var fileInput = popoverEl.querySelector('#profile-avatar-file');
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', function() {
      fileInput.click();
    });
    fileInput.addEventListener('change', function() {
      var file = fileInput.files[0];
      if (!file) return;

      function uploadBlob(blob) {
        blob.arrayBuffer().then(function(ab) {
          var buf = new Uint8Array(ab);
          fetch('/api/avatar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buf,
          }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.ok) {
              profile.avatarCustom = data.avatar;
              applyToIsland();
              updatePopoverHeader();
              if (popoverEl) {
                popoverEl.querySelectorAll('.profile-avatar-option').forEach(function(b) {
                  b.classList.remove('profile-avatar-option-active');
                });
              }
              if (uploadBtn) {
                uploadBtn.classList.add('profile-avatar-option-active');
                uploadBtn.innerHTML = '<img src="' + data.avatar + '" alt="Custom" class="profile-avatar-custom-preview">';
              }
              debouncedSave();
            }
          });
        });
      }

      // Load image and open position picker
      var img = new Image();
      var objectUrl = URL.createObjectURL(file);
      img.onload = function() {
        showAvatarPositioner(img, objectUrl, function(croppedBlob) {
          URL.revokeObjectURL(objectUrl);
          uploadBlob(croppedBlob);
        });
      };
      img.src = objectUrl;
    });
  }

  // Avatar style — clicking confirms both the style and the current previewSeed
  popoverEl.querySelectorAll('.profile-avatar-option[data-style]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      profile.avatarCustom = '';
      profile.avatarStyle = btn.dataset.style;
      profile.avatarSeed = previewSeed;
      applyToIsland();
      updatePopoverHeader();
      popoverEl.querySelectorAll('.profile-avatar-option').forEach(function(b) {
        b.classList.remove('profile-avatar-option-active');
      });
      btn.classList.add('profile-avatar-option-active');
      // Reset upload button to + icon
      var upBtn = popoverEl.querySelector('.profile-avatar-upload');
      if (upBtn) upBtn.innerHTML = '<span class="profile-avatar-upload-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>';
      debouncedSave();
    });
  });

  // Shuffle button — only changes preview candidates, not the actual profile
  popoverEl.querySelector('.profile-shuffle-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    previewSeed = Math.random().toString(36).substring(2, 10);
    refreshAvatarPreviews();
  });

  // Color swatches
  popoverEl.querySelectorAll('.profile-color-swatch').forEach(function(btn) {
    btn.addEventListener('click', function() {
      profile.avatarColor = btn.dataset.color;
      applyToIsland();
      var bannerEl = popoverEl.querySelector('.profile-banner');
      if (bannerEl) bannerEl.style.background = profile.avatarColor;
      popoverEl.querySelectorAll('.profile-color-swatch').forEach(function(b) {
        b.classList.remove('profile-color-active');
      });
      btn.classList.add('profile-color-active');
      debouncedSave();
    });
  });

  // Prevent clicks inside popover from closing it
  popoverEl.addEventListener('click', function(e) {
    e.stopPropagation();
  });

  var island = document.getElementById('user-island');
  island.appendChild(popoverEl);
  refreshIcons();

  if (!profile.name) {
    nameInput.focus();
  }

  setTimeout(function() {
    document.addEventListener('click', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
  }, 0);
}

function updatePopoverHeader() {
  if (!popoverEl) return;
  var img = popoverEl.querySelector('.profile-popover-avatar-img');
  var nd = popoverEl.querySelector('.profile-name-display');
  if (img) img.src = profile.avatarCustom
    ? profile.avatarCustom
    : avatarUrl(profile.avatarStyle || 'thumbs', getAvatarSeed(), 80);
  if (nd) nd.textContent = profile.name || 'Console User';
}


function refreshAvatarPreviews() {
  if (!popoverEl) return;
  popoverEl.querySelectorAll('.profile-avatar-option[data-style] img').forEach(function(img) {
    var style = img.closest('.profile-avatar-option').dataset.style;
    img.src = avatarUrl(style, previewSeed, 40);
  });
}

function closeOnOutside(e) {
  var island = document.getElementById('user-island');
  if (popoverEl && !popoverEl.contains(e.target) && !island.contains(e.target)) {
    hidePopover();
  }
}

function closeOnEscape(e) {
  if (e.key === 'Escape' && popoverEl) {
    hidePopover();
  }
}

function hidePopover() {
  if (popoverEl) {
    popoverEl.remove();
    popoverEl = null;
  }
  document.removeEventListener('click', closeOnOutside);
  document.removeEventListener('keydown', closeOnEscape);
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// --- Init ---
export function initProfile(_ctx) {
  ctx = _ctx;

  var island = document.getElementById('user-island');
  if (!island) return;

  var profileArea = island.querySelector('.user-island-profile');
  if (profileArea) {
    profileArea.addEventListener('click', function(e) {
      e.stopPropagation();
      showPopover();
    });
  }

  var ctaEl = island.querySelector('.user-island-cta');
  if (ctaEl) {
    ctaEl.addEventListener('click', function(e) {
      e.stopPropagation();
      showPopover();
    });
  }

  fetchProfile().then(function(data) {
    if (data.name !== undefined) profile.name = data.name;
    if (data.lang) profile.lang = data.lang;
    if (data.avatarColor) profile.avatarColor = data.avatarColor;
    if (data.avatarStyle) profile.avatarStyle = data.avatarStyle;
    if (data.avatarSeed) profile.avatarSeed = data.avatarSeed;
    if (data.avatarCustom) profile.avatarCustom = data.avatarCustom;
    if (data.username) profileUsername = data.username;

    // Auto-generate seed if none exists
    if (!profile.avatarSeed) {
      profile.avatarSeed = Math.random().toString(36).substring(2, 10);
      saveProfile();
    }

    applyToIsland();

    if (profile.lang) {
      setSTTLang(profile.lang);
    }

  }).catch(function(err) {
    console.warn('[Profile] Failed to load:', err);
  });
}

export function getProfile() {
  return profile;
}

export function getProfileLang() {
  return profile.lang;
}

