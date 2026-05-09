// sidebar-projects.js - Project icon strip, context menus, emoji picker, drag-and-drop, worktree modal
// Extracted from sidebar.js (PR-36)

import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { openProjectSettings } from './project-settings.js';
import { triggerShare } from './qrcode.js';
import { parseEmojis } from './markdown.js';
import { buildEmojiPicker } from './emoji-picker.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { closeSidebar } from './sidebar.js';
import { showIconTooltip, hideIconTooltip, closeUserCtxMenu, getCurrentDmUserId } from './sidebar-users.js';
import { switchProject, openAddProjectModal, getCachedProjects } from './app-projects.js';
import { openAgentPickerForPreferred } from './agent-picker.js';
import { showHomeHub } from './app-home-hub.js';

// --- Project state ---
var cachedProjectList = [];
var cachedCurrentSlug = null;

// --- Project context menu ---
var projectCtxMenu = null;

// --- Project Access Popover ---
var projectAccessPopover = null;

// --- Emoji picker ---
var emojiPickerEl = null;

// --- Drag-and-drop state ---
var draggedSlug = null;
var draggedEl = null;
var mergeTimer = null;       // timer for hover-to-merge
var mergePendingEl = null;   // target element awaiting merge
var draggedFolderName = null; // set when dragging a whole folder group

// --- Worktree folder collapse state (persisted in localStorage) ---
var wtCollapsed = {};
try {
  wtCollapsed = JSON.parse(localStorage.getItem("clay-wt-collapsed") || "{}");
} catch (e) {}

// --- User folder collapse state (separate key, rebrand-safe) ---
var folderCollapsed = {};
try {
  folderCollapsed = JSON.parse(localStorage.getItem("console-folder-collapsed") || "{}");
} catch (e) {}

function setFolderCollapsed(name, collapsed) {
  folderCollapsed[name] = collapsed;
  try { localStorage.setItem("console-folder-collapsed", JSON.stringify(folderCollapsed)); } catch (e) {}
}

// --- Cached folder meta (icons per folder name) ---
var cachedFolderMeta = {};

export function initSidebarProjects() {

  // Close project ctx menu and emoji picker on document click
  document.addEventListener("click", function () {
    closeProjectCtxMenu();
    closeEmojiPicker();
  });

  // Initialize icon strip buttons
  var addBtn = document.getElementById("icon-strip-add");
  if (addBtn) {
    addBtn.addEventListener("click", function () {
      if (openAddProjectModal) {
        openAddProjectModal();
      } else {
        var modal = document.getElementById("add-project-modal");
        if (modal) modal.classList.remove("hidden");
      }
    });
    addBtn.addEventListener("mouseenter", function () { showIconTooltip(addBtn, "Add project"); });
    addBtn.addEventListener("mouseleave", hideIconTooltip);
  }

  var exploreBtn = document.getElementById("icon-strip-explore");
  if (exploreBtn) {
    exploreBtn.addEventListener("click", function () {
      var fileBrowserBtn = document.getElementById("file-browser-btn");
      if (fileBrowserBtn) fileBrowserBtn.click();
    });
    exploreBtn.addEventListener("mouseenter", function () { showIconTooltip(exploreBtn, "File browser"); });
    exploreBtn.addEventListener("mouseleave", hideIconTooltip);
  }

  // Tooltip + click for home icon
  var homeIcon = document.querySelector(".icon-strip-home");
  if (homeIcon) {
    homeIcon.addEventListener("mouseenter", function () { showIconTooltip(homeIcon, "Clagentic:Console"); });
    homeIcon.addEventListener("mouseleave", hideIconTooltip);
    homeIcon.addEventListener("click", function (e) {
      e.preventDefault();
      if (showHomeHub) showHomeHub();
    });
    homeIcon.style.cursor = "pointer";
  }

  // Chevron dropdown on project name
  var dropdownBtn = document.getElementById("title-bar-project-dropdown");
  if (dropdownBtn) {
    dropdownBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var current = null;
      for (var i = 0; i < cachedProjectList.length; i++) {
        if (cachedProjectList[i].slug === cachedCurrentSlug) {
          current = cachedProjectList[i];
          break;
        }
      }
      if (!current) return;

      if (projectCtxMenu) {
        closeProjectCtxMenu();
        dropdownBtn.classList.remove("open");
        return;
      }
      dropdownBtn.classList.add("open");
      showProjectCtxMenu(dropdownBtn, current.slug, current.name, current.icon, "below");
      var observer = new MutationObserver(function () {
        if (!projectCtxMenu) {
          dropdownBtn.classList.remove("open");
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true });
    });
  }

  return {
    renderIconStrip: renderIconStrip,
    renderProjectList: renderProjectList,
    updateBadge: updateProjectBadge,
  };
}

// --- Getters for cached state (used by mobile sheet in sidebar.js) ---
export function getCachedProjectList() { return cachedProjectList; }
export function getCachedCurrentSlug() { return cachedCurrentSlug; }
export function getCachedFolderMeta() { return cachedFolderMeta; }
export function isFolderCollapsed(name) { return !!folderCollapsed[name]; }
export function toggleFolderCollapsed(name) {
  var nowCollapsed = !folderCollapsed[name];
  setFolderCollapsed(name, nowCollapsed);
  return nowCollapsed;
}
export { showProjectCtxMenu, showFolderCtxMenu, groupByFolders, groupProjects };

function getProjectAbbrev(name) {
  if (!name) return "?";
  var words = name.replace(/[^a-zA-Z0-9\s]/g, "").trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

export { getProjectAbbrev };

// --- Project Access Popover ---

function closeAccessOnOutside(e) {
  if (projectAccessPopover && !projectAccessPopover.contains(e.target)) closeProjectAccessPopover();
}
function closeAccessOnEscape(e) {
  if (e.key === "Escape") closeProjectAccessPopover();
}

function closeProjectAccessPopover() {
  if (projectAccessPopover) {
    projectAccessPopover.remove();
    projectAccessPopover = null;
    document.removeEventListener("click", closeAccessOnOutside);
    document.removeEventListener("keydown", closeAccessOnEscape);
  }
}

function showProjectAccessPopover(anchorEl, slug) {
  closeProjectAccessPopover();

  var popover = document.createElement("div");
  popover.className = "project-access-popover";
  popover.innerHTML = '<div class="project-access-loading">Loading...</div>';
  popover.addEventListener("click", function (e) { e.stopPropagation(); });
  document.body.appendChild(popover);
  projectAccessPopover = popover;

  requestAnimationFrame(function () {
    var rect = anchorEl.getBoundingClientRect();
    popover.style.position = "fixed";
    popover.style.left = (rect.right + 8) + "px";
    popover.style.top = rect.top + "px";
    popover.style.zIndex = "9999";
    var popRect = popover.getBoundingClientRect();
    if (popRect.right > window.innerWidth - 8) {
      popover.style.left = (rect.left - popRect.width - 8) + "px";
    }
    if (popRect.bottom > window.innerHeight - 8) {
      popover.style.top = (window.innerHeight - popRect.height - 8) + "px";
    }
  });

  setTimeout(function () {
    document.addEventListener("click", closeAccessOnOutside);
    document.addEventListener("keydown", closeAccessOnEscape);
  }, 0);

  Promise.all([
    fetch("/api/admin/projects/" + encodeURIComponent(slug) + "/access").then(function (r) { return r.json(); }),
    fetch("/api/admin/users").then(function (r) { return r.json(); }),
  ]).then(function (results) {
    var access = results[0];
    var usersData = results[1];
    if (access.error || usersData.error) {
      popover.innerHTML = '<div class="project-access-loading">Failed to load</div>';
      return;
    }
    renderAccessPopover(popover, slug, access, usersData.users || []);
  }).catch(function () {
    popover.innerHTML = '<div class="project-access-loading">Failed to load</div>';
  });
}

function renderAccessPopover(popover, slug, access, allUsers) {
  var visibility = access.visibility || "public";
  var allowedUsers = access.allowedUsers || [];
  var ownerId = access.ownerId;

  var selectableUsers = allUsers.filter(function (u) { return u.id !== ownerId; });

  var html = '';
  html += '<div class="project-access-header">';
  html += '<span class="project-access-title">Project Access</span>';
  html += '<button class="project-access-close">&times;</button>';
  html += '</div>';

  html += '<div class="project-access-section">';
  html += '<label class="project-access-label">Visibility</label>';
  html += '<div class="project-access-vis-row">';
  html += '<button class="project-access-vis-btn' + (visibility === "private" ? ' active' : '') + '" data-vis="private">';
  html += iconHtml("lock") + ' Private';
  html += '</button>';
  html += '<button class="project-access-vis-btn' + (visibility === "public" ? ' active' : '') + '" data-vis="public">';
  html += iconHtml("globe") + ' Public';
  html += '</button>';
  html += '</div>';
  html += '</div>';

  html += '<div class="project-access-section project-access-users-section"' + (visibility !== "private" ? ' style="display:none"' : '') + '>';
  html += '<label class="project-access-label">Allowed Users</label>';
  html += '<div class="project-access-user-list">';
  for (var i = 0; i < selectableUsers.length; i++) {
    var u = selectableUsers[i];
    var checked = allowedUsers.indexOf(u.id) !== -1 ? " checked" : "";
    html += '<label class="project-access-user-item">';
    html += '<input type="checkbox" data-uid="' + u.id + '"' + checked + '>';
    html += '<span>' + escapeHtml(u.displayName || u.username || u.id) + '</span>';
    html += '</label>';
  }
  if (selectableUsers.length === 0) {
    html += '<div class="project-access-empty">No other users</div>';
  }
  html += '</div>';
  html += '</div>';

  popover.innerHTML = html;
  refreshIcons();

  popover.querySelector(".project-access-close").addEventListener("click", function () {
    closeProjectAccessPopover();
  });

  popover.querySelectorAll(".project-access-vis-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var newVis = btn.dataset.vis;
      popover.querySelectorAll(".project-access-vis-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      var usersSection = popover.querySelector(".project-access-users-section");
      if (usersSection) usersSection.style.display = newVis === "private" ? "" : "none";
      fetch("/api/admin/projects/" + encodeURIComponent(slug) + "/visibility", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: newVis }),
      });
    });
  });

  popover.querySelectorAll('.project-access-user-item input[type="checkbox"]').forEach(function (cb) {
    cb.addEventListener("change", function () {
      var selected = [];
      popover.querySelectorAll('.project-access-user-item input[type="checkbox"]:checked').forEach(function (c) {
        selected.push(c.dataset.uid);
      });
      fetch("/api/admin/projects/" + encodeURIComponent(slug) + "/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedUsers: selected }),
      });
    });
  });
}

// --- Project context menu ---

export function closeProjectCtxMenu() {
  if (projectCtxMenu) {
    projectCtxMenu.remove();
    projectCtxMenu = null;
  }
}

function showIconCtxMenu(anchorEl, slug, name) {
  closeProjectCtxMenu();
  if (closeUserCtxMenu) closeUserCtxMenu();
  closeEmojiPicker();

  var menu = document.createElement("div");
  menu.className = "project-ctx-menu";

  var isWorktree = slug.indexOf("--") !== -1;

  var iconItem = document.createElement("button");
  iconItem.className = "project-ctx-item";
  iconItem.innerHTML = iconHtml("smile") + " <span>Set Icon</span>";
  iconItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeProjectCtxMenu();
    showEmojiPicker(slug, anchorEl);
  });
  menu.appendChild(iconItem);

  if (isWorktree) {
    var removeWtItem = document.createElement("button");
    removeWtItem.className = "project-ctx-item project-ctx-delete";
    removeWtItem.innerHTML = iconHtml("trash-2") + " <span>Remove Worktree</span>";
    removeWtItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeProjectCtxMenu();
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "remove_project_check", slug: slug, name: name || slug }));
      }
    });
    menu.appendChild(removeWtItem);
  } else {
    var wtItem = document.createElement("button");
    wtItem.className = "project-ctx-item";
    wtItem.innerHTML = iconHtml("git-branch") + " <span>Add Worktree</span>";
    wtItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeProjectCtxMenu();
      showWorktreeModal(slug, name || slug);
    });
    menu.appendChild(wtItem);
  }

  document.body.appendChild(menu);
  projectCtxMenu = menu;
  refreshIcons();

  requestAnimationFrame(function () {
    var rect = anchorEl.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.left = (rect.right + 6) + "px";
    menu.style.top = rect.top + "px";
    var menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 8) {
      menu.style.left = (rect.left - menuRect.width - 6) + "px";
    }
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = (window.innerHeight - menuRect.height - 8) + "px";
    }
  });
}

function showProjectCtxMenu(anchorEl, slug, name, icon, position) {
  closeProjectCtxMenu();
  if (closeUserCtxMenu) closeUserCtxMenu();
  closeEmojiPicker();

  var menu = document.createElement("div");
  menu.className = "project-ctx-menu";

  // --- Set Icon ---
  var iconItem = document.createElement("button");
  iconItem.className = "project-ctx-item";
  iconItem.innerHTML = iconHtml("smile") + " <span>Set Icon</span>";
  iconItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeProjectCtxMenu();
    showEmojiPicker(slug, anchorEl);
  });
  menu.appendChild(iconItem);

  // --- Project Settings ---
  if (!store.get('permissions') || store.get('permissions').projectSettings !== false) {
    var settingsItem = document.createElement("button");
    settingsItem.className = "project-ctx-item";
    settingsItem.innerHTML = iconHtml("settings") + " <span>Project Settings</span>";
    settingsItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeProjectCtxMenu();
      openProjectSettings(slug, { slug: slug, name: name, icon: icon, projectOwnerId: store.get('currentProjectOwnerId'), ownerLocked: store.get('ownerLocked') });
    });
    menu.appendChild(settingsItem);
  }

  // --- Preferred agent ---
  if (!store.get('dmMode') && slug.indexOf("--") === -1) {
    var currentPreferred = null;
    var allProjs = getCachedProjects();
    for (var cpi = 0; cpi < allProjs.length; cpi++) {
      if (allProjs[cpi].slug === slug) { currentPreferred = allProjs[cpi].preferredAgent || null; break; }
    }
    var prefAgentItem = document.createElement("button");
    prefAgentItem.className = "project-ctx-item";
    prefAgentItem.innerHTML = iconHtml("bot") + " <span>" + (currentPreferred ? "Change preferred agent" : "Set preferred agent") + "</span>";
    prefAgentItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeProjectCtxMenu();
      openAgentPickerForPreferred(slug);
    });
    menu.appendChild(prefAgentItem);
    if (currentPreferred) {
      var clearPrefItem = document.createElement("button");
      clearPrefItem.className = "project-ctx-item";
      clearPrefItem.innerHTML = iconHtml("x-circle") + " <span>Clear preferred agent</span>";
      clearPrefItem.addEventListener("click", function (e) {
        e.stopPropagation();
        closeProjectCtxMenu();
        var ws = getWs();
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "set_project_preferred_agent", slug: slug, agent: null }));
        }
      });
      menu.appendChild(clearPrefItem);
    }
  }

  var sep1 = document.createElement("div");
  sep1.className = "project-ctx-separator";
  menu.appendChild(sep1);

  // --- Share ---
  var shareItem = document.createElement("button");
  shareItem.className = "project-ctx-item";
  shareItem.innerHTML = iconHtml("share") + " <span>Share</span>";
  shareItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeProjectCtxMenu();
    triggerShare();
  });
  menu.appendChild(shareItem);

  // --- Manage Access ---
  if (store.get('isMultiUserMode') && slug.indexOf("--") === -1) {
    var isProjectOwner = store.get('myUserId') && store.get('currentProjectOwnerId') && store.get('myUserId') === store.get('currentProjectOwnerId');
    var isAdmin = store.get('permissions') && store.get('permissions').projectSettings !== false;
    if (isProjectOwner || isAdmin) {
      var accessItem = document.createElement("button");
      accessItem.className = "project-ctx-item";
      accessItem.innerHTML = iconHtml("users") + " <span>Manage Access</span>";
      accessItem.addEventListener("click", function (e) {
        e.stopPropagation();
        closeProjectCtxMenu();
        showProjectAccessPopover(anchorEl, slug);
      });
      menu.appendChild(accessItem);
    }
  }

  var sep2 = document.createElement("div");
  sep2.className = "project-ctx-separator";
  menu.appendChild(sep2);

  // --- Folder management ---
  var currentFolder = null;
  for (var cfi = 0; cfi < cachedProjectList.length; cfi++) {
    if (cachedProjectList[cfi].slug === slug) { currentFolder = cachedProjectList[cfi].folderName || null; break; }
  }

  if (currentFolder) {
    // Remove from folder
    var rmFolderItem = document.createElement("button");
    rmFolderItem.className = "project-ctx-item";
    rmFolderItem.innerHTML = iconHtml("folder-minus") + " <span>Remove from folder</span>";
    (function (s) {
      rmFolderItem.addEventListener("click", function (e) {
        e.stopPropagation();
        closeProjectCtxMenu();
        var ws = getWs();
        if (ws && store.get('connected')) {
          ws.send(JSON.stringify({ type: "set_project_folder", slug: s, folderName: null }));
        }
      });
    })(slug);
    menu.appendChild(rmFolderItem);
  }

  // Move to folder (shows existing folders)
  var existingFolders = [];
  for (var efi = 0; efi < cachedProjectList.length; efi++) {
    var fn = cachedProjectList[efi].folderName || null;
    if (fn && fn !== currentFolder && existingFolders.indexOf(fn) === -1) existingFolders.push(fn);
  }
  if (existingFolders.length > 0) {
    var moveFolderItem = document.createElement("button");
    moveFolderItem.className = "project-ctx-item";
    moveFolderItem.innerHTML = iconHtml("folder-input") + " <span>Move to folder ▶</span>";
    (function (s, folders) {
      moveFolderItem.addEventListener("click", function (e) {
        e.stopPropagation();
        closeProjectCtxMenu();
        showMoveFolderMenu(anchorEl, s, folders, position);
      });
    })(slug, existingFolders.slice());
    menu.appendChild(moveFolderItem);
  }

  var newFolderItem = document.createElement("button");
  newFolderItem.className = "project-ctx-item";
  newFolderItem.innerHTML = iconHtml("folder-plus") + " <span>New folder with this</span>";
  (function (s) {
    newFolderItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeProjectCtxMenu();
      var names = [];
      for (var ni = 0; ni < cachedProjectList.length; ni++) {
        if (cachedProjectList[ni].folderName && names.indexOf(cachedProjectList[ni].folderName) === -1) {
          names.push(cachedProjectList[ni].folderName);
        }
      }
      var newName = generateFolderName(names);
      var ws = getWs();
      if (ws && store.get('connected')) {
        ws.send(JSON.stringify({ type: "set_project_folder", slug: s, folderName: newName }));
      }
      setTimeout(function () { triggerFolderRename(newName); }, 300);
    });
  })(slug);
  menu.appendChild(newFolderItem);

  var sepFolder = document.createElement("div");
  sepFolder.className = "project-ctx-separator";
  menu.appendChild(sepFolder);

  // --- Add Worktree ---
  var wtItem = document.createElement("button");
  wtItem.className = "project-ctx-item";
  wtItem.innerHTML = iconHtml("git-branch") + " <span>Add Worktree</span>";
  wtItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeProjectCtxMenu();
    showWorktreeModal(slug, name || slug);
  });
  menu.appendChild(wtItem);

  if (!store.get('permissions') || store.get('permissions').deleteProject !== false) {
    var sep3 = document.createElement("div");
    sep3.className = "project-ctx-separator";
    menu.appendChild(sep3);

    var deleteItem = document.createElement("button");
    deleteItem.className = "project-ctx-item project-ctx-delete";
    deleteItem.innerHTML = iconHtml("trash-2") + " <span>Remove Project</span>";
    deleteItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeProjectCtxMenu();
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "remove_project_check", slug: slug, name: name }));
      }
    });
    menu.appendChild(deleteItem);
  }

  document.body.appendChild(menu);
  projectCtxMenu = menu;
  refreshIcons();

  requestAnimationFrame(function () {
    var rect = anchorEl.getBoundingClientRect();
    menu.style.position = "fixed";
    if (position === "below") {
      menu.style.left = rect.left + "px";
      menu.style.top = (rect.bottom + 4) + "px";
    } else {
      menu.style.left = (rect.right + 6) + "px";
      menu.style.top = rect.top + "px";
    }
    var menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 8) {
      menu.style.left = (rect.left - menuRect.width - 6) + "px";
    }
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = (window.innerHeight - menuRect.height - 8) + "px";
    }
  });
}

// --- Emoji picker ---

function closeEmojiPicker() {
  if (emojiPickerEl) {
    emojiPickerEl.remove();
    emojiPickerEl = null;
  }
}

function showEmojiPicker(slug, anchorEl) {
  closeEmojiPicker();

  var picker = buildEmojiPicker({
    onSelect: function (emoji) {
      closeEmojiPicker();
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "set_project_icon", slug: slug, icon: emoji }));
      }
    },
    onRemove: function () {
      closeEmojiPicker();
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "set_project_icon", slug: slug, icon: null }));
      }
    },
  });

  document.body.appendChild(picker);
  emojiPickerEl = picker;

  requestAnimationFrame(function () {
    var rect = anchorEl.getBoundingClientRect();
    picker.style.left = (rect.right + 6) + "px";
    picker.style.top = rect.top + "px";
    var pRect = picker.getBoundingClientRect();
    if (pRect.right > window.innerWidth - 8) {
      picker.style.left = (rect.left - pRect.width - 6) + "px";
    }
    if (pRect.bottom > window.innerHeight - 8) {
      picker.style.top = (window.innerHeight - pRect.height - 8) + "px";
    }
  });
}

// --- Folder emoji picker ---
function showFolderEmojiPicker(folderName, anchorEl) {
  closeEmojiPicker();

  var picker = buildEmojiPicker({
    onSelect: function (emoji) {
      closeEmojiPicker();
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "set_folder_icon", folderName: folderName, icon: emoji }));
      }
    },
    onRemove: function () {
      closeEmojiPicker();
      if (getWs() && store.get('connected')) {
        getWs().send(JSON.stringify({ type: "set_folder_icon", folderName: folderName, icon: null }));
      }
    },
  });

  document.body.appendChild(picker);
  emojiPickerEl = picker;

  requestAnimationFrame(function () {
    var rect = anchorEl.getBoundingClientRect();
    picker.style.left = (rect.right + 6) + "px";
    picker.style.top = rect.top + "px";
    var pRect = picker.getBoundingClientRect();
    if (pRect.right > window.innerWidth - 8) {
      picker.style.left = (rect.left - pRect.width - 6) + "px";
    }
    if (pRect.bottom > window.innerHeight - 8) {
      picker.style.top = (window.innerHeight - pRect.height - 8) + "px";
    }
  });
}

// --- Folder context menu ---
function showFolderCtxMenu(anchorEl, folderName) {
  closeProjectCtxMenu();
  closeEmojiPicker();

  var menu = document.createElement("div");
  menu.className = "project-ctx-menu";

  var iconItem = document.createElement("button");
  iconItem.className = "project-ctx-item";
  iconItem.innerHTML = iconHtml("smile") + " <span>Set Folder Icon</span>";
  iconItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeProjectCtxMenu();
    showFolderEmojiPicker(folderName, anchorEl);
  });
  menu.appendChild(iconItem);

  var renameItem = document.createElement("button");
  renameItem.className = "project-ctx-item";
  renameItem.innerHTML = iconHtml("pencil") + " <span>Rename Folder</span>";
  renameItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeProjectCtxMenu();
    triggerFolderRename(folderName);
  });
  menu.appendChild(renameItem);

  var sep = document.createElement("div");
  sep.className = "project-ctx-separator";
  menu.appendChild(sep);

  var dissolveItem = document.createElement("button");
  dissolveItem.className = "project-ctx-item project-ctx-delete";
  dissolveItem.innerHTML = iconHtml("folder-x") + " <span>Dissolve Folder</span>";
  dissolveItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeProjectCtxMenu();
    // Remove folder from all projects in it
    var ws = getWs();
    if (ws && store.get('connected')) {
      for (var di = 0; di < cachedProjectList.length; di++) {
        if (cachedProjectList[di].folderName === folderName) {
          ws.send(JSON.stringify({ type: "set_project_folder", slug: cachedProjectList[di].slug, folderName: null }));
        }
      }
    }
  });
  menu.appendChild(dissolveItem);

  document.body.appendChild(menu);
  projectCtxMenu = menu;
  refreshIcons();

  requestAnimationFrame(function () {
    var rect = anchorEl.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.left = (rect.right + 6) + "px";
    menu.style.top = rect.top + "px";
    var menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 8) {
      menu.style.left = (rect.left - menuRect.width - 6) + "px";
    }
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = (window.innerHeight - menuRect.height - 8) + "px";
    }
  });
}

// --- Move to folder submenu ---
function showMoveFolderMenu(anchorEl, slug, folders, position) {
  closeProjectCtxMenu();
  var menu = document.createElement("div");
  menu.className = "project-ctx-menu";

  for (var i = 0; i < folders.length; i++) {
    (function (fn) {
      var item = document.createElement("button");
      item.className = "project-ctx-item";
      var fmeta2 = cachedFolderMeta[fn] || {};
      var ficon = fmeta2.icon ? ('<span style="margin-right:4px">' + fmeta2.icon + '</span>') : (iconHtml("folder") + " ");
      item.innerHTML = ficon + "<span>" + escapeHtml(fn) + "</span>";
      item.addEventListener("click", function (e) {
        e.stopPropagation();
        closeProjectCtxMenu();
        var ws = getWs();
        if (ws && store.get('connected')) {
          ws.send(JSON.stringify({ type: "set_project_folder", slug: slug, folderName: fn }));
        }
      });
      menu.appendChild(item);
    })(folders[i]);
  }

  document.body.appendChild(menu);
  projectCtxMenu = menu;
  refreshIcons();

  requestAnimationFrame(function () {
    var rect = anchorEl.getBoundingClientRect();
    menu.style.position = "fixed";
    if (position === "below") {
      menu.style.left = rect.left + "px";
      menu.style.top = (rect.bottom + 4) + "px";
    } else {
      menu.style.left = (rect.right + 6) + "px";
      menu.style.top = rect.top + "px";
    }
    var menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 8) menu.style.left = (rect.left - menuRect.width - 6) + "px";
    if (menuRect.bottom > window.innerHeight - 8) menu.style.top = (window.innerHeight - menuRect.height - 8) + "px";
  });
}

// --- Folder inline rename ---
function startFolderInlineRename(folderName, labelEl) {
  if (!labelEl) return;
  var original = labelEl.textContent;
  labelEl.contentEditable = "true";
  labelEl.focus();
  // Select all
  var range = document.createRange();
  range.selectNodeContents(labelEl);
  var sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }

  var committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    labelEl.contentEditable = "false";
    var newName = (labelEl.textContent || "").trim();
    if (!newName) { labelEl.textContent = original; return; }
    if (newName === folderName) return;
    var ws = getWs();
    if (ws && store.get('connected')) {
      ws.send(JSON.stringify({ type: "rename_project_folder", oldName: folderName, newName: newName }));
    }
  }
  function cancel() {
    if (committed) return;
    committed = true;
    labelEl.contentEditable = "false";
    labelEl.textContent = original;
  }
  labelEl.addEventListener("blur", commit, { once: true });
  labelEl.addEventListener("keydown", function (e) {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  labelEl.addEventListener("click", function (e) { e.stopPropagation(); });
}

// --- Rename prompt ---
function showProjectRename(slug, currentName) {
  var nameEl = document.getElementById("title-bar-project-name");
  if (!nameEl) return;

  var input = document.createElement("input");
  input.type = "text";
  input.className = "project-rename-input";
  input.value = currentName || "";

  var originalText = nameEl.textContent;
  nameEl.textContent = "";
  nameEl.appendChild(input);
  input.focus();
  input.select();

  var committed = false;

  function commitRename() {
    if (committed) return;
    committed = true;
    var newName = input.value.trim();
    if (newName && newName !== currentName && getWs() && store.get('connected')) {
      getWs().send(JSON.stringify({ type: "set_project_title", slug: slug, title: newName }));
      nameEl.textContent = newName;
    } else {
      nameEl.textContent = originalText;
    }
  }

  input.addEventListener("keydown", function (e) {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    if (e.key === "Escape") { e.preventDefault(); committed = true; nameEl.textContent = originalText; }
  });
  input.addEventListener("blur", commitRename);
  input.addEventListener("click", function (e) { e.stopPropagation(); });
}

// --- Drag-and-drop ---

function showTrashZone() {
  var addBtn = document.getElementById("icon-strip-add");
  if (!addBtn) return;
  addBtn.style.display = "none";

  var existing = document.getElementById("icon-strip-trash");
  if (existing) existing.remove();

  var trash = document.createElement("div");
  trash.id = "icon-strip-trash";
  trash.className = "icon-strip-trash";
  trash.innerHTML = iconHtml("trash-2");
  addBtn.parentNode.insertBefore(trash, addBtn.nextSibling);
  refreshIcons();

  trash.addEventListener("mouseenter", function () { showIconTooltip(trash, "Remove project"); });
  trash.addEventListener("mouseleave", hideIconTooltip);

  trash.addEventListener("dragover", function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    trash.classList.add("drag-hover");
  });
  trash.addEventListener("dragleave", function () {
    trash.classList.remove("drag-hover");
  });
  trash.addEventListener("drop", function (e) {
    e.preventDefault();
    trash.classList.remove("drag-hover");
    var slug = e.dataTransfer.getData("text/plain");
    if (slug && getWs() && store.get('connected')) {
      getWs().send(JSON.stringify({ type: "remove_project_check", slug: slug }));
    }
  });
}

function hideTrashZone() {
  var trash = document.getElementById("icon-strip-trash");
  if (trash) trash.remove();
  var addBtn = document.getElementById("icon-strip-add");
  if (addBtn) addBtn.style.display = "";
}

function clearDragIndicators() {
  var items = document.querySelectorAll(".icon-strip-item.drag-over-above, .icon-strip-item.drag-over-below");
  for (var i = 0; i < items.length; i++) {
    items[i].classList.remove("drag-over-above", "drag-over-below");
  }
}

function setupDragHandlers(el, slug) {
  el.setAttribute("draggable", "true");

  el.addEventListener("dragstart", function (e) {
    draggedSlug = slug;
    draggedEl = el;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", slug);

    var ghost = document.createElement("div");
    ghost.textContent = el.textContent.trim().split("\n")[0];
    ghost.style.cssText = "position:fixed;left:-200px;top:-200px;width:38px;height:38px;border-radius:12px;" +
      "background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;" +
      "font-size:15px;font-weight:600;pointer-events:none;z-index:-1;";
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 19, 19);
    setTimeout(function () { ghost.remove(); }, 0);

    setTimeout(function () { el.classList.add("dragging"); }, 0);
    hideIconTooltip();
    showTrashZone();
  });

  el.addEventListener("dragover", function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    // A whole folder is being dragged — show above/below only, no merge
    if (draggedFolderName) {
      var rect0 = el.getBoundingClientRect();
      var pct0 = (e.clientY - rect0.top) / rect0.height;
      clearFolderDragIndicators();
      clearDragIndicators();
      if (pct0 < 0.5) {
        el.classList.add("drag-over-above");
      } else {
        el.classList.add("drag-over-below");
      }
      return;
    }

    if (!draggedSlug || draggedSlug === slug) return;

    var rect = el.getBoundingClientRect();
    var relY = e.clientY - rect.top;
    var pct = relY / rect.height;

    // Suppress merge zone entirely for items inside a folder:
    // - target is already in a folder (in-folder class): only reorder within folder
    // - dragged item is in the same folder as target: only reorder, no new folder
    var targetInFolder = el.classList.contains("in-folder");
    var draggedInSameFolder = false;
    if (targetInFolder) {
      var targetFolderName = null;
      for (var dci = 0; dci < cachedProjectList.length; dci++) {
        if (cachedProjectList[dci].slug === slug) { targetFolderName = cachedProjectList[dci].folderName || null; break; }
      }
      for (var ddci = 0; ddci < cachedProjectList.length; ddci++) {
        if (cachedProjectList[ddci].slug === draggedSlug) {
          if (cachedProjectList[ddci].folderName === targetFolderName) draggedInSameFolder = true;
          break;
        }
      }
    }
    var allowMerge = !targetInFolder || !draggedInSameFolder;

    var zone = (allowMerge && pct >= 0.25 && pct <= 0.75) ? "merge"
             : pct < 0.5 ? "above" : "below";

    if (zone === "merge") {
      // Start merge timer if not already pending on this element
      if (mergePendingEl !== el) {
        clearMergeTimer();
        mergePendingEl = el;
        el.classList.add("drag-over-merge");
        clearDragIndicators();
        mergeTimer = setTimeout(function () {
          // Timer elapsed — keep merge state active, drop will handle it
          mergeTimer = null;
        }, 500);
      }
    } else {
      if (mergePendingEl === el) clearMergeTimer();
      clearDragIndicators();
      if (zone === "above") {
        el.classList.add("drag-over-above");
      } else {
        el.classList.add("drag-over-below");
      }
    }
  });

  el.addEventListener("dragleave", function (e) {
    // Ignore leaves that go to a child element — those are internal transitions
    // and would falsely cancel the merge/reorder state mid-hover.
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    if (mergePendingEl === el) clearMergeTimer();
    el.classList.remove("drag-over-above", "drag-over-below", "drag-over-merge");
  });

  el.addEventListener("drop", function (e) {
    e.preventDefault();

    // Folder reorder: whole folder dropped onto a standalone project item
    if (draggedFolderName) {
      var insertAfterItem = e.clientY >= el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2;
      clearDragIndicators();
      clearFolderDragIndicators();
      reorderWithFolder(draggedFolderName, slug, insertAfterItem);
      return;
    }

    var wasMerge = el.classList.contains("drag-over-merge");
    clearDragIndicators();
    if (mergePendingEl === el) clearMergeTimer();
    if (!draggedSlug || draggedSlug === slug) return;

    if (wasMerge) {
      // Merge: put both projects in a folder
      var targetProject = null;
      var draggedProject = null;
      for (var mi = 0; mi < cachedProjectList.length; mi++) {
        if (cachedProjectList[mi].slug === slug) targetProject = cachedProjectList[mi];
        if (cachedProjectList[mi].slug === draggedSlug) draggedProject = cachedProjectList[mi];
      }
      if (!targetProject || !draggedProject) return;

      // If target already has a folder, add dragged to it
      var targetFolder = targetProject.folderName || null;
      if (targetFolder) {
        if (getWs() && store.get('connected')) {
          getWs().send(JSON.stringify({ type: "set_project_folder", slug: draggedSlug, folderName: targetFolder }));
        }
      } else {
        // Create a new folder for both
        var existingFolderNames = [];
        for (var ei = 0; ei < cachedProjectList.length; ei++) {
          if (cachedProjectList[ei].folderName && existingFolderNames.indexOf(cachedProjectList[ei].folderName) === -1) {
            existingFolderNames.push(cachedProjectList[ei].folderName);
          }
        }
        var newFolderName = generateFolderName(existingFolderNames);
        var ws = getWs();
        if (ws && store.get('connected')) {
          ws.send(JSON.stringify({ type: "set_project_folder", slug: slug, folderName: newFolderName }));
          ws.send(JSON.stringify({ type: "set_project_folder", slug: draggedSlug, folderName: newFolderName }));
        }
        // Trigger inline rename after a tick (folder will render after WS round-trip)
        setTimeout(function () { triggerFolderRename(newFolderName); }, 300);
      }
      return;
    }

    // Reorder (above/below)
    var rect = el.getBoundingClientRect();
    var midY = rect.top + rect.height / 2;
    var insertBefore = e.clientY < midY;

    // Detect folder exit: dragged item is in a folder but target item is not
    // (or is in a different folder). Strip the folder membership first.
    var draggedFolderName = null;
    for (var dfi = 0; dfi < cachedProjectList.length; dfi++) {
      if (cachedProjectList[dfi].slug === draggedSlug) {
        draggedFolderName = cachedProjectList[dfi].folderName || null;
        break;
      }
    }
    var targetFolderName2 = null;
    for (var tfi = 0; tfi < cachedProjectList.length; tfi++) {
      if (cachedProjectList[tfi].slug === slug) {
        targetFolderName2 = cachedProjectList[tfi].folderName || null;
        break;
      }
    }
    var ws2 = getWs();
    if (draggedFolderName && draggedFolderName !== targetFolderName2) {
      // Leaving a folder — clear folder membership before reordering
      if (ws2 && store.get('connected')) {
        ws2.send(JSON.stringify({ type: "set_project_folder", slug: draggedSlug, folderName: null }));
      }
    }

    var container = document.getElementById("icon-strip-projects");
    var items = container.querySelectorAll(".icon-strip-item");
    var slugs = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].dataset.slug !== draggedSlug) {
        slugs.push(items[i].dataset.slug);
      }
    }
    var targetIdx = slugs.indexOf(slug);
    if (!insertBefore) targetIdx++;
    slugs.splice(targetIdx, 0, draggedSlug);

    if (ws2 && store.get('connected')) {
      ws2.send(JSON.stringify({ type: "reorder_projects", slugs: slugs }));
    }
  });

  el.addEventListener("dragend", function () {
    el.classList.remove("dragging");
    clearDragIndicators();
    clearFolderDragIndicators();
    clearMergeTimer();
    draggedSlug = null;
    draggedEl = null;
    hideTrashZone();
  });
}

function clearMergeTimer() {
  if (mergeTimer) { clearTimeout(mergeTimer); mergeTimer = null; }
  if (mergePendingEl) {
    mergePendingEl.classList.remove("drag-over-merge");
    mergePendingEl = null;
  }
}

function clearFolderDragIndicators() {
  var els = document.querySelectorAll(".icon-strip-folder-header.drag-over-above, .icon-strip-folder-header.drag-over-below");
  for (var i = 0; i < els.length; i++) {
    els[i].classList.remove("drag-over-above", "drag-over-below");
  }
}

// Drag handlers for a folder group (dragging the whole folder to reorder)
function setupFolderDragHandlers(headerEl, folderEl, folderName, folderProjects) {
  headerEl.setAttribute("draggable", "true");

  headerEl.addEventListener("dragstart", function (e) {
    // Only treat as folder drag if click started on the header itself (not a child button)
    draggedFolderName = folderName;
    draggedEl = folderEl;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "folder:" + folderName);

    var ghost = document.createElement("div");
    ghost.textContent = folderName;
    ghost.style.cssText = "position:fixed;left:-200px;top:-200px;width:38px;height:38px;border-radius:12px;" +
      "background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;" +
      "font-size:13px;font-weight:600;pointer-events:none;z-index:-1;";
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 19, 19);
    setTimeout(function () { ghost.remove(); }, 0);

    setTimeout(function () { folderEl.classList.add("dragging"); }, 0);
    hideIconTooltip();
  });

  headerEl.addEventListener("dragend", function () {
    folderEl.classList.remove("dragging");
    clearFolderDragIndicators();
    clearDragIndicators();
    draggedFolderName = null;
    draggedEl = null;
  });
}

// Reorder the full project list by moving a folder's slugs as a block.
// insertBeforeSlug: the slug (or folder sentinel "folder:<name>") before which to insert.
// insertAfter: if true, insert after that slug instead.
function reorderWithFolder(folderName, targetSlug, insertAfter) {
  // Collect all slugs in order from the DOM
  var container = document.getElementById("icon-strip-projects");
  var items = container.querySelectorAll(".icon-strip-item");
  var allSlugs = [];
  for (var i = 0; i < items.length; i++) {
    allSlugs.push(items[i].dataset.slug);
  }

  // Partition into folder slugs and the rest
  var folderSlugs = [];
  var otherSlugs = [];
  for (var j = 0; j < allSlugs.length; j++) {
    var s = allSlugs[j];
    var inFolder = false;
    for (var k = 0; k < cachedProjectList.length; k++) {
      if (cachedProjectList[k].slug === s && cachedProjectList[k].folderName === folderName) {
        inFolder = true; break;
      }
    }
    if (inFolder) folderSlugs.push(s);
    else otherSlugs.push(s);
  }

  // Find insertion point in otherSlugs based on targetSlug
  var insertIdx = otherSlugs.indexOf(targetSlug);
  if (insertIdx === -1) {
    // Target might be in a different folder — find any slug from that folder
    for (var li = 0; li < cachedProjectList.length; li++) {
      if (cachedProjectList[li].folderName === targetSlug) {
        // targetSlug is actually a folder name; find its first slug in otherSlugs
        var firstFolderSlug = otherSlugs.find ? otherSlugs.find(function (sl) {
          for (var m = 0; m < cachedProjectList.length; m++) {
            if (cachedProjectList[m].slug === sl && cachedProjectList[m].folderName === targetSlug) return true;
          }
          return false;
        }) : null;
        if (firstFolderSlug) insertIdx = otherSlugs.indexOf(firstFolderSlug);
        break;
      }
    }
  }
  if (insertIdx === -1) insertIdx = otherSlugs.length; // fallback: append
  if (insertAfter) insertIdx++;

  // Splice folder slugs in at the insertion point
  var result = otherSlugs.slice(0, insertIdx).concat(folderSlugs).concat(otherSlugs.slice(insertIdx));

  var ws = getWs();
  if (ws && store.get('connected')) {
    ws.send(JSON.stringify({ type: "reorder_projects", slugs: result }));
  }
}

// Trigger inline rename on a folder label by name
function triggerFolderRename(folderName) {
  var container = document.getElementById("icon-strip-projects");
  if (!container) return;
  var folderEls = container.querySelectorAll(".icon-strip-folder[data-folder-name]");
  for (var i = 0; i < folderEls.length; i++) {
    if (folderEls[i].dataset.folderName === folderName) {
      var labelEl = folderEls[i].querySelector(".icon-strip-folder-label");
      if (labelEl) startFolderInlineRename(folderName, labelEl);
      break;
    }
  }
}

// --- Worktree folder collapse ---

function setWtCollapsed(slug, collapsed) {
  wtCollapsed[slug] = collapsed;
  try { localStorage.setItem("clay-wt-collapsed", JSON.stringify(wtCollapsed)); } catch (e) {}
}

function groupProjects(projects) {
  var parents = [];
  var wtByParent = {};
  for (var i = 0; i < projects.length; i++) {
    var p = projects[i];
    if (p.isWorktree && p.parentSlug) {
      if (!wtByParent[p.parentSlug]) wtByParent[p.parentSlug] = [];
      wtByParent[p.parentSlug].push(p);
    } else {
      parents.push(p);
    }
  }
  return { parents: parents, wtByParent: wtByParent };
}

// Returns an ordered list of rendering units: folder objects and standalone projects.
// Each folder: { type:'folder', name, projects:[...] }
// Each standalone: { type:'project', project: p }
function groupByFolders(parents) {
  var units = [];
  var folderMap = {};   // folderName → { type:'folder', name, projects:[] }
  var folderOrder = []; // folder names in first-seen order

  for (var i = 0; i < parents.length; i++) {
    var p = parents[i];
    var fn = p.folderName || null;
    if (fn) {
      if (!folderMap[fn]) {
        folderMap[fn] = { type: 'folder', name: fn, projects: [] };
        folderOrder.push(fn);
      }
      folderMap[fn].projects.push(p);
    } else {
      units.push({ type: 'project', project: p });
    }
  }

  // Insert folder units at the position of the folder's first project
  // by rebuilding in insertion order
  var result = [];
  var foldersInserted = {};
  for (var j = 0; j < parents.length; j++) {
    var pp = parents[j];
    var pfn = pp.folderName || null;
    if (pfn) {
      if (!foldersInserted[pfn]) {
        foldersInserted[pfn] = true;
        result.push(folderMap[pfn]);
      }
    } else {
      result.push({ type: 'project', project: pp });
    }
  }
  return result;
}

// Auto-generate a unique folder name
function generateFolderName(existingFolderNames) {
  var base = "Folder";
  if (existingFolderNames.indexOf(base) === -1) return base;
  for (var i = 2; i < 100; i++) {
    var candidate = base + " " + i;
    if (existingFolderNames.indexOf(candidate) === -1) return candidate;
  }
  return base + " " + Date.now();
}

// --- Icon item creation ---

function createIconItem(p, currentSlug) {
  var currentDmUserId = getCurrentDmUserId ? getCurrentDmUserId() : null;
  var el = document.createElement("a");
  var isActive = p.slug === currentSlug && !currentDmUserId;
  el.className = "icon-strip-item" + (isActive ? " active" : "");
  el.href = "/p/" + p.slug + "/";
  el.dataset.slug = p.slug;

  if (p.icon) {
    var emojiSpan = document.createElement("span");
    emojiSpan.className = "project-emoji";
    emojiSpan.textContent = p.icon;
    parseEmojis(emojiSpan);
    el.appendChild(emojiSpan);
  } else {
    el.appendChild(document.createTextNode(getProjectAbbrev(p.name)));
  }

  var pill = document.createElement("span");
  pill.className = "icon-strip-pill";
  el.appendChild(pill);

  var statusDot = document.createElement("span");
  statusDot.className = "icon-strip-status";
  if (p.isProcessing) statusDot.classList.add("processing");
  el.appendChild(statusDot);

  var projectBadge = document.createElement("span");
  projectBadge.className = "icon-strip-project-badge";
  if (p.unread > 0 && !isActive) {
    projectBadge.textContent = p.unread > 99 ? "99+" : String(p.unread);
    projectBadge.classList.add("has-unread");
  }
  el.appendChild(projectBadge);

  if (p.pendingPermissions > 0 && !isActive) {
    el.classList.add("has-pending-perm");
  }

  (function (name, elem) {
    elem.addEventListener("mouseenter", function () { showIconTooltip(elem, name); });
    elem.addEventListener("mouseleave", hideIconTooltip);
  })(p.name, el);

  (function (slug) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      if (switchProject) switchProject(slug);
    });
  })(p.slug);

  return el;
}

// --- Worktree creation modal ---

function showWorktreeModal(parentSlug, parentName) {
  var existing = document.getElementById("wt-modal-container");
  if (existing) existing.remove();

  var container = document.createElement("div");
  container.id = "wt-modal-container";

  var overlay = document.createElement("div");
  overlay.className = "wt-modal-overlay";
  container.appendChild(overlay);

  var modal = document.createElement("div");
  modal.className = "wt-modal";

  var title = document.createElement("div");
  title.className = "wt-modal-title";
  title.textContent = "Add Worktree \u2014 " + parentName;
  modal.appendChild(title);

  var branchLabel = document.createElement("label");
  branchLabel.className = "wt-modal-label";
  branchLabel.textContent = "Branch name";
  modal.appendChild(branchLabel);

  var branchInput = document.createElement("input");
  branchInput.type = "text";
  branchInput.className = "wt-modal-input";
  branchInput.placeholder = "feat/my-feature";
  branchInput.autocomplete = "off";
  branchInput.spellcheck = false;
  modal.appendChild(branchInput);

  var baseLabel = document.createElement("label");
  baseLabel.className = "wt-modal-label";
  baseLabel.textContent = "Base branch";
  modal.appendChild(baseLabel);

  var baseSelect = document.createElement("select");
  baseSelect.className = "wt-modal-input";
  var defaultOpt = document.createElement("option");
  defaultOpt.value = "main";
  defaultOpt.textContent = "main";
  baseSelect.appendChild(defaultOpt);
  modal.appendChild(baseSelect);

  fetch("/p/" + parentSlug + "/api/branches")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      baseSelect.innerHTML = "";
      var branches = data.branches || ["main"];
      var defBranch = data.defaultBranch || "main";
      for (var i = 0; i < branches.length; i++) {
        var opt = document.createElement("option");
        opt.value = branches[i];
        opt.textContent = branches[i];
        if (branches[i] === defBranch) opt.selected = true;
        baseSelect.appendChild(opt);
      }
    })
    .catch(function () {});

  var errorDiv = document.createElement("div");
  errorDiv.className = "wt-modal-error";
  modal.appendChild(errorDiv);

  var actions = document.createElement("div");
  actions.className = "wt-modal-actions";

  var cancelBtn = document.createElement("button");
  cancelBtn.className = "wt-modal-btn";
  cancelBtn.textContent = "Cancel";
  actions.appendChild(cancelBtn);

  var createBtn = document.createElement("button");
  createBtn.className = "wt-modal-btn primary";
  createBtn.textContent = "Create";
  actions.appendChild(createBtn);

  modal.appendChild(actions);
  container.appendChild(modal);
  document.body.appendChild(container);
  branchInput.focus();

  function closeModal() { container.remove(); }

  function doCreate() {
    var branch = branchInput.value.trim();
    var base = baseSelect.value.trim() || null;
    if (!branch) {
      errorDiv.textContent = "Branch name is required";
      errorDiv.classList.add("visible");
      return;
    }
    var dirName = branch.replace(/\//g, "-");
    createBtn.disabled = true;
    createBtn.textContent = "Creating...";
    errorDiv.classList.remove("visible");

    if (getWs() && store.get('connected')) {
      getWs().send(JSON.stringify({
        type: "create_worktree",
        branch: branch,
        dirName: dirName,
        baseBranch: base
      }));
    }

    var handler = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === "create_worktree_result") {
        getWs().removeEventListener("message", handler);
        if (msg.ok) {
          closeModal();
          if (msg.slug && switchProject) switchProject(msg.slug);
        } else {
          createBtn.disabled = false;
          createBtn.textContent = "Create";
          errorDiv.textContent = msg.error || "Failed to create worktree";
          errorDiv.classList.add("visible");
        }
      }
    };
    getWs().addEventListener("message", handler);
  }

  overlay.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);
  createBtn.addEventListener("click", doCreate);
  branchInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") doCreate();
    if (e.key === "Escape") closeModal();
  });
  baseSelect.addEventListener("keydown", function (e) {
    if (e.key === "Enter") doCreate();
    if (e.key === "Escape") closeModal();
  });
}

// --- Render icon strip ---

export function renderIconStrip(projects, currentSlug, folderMeta) {
  cachedProjectList = projects;
  cachedCurrentSlug = currentSlug;
  if (folderMeta) cachedFolderMeta = folderMeta;

  var container = document.getElementById("icon-strip-projects");
  if (!container) return;
  container.innerHTML = "";

  var currentDmUserId = getCurrentDmUserId ? getCurrentDmUserId() : null;
  var grouped = groupProjects(projects);
  var units = groupByFolders(grouped.parents);

  for (var i = 0; i < units.length; i++) {
    var unit = units[i];

    if (unit.type === 'folder') {
      container.appendChild(renderUserFolder(unit, grouped.wtByParent, currentSlug, currentDmUserId));
      continue;
    }

    // Standalone project (no user folder)
    var p = unit.project;
    var worktrees = grouped.wtByParent[p.slug] || [];
    var hasWorktrees = worktrees.length > 0;

    if (!hasWorktrees) {
      var el = createIconItem(p, currentSlug);
      (function (slug, name, elem) {
        elem.addEventListener("contextmenu", function (e) {
          e.preventDefault();
          e.stopPropagation();
          showIconCtxMenu(elem, slug, name);
        });
      })(p.slug, p.name || p.slug, el);
      setupDragHandlers(el, p.slug);
      container.appendChild(el);
      continue;
    }

    // Worktree group for parent + worktrees
    container.appendChild(renderWorktreeGroup(p, worktrees, currentSlug, currentDmUserId));
  }

  // Update home icon active state
  var homeIcon = document.querySelector(".icon-strip-home");
  if (homeIcon) {
    if ((!currentSlug || projects.length === 0) && !currentDmUserId) {
      homeIcon.classList.add("active");
    } else {
      homeIcon.classList.remove("active");
    }
  }

  renderProjectList(projects, currentSlug);

  try { lucide.createIcons({ nodes: [container] }); } catch (e) {}
}

// Render a user-defined folder (contains multiple projects, each may have worktrees)
function renderUserFolder(unit, wtByParent, currentSlug, currentDmUserId) {
  var folderName = unit.name;
  var folderProjects = unit.projects;
  var fmeta = cachedFolderMeta[folderName] || {};
  var isCollapsed = !!folderCollapsed[folderName];

  // Aggregate state: unread sum, processing, active
  var totalUnread = 0;
  var anyProcessing = false;
  var containsActive = false;
  for (var fi = 0; fi < folderProjects.length; fi++) {
    var fp = folderProjects[fi];
    totalUnread += fp.unread || 0;
    if (fp.isProcessing) anyProcessing = true;
    if (fp.slug === currentSlug) containsActive = true;
    // Also check worktrees
    var fwt = wtByParent[fp.slug] || [];
    for (var fwi = 0; fwi < fwt.length; fwi++) {
      totalUnread += fwt[fwi].unread || 0;
      if (fwt[fwi].isProcessing) anyProcessing = true;
      if (fwt[fwi].slug === currentSlug) containsActive = true;
    }
  }

  var folderEl = document.createElement("div");
  folderEl.className = "icon-strip-folder" + (isCollapsed ? " collapsed" : "") + (containsActive && isCollapsed ? " contains-active" : "");
  folderEl.dataset.folderName = folderName;

  // Folder header pill — same 48px hit-box as project icons
  var headerEl = document.createElement("div");
  headerEl.className = "icon-strip-folder-header" + (containsActive && isCollapsed ? " active" : "");

  // Inner box: colored background pill (like project items) with emoji or folder icon
  var iconBox = document.createElement("span");
  iconBox.className = "icon-strip-folder-icon-box";
  if (fmeta.icon) {
    // Emoji fills the box — render as plain text, no parseEmojis needed
    var emojiSpan = document.createElement("span");
    emojiSpan.className = "icon-strip-folder-emoji-main";
    emojiSpan.textContent = fmeta.icon;
    iconBox.appendChild(emojiSpan);
  } else {
    // Fallback: folder SVG icon
    iconBox.innerHTML = iconHtml("folder");
  }
  headerEl.appendChild(iconBox);

  // Folder label (inline-editable on double-click)
  var labelEl = document.createElement("span");
  labelEl.className = "icon-strip-folder-label";
  labelEl.textContent = folderName;
  labelEl.setAttribute("draggable", "false"); // prevent text drag from intercepting folder drag
  headerEl.appendChild(labelEl);

  // Processing dot
  var fStatusDot = document.createElement("span");
  fStatusDot.className = "icon-strip-status";
  if (anyProcessing) fStatusDot.classList.add("processing");
  headerEl.appendChild(fStatusDot);

  // Unread badge
  if (totalUnread > 0 && isCollapsed) {
    var fBadge = document.createElement("span");
    fBadge.className = "icon-strip-project-badge has-unread";
    fBadge.textContent = totalUnread > 99 ? "99+" : String(totalUnread);
    headerEl.appendChild(fBadge);
  }

  // Chevron toggle
  var chevron = document.createElement("span");
  chevron.className = "icon-strip-folder-chevron";
  chevron.innerHTML = iconHtml("chevron-down");
  headerEl.appendChild(chevron);

  // Click header → toggle collapse
  (function (fn, fEl) {
    headerEl.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var nowCollapsed = fEl.classList.toggle("collapsed");
      setFolderCollapsed(fn, nowCollapsed);
      renderIconStrip(cachedProjectList, cachedCurrentSlug, cachedFolderMeta);
    });
    // Double-click label → inline rename
    labelEl.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      startFolderInlineRename(fn, labelEl);
    });
    headerEl.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
      showFolderCtxMenu(headerEl, fn);
    });
  })(folderName, folderEl);

  (function (fn) {
    headerEl.addEventListener("mouseenter", function () { showIconTooltip(headerEl, fn); });
    headerEl.addEventListener("mouseleave", hideIconTooltip);
  })(folderName);

  // Folder header: drop target for projects (add to folder) AND drag target for reordering folder
  (function (fn) {
    headerEl.addEventListener("dragover", function (e) {
      if (!draggedFolderName && !draggedSlug) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      if (draggedFolderName) {
        // A folder is being dragged — show above/below reorder indicator
        if (draggedFolderName === fn) return; // can't drop on itself
        var rect = headerEl.getBoundingClientRect();
        var pct = (e.clientY - rect.top) / rect.height;
        clearFolderDragIndicators();
        clearDragIndicators();
        if (pct < 0.5) {
          headerEl.classList.add("drag-over-above");
        } else {
          headerEl.classList.add("drag-over-below");
        }
      } else {
        // A project is being dragged — highlight folder for add-to-folder
        // Don't show add highlight if this project is already in this folder
        var alreadyInCheck = false;
        for (var ai = 0; ai < cachedProjectList.length; ai++) {
          if (cachedProjectList[ai].slug === draggedSlug && cachedProjectList[ai].folderName === fn) {
            alreadyInCheck = true; break;
          }
        }
        if (!alreadyInCheck) headerEl.classList.add("drag-over-folder");
      }
    });
    headerEl.addEventListener("dragleave", function (e) {
      if (e.relatedTarget && headerEl.contains(e.relatedTarget)) return;
      headerEl.classList.remove("drag-over-folder", "drag-over-above", "drag-over-below");
    });
    headerEl.addEventListener("drop", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var wasAbove = headerEl.classList.contains("drag-over-above");
      var wasBelow = headerEl.classList.contains("drag-over-below");
      headerEl.classList.remove("drag-over-folder", "drag-over-above", "drag-over-below");
      clearFolderDragIndicators();

      if (draggedFolderName && draggedFolderName !== fn) {
        // Reorder folder: move dragged folder before/after this folder
        // Find first slug that belongs to this target folder
        var firstTargetSlug = null;
        for (var ti = 0; ti < cachedProjectList.length; ti++) {
          if (cachedProjectList[ti].folderName === fn) { firstTargetSlug = cachedProjectList[ti].slug; break; }
        }
        if (firstTargetSlug) reorderWithFolder(draggedFolderName, firstTargetSlug, wasBelow);
        return;
      }

      if (!draggedSlug) return;
      // Project dropped on folder header — add to folder
      var alreadyIn = false;
      for (var ci = 0; ci < cachedProjectList.length; ci++) {
        if (cachedProjectList[ci].slug === draggedSlug && cachedProjectList[ci].folderName === fn) {
          alreadyIn = true; break;
        }
      }
      if (!alreadyIn) {
        var ws = getWs();
        if (ws && store.get('connected')) {
          ws.send(JSON.stringify({ type: "set_project_folder", slug: draggedSlug, folderName: fn }));
        }
      }
    });
  })(folderName);

  // Wire up folder-level drag (moves the whole folder)
  setupFolderDragHandlers(headerEl, folderEl, folderName, folderProjects);

  folderEl.appendChild(headerEl);

  // Items container (hidden when collapsed)
  var itemsEl = document.createElement("div");
  itemsEl.className = "icon-strip-folder-items";

  for (var pi = 0; pi < folderProjects.length; pi++) {
    var fp2 = folderProjects[pi];
    var fWorktrees = wtByParent[fp2.slug] || [];
    if (fWorktrees.length > 0) {
      itemsEl.appendChild(renderWorktreeGroup(fp2, fWorktrees, currentSlug, currentDmUserId));
    } else {
      var pEl = createIconItem(fp2, currentSlug);
      pEl.classList.add("in-folder");
      (function (slug, name, elem) {
        elem.addEventListener("contextmenu", function (e) {
          e.preventDefault();
          e.stopPropagation();
          showIconCtxMenu(elem, slug, name);
        });
      })(fp2.slug, fp2.name || fp2.slug, pEl);
      setupDragHandlers(pEl, fp2.slug);
      itemsEl.appendChild(pEl);
    }
  }

  folderEl.appendChild(itemsEl);
  return folderEl;
}

// Render a worktree group (parent + worktrees, original logic extracted)
function renderWorktreeGroup(p, worktrees, currentSlug, currentDmUserId) {
  var folder = document.createElement("div");
  folder.className = "icon-strip-group";
  folder.dataset.parentSlug = p.slug;
  if (wtCollapsed[p.slug]) folder.classList.add("collapsed");

  if (!p.isProcessing) {
    for (var wpi = 0; wpi < worktrees.length; wpi++) {
      if (worktrees[wpi].isProcessing) { p.isProcessing = true; break; }
    }
  }

  var header = createIconItem(p, currentSlug);
  header.classList.add("folder-header");
  (function (slug, name, elem) {
    elem.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
      showIconCtxMenu(elem, slug, name);
    });
  })(p.slug, p.name || p.slug, header);
  setupDragHandlers(header, p.slug);

  var chevron = document.createElement("span");
  chevron.className = "icon-strip-group-chevron";
  chevron.innerHTML = '<i data-lucide="git-branch"></i>';
  (function (parentSlug, folderEl) {
    chevron.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var nowCollapsed = folderEl.classList.toggle("collapsed");
      setWtCollapsed(parentSlug, nowCollapsed);
    });
    chevron.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
    });
  })(p.slug, folder);
  chevron.setAttribute("data-tip", "Toggle worktrees");
  header.appendChild(chevron);
  folder.appendChild(header);

  var itemsContainer = document.createElement("div");
  itemsContainer.className = "icon-strip-group-items";

  for (var wi = 0; wi < worktrees.length; wi++) {
    (function (wt) {
      var wtEl = document.createElement("a");
      var isWtActive = wt.slug === currentSlug && !currentDmUserId;
      var isAccessible = wt.worktreeAccessible !== false;
      wtEl.className = "icon-strip-wt-item" + (isWtActive ? " active" : "") + (!isAccessible ? " wt-disabled" : "");
      wtEl.href = "/p/" + wt.slug + "/";
      wtEl.dataset.slug = wt.slug;

      if (wt.icon) {
        var wtEmoji = document.createElement("span");
        wtEmoji.className = "wt-branch-abbrev project-emoji";
        wtEmoji.textContent = wt.icon;
        parseEmojis(wtEmoji);
        wtEl.appendChild(wtEmoji);
      } else {
        var abbrev = document.createElement("span");
        abbrev.className = "wt-branch-abbrev";
        abbrev.textContent = getProjectAbbrev(wt.name);
        wtEl.appendChild(abbrev);
      }

      var wtStatus = document.createElement("span");
      wtStatus.className = "icon-strip-status";
      if (wt.isProcessing) wtStatus.classList.add("processing");
      wtEl.appendChild(wtStatus);

      var tooltipText = wt.name;
      if (!isAccessible) tooltipText += " (outside project path, cannot be accessed)";

      (function (text, elem) {
        elem.addEventListener("mouseenter", function () { showIconTooltip(elem, text); });
        elem.addEventListener("mouseleave", hideIconTooltip);
      })(tooltipText, wtEl);

      if (isAccessible) {
        (function (slug) {
          wtEl.addEventListener("click", function (e) {
            e.preventDefault();
            if (switchProject) switchProject(slug);
          });
        })(wt.slug);
      } else {
        wtEl.addEventListener("click", function (e) { e.preventDefault(); });
      }

      if (isAccessible) {
        (function (slug, name, elem) {
          elem.addEventListener("contextmenu", function (e) {
            e.preventDefault();
            e.stopPropagation();
            showIconCtxMenu(elem, slug, name);
          });
        })(wt.slug, wt.name, wtEl);
      } else {
        wtEl.addEventListener("contextmenu", function (e) {
          e.preventDefault();
          e.stopPropagation();
        });
      }

      if (wt.pendingPermissions > 0 && !isWtActive) wtEl.classList.add("has-pending-perm");

      itemsContainer.appendChild(wtEl);
    })(worktrees[wi]);
  }

  var hasWtPendingPerm = false;
  for (var wpi2 = 0; wpi2 < worktrees.length; wpi2++) {
    if (worktrees[wpi2].pendingPermissions > 0) { hasWtPendingPerm = true; break; }
  }
  if (hasWtPendingPerm) folder.classList.remove("collapsed");

  var addBtn = document.createElement("button");
  addBtn.className = "icon-strip-group-add";
  addBtn.textContent = "+";
  (function (parentSlug, parentName, btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      showWorktreeModal(parentSlug, parentName);
    });
    btn.addEventListener("mouseenter", function () { showIconTooltip(btn, "New worktree"); });
    btn.addEventListener("mouseleave", hideIconTooltip);
  })(p.slug, p.name, addBtn);
  itemsContainer.appendChild(addBtn);

  folder.appendChild(itemsContainer);
  return folder;
}

function renderProjectList(projects, currentSlug) {
  var list = document.getElementById("project-list");
  if (!list) return;
  list.innerHTML = "";

  var grouped = groupProjects(projects);

  for (var i = 0; i < grouped.parents.length; i++) {
    var p = grouped.parents[i];
    var worktrees = grouped.wtByParent[p.slug] || [];

    if (worktrees.length === 0) {
      list.appendChild(createMobileProjectItem(p, currentSlug, false));
      continue;
    }

    var folderDiv = document.createElement("div");
    folderDiv.className = "mobile-project-folder";
    if (wtCollapsed[p.slug]) folderDiv.classList.add("collapsed");

    var headerEl = createMobileProjectItem(p, currentSlug, false);
    var chevron = document.createElement("span");
    chevron.className = "mobile-folder-chevron";
    chevron.innerHTML = "&#9660;";
    (function (parentSlug, fDiv) {
      chevron.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var nowCollapsed = fDiv.classList.toggle("collapsed");
        setWtCollapsed(parentSlug, nowCollapsed);
      });
    })(p.slug, folderDiv);
    headerEl.appendChild(chevron);
    folderDiv.appendChild(headerEl);

    var wtList = document.createElement("div");
    wtList.className = "mobile-folder-items";
    for (var wi = 0; wi < worktrees.length; wi++) {
      var isAccessible = worktrees[wi].worktreeAccessible !== false;
      var wtItem = createMobileProjectItem(worktrees[wi], currentSlug, true);
      if (!isAccessible) wtItem.classList.add("wt-disabled");
      if (!isAccessible) {
        wtItem.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); });
      }
      wtList.appendChild(wtItem);
    }
    folderDiv.appendChild(wtList);
    list.appendChild(folderDiv);
  }
}

function createMobileProjectItem(p, currentSlug, isWorktree) {
  var el = document.createElement("button");
  el.className = "mobile-project-item" + (p.slug === currentSlug ? " active" : "") + (isWorktree ? " wt-item" : "");

  var abbrev = document.createElement("span");
  abbrev.className = "mobile-project-abbrev";
  if (p.icon) {
    abbrev.textContent = p.icon;
    parseEmojis(abbrev);
  } else {
    abbrev.textContent = getProjectAbbrev(p.name);
  }
  el.appendChild(abbrev);

  var name = document.createElement("span");
  name.className = "mobile-project-name";
  name.textContent = p.name;
  el.appendChild(name);

  if (p.isProcessing) {
    var dot = document.createElement("span");
    dot.className = "mobile-project-processing";
    el.appendChild(dot);
  }

  el.addEventListener("click", function () {
    if (switchProject) switchProject(p.slug);
    if (closeSidebar) closeSidebar();
  });

  return el;
}


export function updateProjectBadge(slug, count) {
  var icon = document.querySelector('.icon-strip-item[data-slug="' + slug + '"]');
  if (!icon) return;
  var badge = icon.querySelector(".icon-strip-project-badge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.add("has-unread");
  } else {
    badge.textContent = "";
    badge.classList.remove("has-unread");
  }
}
