import { escapeHtml, copyToClipboard } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { renderMarkdown, highlightCodeBlocks, renderMermaidBlocks } from './markdown.js';
import { renderUnifiedDiff, renderSplitDiff, renderPatchDiff, reconstructPatchSources } from './diff.js';
import { openFile } from './filebrowser.js';
import { getChatLayout } from './theme.js';
import { store } from './store.js';
import { VENDOR_NAMES } from './app-rendering.js';
import { createPromptController } from './prompts.js';

var ctx;

// During history replay, individual tool renders (todos, file edits, command
// outputs) must not auto-scroll. The history_done handler arms sticky-bottom
// which pins the viewport to the true bottom after the whole replay settles.
// Per-tool scroll calls during replay fight that and re-anchor the user to
// whichever tool widget grew last (commonly the todo widget).
function maybeScrollToBottom() {
  if (store.get('replayingHistory')) return;
  if (ctx && ctx.scrollToBottom) ctx.scrollToBottom();
}

// --- Plan mode state ---
var inPlanMode = false;
var planContent = null;
var currentPlanCardEl = null;

// --- Backgrounded subagent (Task tool) liveness tracking ---
// lr-255e originally added this (keyed by parentToolId, the same id used for
// the stop-button dedup guard below) so callers could avoid clearing the
// "thinking dots" indicator out from under a still-running subagent. lr-66c118
// removed the last such caller (hasActiveSubagents() had no consumers left
// once setActivity collapsed to a single optimistic raise site) but the
// tracking dict itself is still load-bearing for the Stop button UI
// (initSubagentStop/updateSubagentTaskStatus/markSubagentDone below).
var activeSubagentToolIds = {};

// --- Todo state ---
var todoItems = [];
var todoWidgetEl = null;
var todoWidgetVisible = true; // whether in-chat widget is in viewport
var todoObserver = null;
// When a session is resumed without a live SDK process and still has
// pending/in_progress items, the widget is rendered in compact mode
// (header + count only) so it doesn't anchor visual position mid-page
// or extend the sticky-bottom settle window with a tall element.
var todoDeadCompact = false;
var todoMeta = {
  variant: "tasks",
  title: "Tasks",
  icon: "list-checks",
  showProgress: true,
  showCompletedCount: true,
  stickyEnabled: true,
};

// --- Tool tracking ---
var tools = {};
var currentThinking = null;
var thinkingGroup = null; // { el, count, totalDuration }

// --- Tool group tracking ---
var currentToolGroup = null;
var toolGroupCounter = 0;
var toolGroups = {};

// --- Tool helpers ---
var PLAN_MODE_TOOLS = { EnterPlanMode: 1, ExitPlanMode: 1 };
var TODO_TOOLS = { TodoWrite: 1, TaskCreate: 1, TaskUpdate: 1, TaskList: 1, TaskGet: 1 };
var HIDDEN_RESULT_TOOLS = { EnterPlanMode: 1, ExitPlanMode: 1, TaskCreate: 1, TaskUpdate: 1, TaskList: 1, TaskGet: 1, TodoWrite: 1 };

// --- Tool group helpers ---
function closeToolGroup() {
  if (currentToolGroup) {
    currentToolGroup.closed = true;
  }
  currentToolGroup = null;
}

function findToolGroup(groupId) {
  return toolGroups[groupId] || null;
}

function toolGroupSummary(group) {
  var names = group.toolNames;
  var count = names.length;
  var allDone = group.doneCount >= count;

  // Count by tool name
  var counts = {};
  for (var i = 0; i < names.length; i++) {
    counts[names[i]] = (counts[names[i]] || 0) + 1;
  }
  var uniqueNames = Object.keys(counts);

  if (uniqueNames.length === 1) {
    var name = uniqueNames[0];
    var n = counts[name];
    if (allDone) {
      switch (name) {
        case "Read": return "Read " + n + " file" + (n > 1 ? "s" : "");
        case "Edit": return "Edited " + n + " file" + (n > 1 ? "s" : "");
        case "Write": return "Wrote " + n + " file" + (n > 1 ? "s" : "");
        case "Bash": return "Ran " + n + " command" + (n > 1 ? "s" : "");
        case "Grep": return "Searched " + n + " pattern" + (n > 1 ? "s" : "");
        case "Glob": return "Found " + n + " pattern" + (n > 1 ? "s" : "");
        case "Task": return "Ran " + n + " task" + (n > 1 ? "s" : "");
        case "WebSearch": return "Searched " + n + " quer" + (n > 1 ? "ies" : "y");
        case "WebFetch": return "Fetched " + n + " URL" + (n > 1 ? "s" : "");
        default: return "Ran " + n + " tool" + (n > 1 ? "s" : "");
      }
    }
    switch (name) {
      case "Read": return "Reading " + n + " file" + (n > 1 ? "s" : "") + "...";
      case "Edit": return "Editing " + n + " file" + (n > 1 ? "s" : "") + "...";
      case "Write": return "Writing " + n + " file" + (n > 1 ? "s" : "") + "...";
      case "Bash": return "Running " + n + " command" + (n > 1 ? "s" : "") + "...";
      case "Grep": return "Searching " + n + " pattern" + (n > 1 ? "s" : "") + "...";
      case "Glob": return "Finding " + n + " pattern" + (n > 1 ? "s" : "") + "...";
      case "Task": return "Running " + n + " task" + (n > 1 ? "s" : "") + "...";
      case "WebSearch": return "Searching " + n + " quer" + (n > 1 ? "ies" : "y") + "...";
      case "WebFetch": return "Fetching " + n + " URL" + (n > 1 ? "s" : "") + "...";
      default: return "Running " + n + " tool" + (n > 1 ? "s" : "") + "...";
    }
  }

  // Mixed tools
  if (allDone) return "Ran " + count + " tools";
  return "Running " + count + " tools...";
}

function updateToolGroupHeader(group) {
  if (!group || !group.el) return;
  var label = group.el.querySelector(".tool-group-label");
  if (label) label.textContent = toolGroupSummary(group);

  var allDone = group.doneCount >= group.toolCount;
  var statusIcon = group.el.querySelector(".tool-group-status-icon");
  var bullet = group.el.querySelector(".tool-group-bullet");

  if (allDone) {
    group.el.classList.add("done");
    if (group.errorCount > 0) {
      statusIcon.innerHTML = '<span class="err-icon">' + iconHtml("alert-triangle") + '</span>';
      if (bullet) bullet.classList.add("error");
    } else {
      statusIcon.innerHTML = '<span class="check">' + iconHtml("check") + '</span>';
    }
    refreshIcons(group.el);
  }

  // Show group header only when 2+ visible tools
  var header = group.el.querySelector(".tool-group-header");
  if (group.toolCount >= 2) {
    header.style.display = "";
    // When 2+ tools, ensure collapsed by default (unless user already toggled)
    if (!group.userToggled && !group.el.classList.contains("expanded-by-user")) {
      group.el.classList.add("collapsed");
    }
  } else {
    header.style.display = "none";
    group.el.classList.remove("collapsed");
  }
}

function isPlanFile(filePath) {
  return filePath && filePath.indexOf(".claude/plans/") !== -1;
}

export function toolSummary(name, input) {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Read": return shortPath(input.file_path);
    case "Edit": return shortPath(input.file_path);
    case "Write": return shortPath(input.file_path);
    case "Bash": return (input.command || "").substring(0, 80);
    case "Glob": return input.pattern || "";
    case "Grep": return (input.pattern || "") + (input.path ? " in " + shortPath(input.path) : "");
    case "WebFetch": return input.url || "";
    case "WebSearch": return input.query || "";
    case "Task": return input.description || "";
    case "EnterPlanMode": return "";
    case "ExitPlanMode": return "";
    default: return JSON.stringify(input).substring(0, 60);
  }
}

export function toolActivityText(name, input) {
  if (name === "Bash" && input && input.description) return input.description;
  if (name === "Read" && input && input.file_path) return "Reading " + shortPath(input.file_path);
  if (name === "Edit" && input && input.file_path) return "Editing " + shortPath(input.file_path);
  if (name === "Write" && input && input.file_path) return "Writing " + shortPath(input.file_path);
  if (name === "Grep" && input && input.pattern) return "Searching for " + input.pattern;
  if (name === "Glob" && input && input.pattern) return "Finding " + input.pattern;
  if (name === "WebSearch" && input && input.query) return "Searching: " + input.query;
  if (name === "WebFetch") return "Fetching URL...";
  if (name === "Task" && input && input.description) return input.description;
  if (name === "EnterPlanMode") return "Entering plan mode...";
  if (name === "ExitPlanMode") return "Finalizing the plan...";
  return "Running " + name + "...";
}

function shortPath(p) {
  if (!p) return "";
  var parts = p.split("/");
  return parts.length > 3 ? ".../" + parts.slice(-3).join("/") : p;
}

export function disableMainInput() {
  ctx.inputEl.disabled = true;
  ctx.inputEl.placeholder = "Answer the question above to continue...";
}

export function enableMainInput() {
  ctx.inputEl.disabled = false;
  var _v = store.get('currentVendor') || "claude";
  ctx.inputEl.placeholder = "Message " + (VENDOR_NAMES[_v] || VENDOR_NAMES.claude) + "...";
}

// --- Operator prompts (permission, plan, AskUserQuestion, elicitation) ---

// Cards are drawn and kept in line with the server's state by one
// controller (prompts.js). Its state is not cleared by resetToolState: an
// older-history page resets tool state after newer pages already delivered
// the outcomes it needs. Cleared on session switch.
var prompts = createPromptController({
  place: function (container, focusSelector) {
    ctx.finalizeAssistantBlock();
    stopThinking();
    closeToolGroup();
    ctx.addToMessages(container);
    refreshIcons(container);
    maybeScrollToBottom();
    if (focusSelector) {
      setTimeout(function () {
        var target = container.querySelector(focusSelector);
        if (target) target.focus();
      }, 50);
    }
  },
  send: function (payload) {
    if (!(ctx.ws && ctx.connected)) return false;
    ctx.ws.send(JSON.stringify(payload));
    return true;
  },
  layout: function () { return getChatLayout(); },
  toolSummary: toolSummary,
  vendorIdentity: vendorIdentity,
  getContextPercent: function () { return ctx.getContextPercent ? ctx.getContextPercent() : 0; },
  getPlanContent: function () { return planContent; },
  setMainInputDisabled: function (disabled) {
    if (!ctx.inputEl) return;
    if (disabled) disableMainInput();
    else enableMainInput();
  },
  contains: function (el) {
    return !(ctx.messagesEl && typeof ctx.messagesEl.contains === "function") || ctx.messagesEl.contains(el);
  },
  findInTranscript: function (requestId) {
    return ctx && ctx.messagesEl ? ctx.messagesEl.querySelector('[data-request-id="' + requestId + '"]') : null;
  },
});

/**
 * Apply one prompt message of any kind, live or replayed (including the
 * per-kind messages of older history). Returns the prompt's effective state,
 * or null for a message that is not about a prompt.
 */
export function applyPromptMessage(msg) {
  return prompts.apply(msg);
}

export function clearPromptStates() {
  prompts.clear();
}

/** Whether any prompt, of any kind, is still awaiting the operator. */
export function hasPendingPrompts() {
  return prompts.hasPending();
}

/** Return every card awaiting a server confirmation to its answerable state. */
export function restoreUnconfirmedPrompts(message) {
  prompts.restoreUnconfirmed(message);
}

function vendorIdentity(vendor) {
  var vendorAvatars = { claude: "/claude-code-avatar.png", codex: "/codex-avatar.png" };
  return {
    name: (vendor && VENDOR_NAMES[vendor]) || VENDOR_NAMES.claude,
    avatar: (vendor && vendorAvatars[vendor]) || vendorAvatars.claude,
  };
}

// --- Plan mode rendering ---
export function renderPlanBanner(type) {
  ctx.finalizeAssistantBlock();
  stopThinking();
  closeToolGroup();

  var el = document.createElement("div");
  el.className = "plan-banner";

  if (type === "enter") {
    inPlanMode = true;
    planContent = null;
    currentPlanCardEl = null;
    el.innerHTML =
      '<span class="plan-banner-icon">' + iconHtml("map") + '</span>' +
      '<span class="plan-banner-text">Entered plan mode</span>' +
      '<span class="plan-banner-hint">Exploring codebase and designing implementation...</span>';
    el.classList.add("plan-enter");
  } else {
    inPlanMode = false;
    el.innerHTML =
      '<span class="plan-banner-icon">' + iconHtml("check-circle") + '</span>' +
      '<span class="plan-banner-text">Plan ready for review</span>';
    el.classList.add("plan-exit");
  }

  ctx.addToMessages(el);
  refreshIcons(el);
  maybeScrollToBottom();
  return el;
}

export function renderPlanCard(content) {
  ctx.finalizeAssistantBlock();
  closeToolGroup();
  planContent = content;

  var el = currentPlanCardEl && currentPlanCardEl.isConnected ? currentPlanCardEl : null;
  var header;
  var body;
  var isNew = !el;
  if (!el) {
    el = document.createElement("div");
    el.className = "plan-card";

    header = document.createElement("div");
    header.className = "plan-card-header";
    header.innerHTML =
      '<span class="plan-card-icon">' + iconHtml("file-text") + '</span>' +
      '<span class="plan-card-title">Implementation Plan</span>' +
      '<button class="plan-card-copy" title="Copy plan">' + iconHtml("copy") + '</button>' +
      '<span class="plan-card-chevron">' + iconHtml("chevron-down") + '</span>';

    body = document.createElement("div");
    body.className = "plan-card-body";

    header.addEventListener("click", function () {
      el.classList.toggle("collapsed");
    });

    el.appendChild(header);
    el.appendChild(body);
    ctx.addToMessages(el);
    currentPlanCardEl = el;
  } else {
    header = el.querySelector(".plan-card-header");
    body = el.querySelector(".plan-card-body");
  }

  body.innerHTML = renderMarkdown(content);
  highlightCodeBlocks(body);
  renderMermaidBlocks(body);

  var copyBtn = header.querySelector(".plan-card-copy");
  if (copyBtn) {
    copyBtn.onclick = function (e) {
      e.stopPropagation();
      copyToClipboard(content).then(function () {
        copyBtn.innerHTML = iconHtml("check");
        refreshIcons(copyBtn);
        setTimeout(function () {
          copyBtn.innerHTML = iconHtml("copy");
          refreshIcons(copyBtn);
        }, 1500);
      });
    };
  }

  refreshIcons(el);
  if (isNew) maybeScrollToBottom();
  return el;
}

// --- Todo rendering ---
function todoStatusIcon(status) {
  switch (status) {
    case "completed": return iconHtml("check-circle");
    case "in_progress": return iconHtml("loader", "icon-spin");
    default: return iconHtml("circle");
  }
}

export function handleTodoWrite(input) {
  if (!input || !Array.isArray(input.todos)) return;
  todoMeta = normalizeTodoMeta(input.meta);
  todoItems = input.todos.map(function (t, i) {
    return {
      id: t.id || String(i + 1),
      content: t.content || t.subject || "",
      status: t.status || "pending",
      activeForm: t.activeForm || "",
    };
  });
  // A fresh TodoWrite during replay is just historical state. After replay
  // ends, applyDeadSessionTodoCompaction (called from history_done) decides
  // whether to compact. During live operation, sessionIsProcessing is true
  // and applyDeadSessionTodoCompaction is a no-op for compaction.
  renderTodoWidget();
  applyDeadSessionTodoCompaction();
}

export function handleTaskCreate(input) {
  if (!input) return;
  todoMeta = normalizeTodoMeta();
  var id = String(todoItems.length + 1);
  todoItems.push({
    id: id,
    content: input.subject || input.description || "",
    status: "pending",
    activeForm: input.activeForm || "",
  });
  renderTodoWidget();
}

export function handleTaskUpdate(input) {
  if (!input || !input.taskId) return;
  todoMeta = normalizeTodoMeta();
  for (var i = 0; i < todoItems.length; i++) {
    if (todoItems[i].id === input.taskId) {
      if (input.status === "deleted") {
        todoItems.splice(i, 1);
      } else {
        if (input.status) todoItems[i].status = input.status;
        if (input.subject) todoItems[i].content = input.subject;
        if (input.activeForm) todoItems[i].activeForm = input.activeForm;
      }
      break;
    }
  }
  renderTodoWidget();
}

function normalizeTodoMeta(meta) {
  if (meta && meta.variant === "plan") {
    return {
      variant: "plan",
      title: "Plan",
      icon: "map",
      showProgress: false,
      showCompletedCount: false,
      stickyEnabled: false,
    };
  }
  return {
    variant: "tasks",
    title: "Tasks",
    icon: "list-checks",
    showProgress: true,
    showCompletedCount: true,
    stickyEnabled: true,
  };
}

function renderTodoWidget() {
  if (todoItems.length === 0) {
    if (todoWidgetEl) { todoWidgetEl.remove(); todoWidgetEl = null; }
    if (todoObserver) { todoObserver.disconnect(); todoObserver = null; }
    todoWidgetVisible = true;
    todoMeta = normalizeTodoMeta();
    updateTodoSticky();
    return;
  }

  var isNew = !todoWidgetEl;
  if (isNew) {
    todoWidgetEl = document.createElement("div");
    todoWidgetEl.className = "todo-widget";
  }
  todoWidgetEl.className = "todo-widget"
    + (todoMeta.variant === "plan" ? " todo-widget-plan" : "")
    + (todoDeadCompact ? " todo-widget-dead-compact" : "");

  var completed = 0;
  for (var i = 0; i < todoItems.length; i++) {
    if (todoItems[i].status === "completed") completed++;
  }

  var countText = todoMeta.showCompletedCount
    ? (completed + "/" + todoItems.length)
    : (todoItems.length + " " + (todoItems.length === 1 ? "step" : "steps"));

  var html = '<div class="todo-header">' +
    '<span class="todo-header-icon">' + iconHtml(todoMeta.icon) + '</span>' +
    '<span class="todo-header-title">' + todoMeta.title + '</span>' +
    '<span class="todo-header-count">' + countText + '</span>' +
    '</div>';
  if (todoMeta.showProgress) {
    html += '<div class="todo-progress"><div class="todo-progress-bar" style="width:' +
      (todoItems.length > 0 ? Math.round(completed / todoItems.length * 100) : 0) + '%"></div></div>';
  }
  html += '<div class="todo-items">';
  for (var i = 0; i < todoItems.length; i++) {
    var t = todoItems[i];
    var statusClass = t.status === "completed" ? "completed" : t.status === "in_progress" ? "in-progress" : "pending";
    html += '<div class="todo-item ' + statusClass + '">' +
      '<span class="todo-item-icon">' + todoStatusIcon(t.status) + '</span>' +
      '<span class="todo-item-text">' + escapeHtml(t.status === "in_progress" && t.activeForm ? t.activeForm : t.content) + '</span>' +
      '</div>';
  }
  html += '</div>';

  todoWidgetEl.innerHTML = html;

  if (isNew) {
    ctx.addToMessages(todoWidgetEl);
    setupTodoObserver();
    // Click-to-expand for compact mode. Toggling the override class lets
    // the user inspect items without permanently un-compacting the widget.
    todoWidgetEl.addEventListener("click", function (e) {
      if (!todoWidgetEl.classList.contains("todo-widget-dead-compact")) return;
      // Only expand on header click, not on items inside an already-expanded view
      var header = e.target.closest(".todo-header");
      if (!header) return;
      todoWidgetEl.classList.toggle("todo-widget-dead-expanded");
    });
  }
  updateTodoSticky();
  refreshIcons(todoWidgetEl);
  maybeScrollToBottom();
}

export function applyDeadSessionTodoCompaction() {
  // Called after history_done and on status changes. Decides whether the
  // current session is "dead" (resumed, no live SDK process) and whether
  // the todo widget has unfinished items that will never resolve.
  var isLive = !!store.get('sessionIsProcessing');
  var hasUnfinished = false;
  for (var i = 0; i < todoItems.length; i++) {
    var s = todoItems[i].status;
    if (s === "in_progress" || s === "pending") { hasUnfinished = true; break; }
  }
  todoDeadCompact = !isLive && hasUnfinished;
  if (todoWidgetEl) {
    todoWidgetEl.classList.toggle("todo-widget-dead-compact", todoDeadCompact);
    if (!todoDeadCompact) todoWidgetEl.classList.remove("todo-widget-dead-expanded");
  }
}

function setupTodoObserver() {
  if (todoObserver) { todoObserver.disconnect(); todoObserver = null; }
  if (!todoWidgetEl) return;

  var messagesEl = document.getElementById("messages");
  if (!messagesEl) return;

  todoObserver = new IntersectionObserver(function (entries) {
    todoWidgetVisible = entries[0].isIntersecting;
    updateTodoStickyVisibility();
  }, { root: messagesEl, threshold: 0 });

  todoObserver.observe(todoWidgetEl);
}

function updateTodoStickyVisibility() {
  var stickyEl = document.getElementById("todo-sticky");
  if (!stickyEl) return;
  if (!todoMeta.stickyEnabled) {
    stickyEl.classList.add("hidden");
    return;
  }

  if (todoWidgetVisible) {
    stickyEl.classList.add("hidden");
  } else {
    // Only show if there are active (non-completed) tasks
    var hasActive = false;
    for (var i = 0; i < todoItems.length; i++) {
      if (todoItems[i].status !== "completed") { hasActive = true; break; }
    }
    if (hasActive) {
      stickyEl.classList.remove("hidden");
    }
  }
}

function updateTodoSticky() {
  var stickyEl = document.getElementById("todo-sticky");
  if (!stickyEl) return;
  if (!todoMeta.stickyEnabled) {
    stickyEl.classList.add("hidden");
    stickyEl.innerHTML = "";
    return;
  }

  // Hide if no active tasks (all completed or empty)
  var hasActive = false;
  for (var i = 0; i < todoItems.length; i++) {
    if (todoItems[i].status !== "completed") { hasActive = true; break; }
  }
  if (!hasActive) {
    stickyEl.classList.add("hidden");
    return;
  }

  var completed = 0;
  for (var i = 0; i < todoItems.length; i++) {
    if (todoItems[i].status === "completed") completed++;
  }
  var pct = Math.round(completed / todoItems.length * 100);
  var wasCollapsed = stickyEl.innerHTML === "" ? true : stickyEl.classList.contains("collapsed");

  var inProgressItem = null;
  for (var j = 0; j < todoItems.length; j++) {
    if (todoItems[j].status === "in_progress") { inProgressItem = todoItems[j]; break; }
  }

  var html = '<div class="todo-sticky-inner">' +
    '<div class="todo-sticky-header">' +
    '<span class="todo-sticky-icon">' + iconHtml("list-checks") + '</span>' +
    '<span class="todo-sticky-title">Tasks</span>' +
    (inProgressItem ? '<span class="todo-sticky-active">' + iconHtml("loader", "icon-spin") + ' ' + escapeHtml(inProgressItem.activeForm || inProgressItem.content) + '</span>' : '') +
    '<span class="todo-sticky-count">' + completed + '/' + todoItems.length + '</span>' +
    '<span class="todo-sticky-chevron">' + iconHtml("chevron-down") + '</span>' +
    '</div>' +
    '<div class="todo-sticky-progress"><div class="todo-sticky-progress-bar" style="width:' + pct + '%"></div></div>' +
    '<div class="todo-sticky-items">';

  for (var i = 0; i < todoItems.length; i++) {
    var t = todoItems[i];
    var statusClass = t.status === "completed" ? "completed" : t.status === "in_progress" ? "in-progress" : "pending";
    html += '<div class="todo-sticky-item ' + statusClass + '">' +
      '<span class="todo-sticky-item-icon">' + todoStatusIcon(t.status) + '</span>' +
      '<span class="todo-sticky-item-text">' + escapeHtml(t.status === "in_progress" && t.activeForm ? t.activeForm : t.content) + '</span>' +
      '</div>';
  }

  html += '</div></div>';
  stickyEl.innerHTML = html;

  // Only show sticky when in-chat widget is not visible in viewport
  if (todoWidgetVisible) {
    stickyEl.classList.add("hidden");
  } else {
    stickyEl.classList.remove("hidden");
  }
  if (wasCollapsed) stickyEl.classList.add("collapsed");

  stickyEl.querySelector(".todo-sticky-header").addEventListener("click", function () {
    stickyEl.classList.toggle("collapsed");
  });

  refreshIcons(stickyEl);
}

// --- Thinking ---
export function startThinking() {
  ctx.finalizeAssistantBlock();

  // Reuse existing thinking group if consecutive
  if (thinkingGroup && thinkingGroup.el.classList.contains("done")) {
    var el = thinkingGroup.el;
    el.classList.remove("done");
    el.querySelector(".thinking-content").textContent = "";
    currentThinking = { el: el, fullText: "", startTime: Date.now() };
    refreshIcons(el);
    maybeScrollToBottom();
    return;
  }

  var el = document.createElement("div");
  el.className = "thinking-item";

  el.innerHTML =
    '<div class="thinking-header">' +
    '<span class="thinking-chevron">' + iconHtml("chevron-right") + '</span>' +
    '<span class="thinking-label">Thinking</span>' +
    '<span class="thinking-duration"></span>' +
    '<span class="thinking-spinner">' + iconHtml("loader", "icon-spin") + '</span>' +
    '</div>' +
    '<div class="thinking-content"></div>';

  el.querySelector(".thinking-header").addEventListener("click", function () {
    el.classList.toggle("expanded");
  });

  ctx.addToMessages(el);
  refreshIcons(el);
  maybeScrollToBottom();
  thinkingGroup = { el: el, count: 0, totalDuration: 0 };
  currentThinking = { el: el, fullText: "", startTime: Date.now() };
}

export function appendThinking(text) {
  if (!currentThinking) return;
  currentThinking.fullText += text;
  currentThinking.el.querySelector(".thinking-content").textContent = currentThinking.fullText;
  maybeScrollToBottom();
}

export function stopThinking(duration) {
  if (!currentThinking) return;
  var secs = typeof duration === "number" ? duration : (Date.now() - currentThinking.startTime) / 1000;
  currentThinking.el.classList.add("done");
  if (thinkingGroup && thinkingGroup.el === currentThinking.el) {
    thinkingGroup.count++;
    thinkingGroup.totalDuration += secs;
    currentThinking.el.querySelector(".thinking-duration").textContent = " " + thinkingGroup.totalDuration.toFixed(1) + "s";
  } else {
    currentThinking.el.querySelector(".thinking-duration").textContent = " " + secs.toFixed(1) + "s";
  }
  // If no thinking text was streamed (e.g. Codex reasoning items arrive
  // with encrypted/hidden content, or Claude without extended-thinking),
  // the expand affordance is misleading because there's nothing inside.
  // Strip the chevron and the click handler so the header reads as a
  // plain label.
  var hasContent = !!(currentThinking.fullText && currentThinking.fullText.length > 0);
  if (!hasContent) {
    currentThinking.el.classList.add("empty");
    var chev = currentThinking.el.querySelector(".thinking-chevron");
    if (chev) chev.style.display = "none";
    var hdr = currentThinking.el.querySelector(".thinking-header");
    if (hdr) {
      hdr.style.cursor = "default";
      // Replace click listener by cloning the node (cheapest way to strip listeners).
      var clone = hdr.cloneNode(true);
      hdr.parentNode.replaceChild(clone, hdr);
    }
  }
  currentThinking = null;
}

export function resetThinkingGroup() {
  thinkingGroup = null;
}

// --- Tool items ---
export function createToolItem(id, name) {
  ctx.finalizeAssistantBlock();
  stopThinking();

  // Group management: create new group or reuse existing open group
  if (!currentToolGroup || currentToolGroup.closed) {
    toolGroupCounter++;
    var groupEl = document.createElement("div");
    groupEl.className = "tool-group";
    groupEl.dataset.groupId = "g" + toolGroupCounter;

    var toolGroupInner =
      '<div class="tool-group-header" style="display:none">' +
      '<span class="tool-group-chevron">' + iconHtml("chevron-right") + '</span>' +
      '<span class="tool-group-bullet"></span>' +
      '<span class="tool-group-label">Running...</span>' +
      '<span class="tool-group-status-icon">' + iconHtml("loader", "icon-spin") + '</span>' +
      '</div>' +
      '<div class="tool-group-items"></div>';

    groupEl.innerHTML = toolGroupInner;

    groupEl.querySelector(".tool-group-header").addEventListener("click", function () {
      groupEl.classList.toggle("collapsed");
      if (currentToolGroup) currentToolGroup.userToggled = true;
    });

    ctx.addToMessages(groupEl);
    refreshIcons(groupEl);

    currentToolGroup = {
      el: groupEl,
      id: "g" + toolGroupCounter,
      toolNames: [],
      toolCount: 0,
      doneCount: 0,
      errorCount: 0,
      closed: false,
    };
    toolGroups[currentToolGroup.id] = currentToolGroup;
  }

  var el = document.createElement("div");
  el.className = "tool-item";
  el.dataset.toolId = id;
  el.innerHTML =
    '<div class="tool-header">' +
    '<span class="tool-chevron">' + iconHtml("chevron-right") + '</span>' +
    '<span class="tool-bullet"></span>' +
    '<span class="tool-name"></span>' +
    '<span class="tool-desc"></span>' +
    '<span class="tool-status-icon">' + iconHtml("loader", "icon-spin") + '</span>' +
    '</div>' +
    '<div class="tool-subtitle">' +
    '<span class="tool-connector">&#9492;</span>' +
    '<span class="tool-subtitle-text">Running...</span>' +
    '</div>';

  el.querySelector(".tool-name").textContent = name;

  // Append to group instead of messages directly
  currentToolGroup.el.querySelector(".tool-group-items").appendChild(el);
  currentToolGroup.toolNames.push(name);
  currentToolGroup.toolCount++;
  updateToolGroupHeader(currentToolGroup);

  refreshIcons(el);
  maybeScrollToBottom();

  tools[id] = { el: el, name: name, input: null, done: false, groupId: currentToolGroup.id };
}

export function updateToolExecuting(id, name, input) {
  var tool = tools[id];
  if (!tool) return;

  tool.input = input;
  var descEl = tool.el.querySelector(".tool-desc");
  descEl.textContent = toolSummary(name, input);

  // Make file path clickable for Read/Edit/Write tools
  var filePath = input && input.file_path;
  if (filePath && (name === "Read" || name === "Edit" || name === "Write")) {
    descEl.classList.add("tool-desc-link");
    descEl.dataset.filePath = filePath;
    descEl.insertAdjacentHTML("beforeend", '<span class="tool-desc-link-icon">' + iconHtml("external-link") + '</span>');
    refreshIcons(descEl);
    (function (toolName, toolInput) {
      descEl.onclick = function (e) {
        e.stopPropagation();
        if (toolName === "Edit" && toolInput && (toolInput.old_string || toolInput.new_string)) {
          openFile(filePath, { diff: { oldStr: toolInput.old_string || "", newStr: toolInput.new_string || "" } });
        } else {
          openFile(filePath);
        }
      };
    })(name, input);
  }

  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = toolActivityText(name, input);

  maybeScrollToBottom();
}

// Shared chrome (filename header + unified/split toggle) for diff renderings.
// makeUnified and makeSplit are factories that return a fresh body element.
function buildDiffChrome(filePath, linkOldStr, linkNewStr, makeUnified, makeSplit) {
  var wrapper = document.createElement("div");
  wrapper.className = "edit-diff";

  var header = document.createElement("div");
  header.className = "edit-diff-header";

  var pathSpan = document.createElement("span");
  pathSpan.className = "edit-diff-path edit-diff-path-link";
  pathSpan.textContent = filePath || "";
  if (filePath) {
    (function (fp, os, ns) {
      pathSpan.addEventListener("click", function (e) {
        e.stopPropagation();
        openFile(fp, { diff: { oldStr: os || "", newStr: ns || "" } });
      });
    })(filePath, linkOldStr, linkNewStr);
  }
  header.appendChild(pathSpan);

  var isMobile = "ontouchstart" in window;
  var isSplit = false;

  var unifiedBtn = document.createElement("button");
  unifiedBtn.className = "edit-diff-toggle active";
  unifiedBtn.innerHTML = iconHtml("list");
  unifiedBtn.title = "Unified view";

  var splitBtn = document.createElement("button");
  splitBtn.className = "edit-diff-toggle";
  splitBtn.innerHTML = iconHtml("columns-2");
  splitBtn.title = "Split view";

  var toggleWrap = document.createElement("span");
  toggleWrap.className = "edit-diff-toggles";
  if (isMobile) toggleWrap.style.display = "none";
  toggleWrap.appendChild(unifiedBtn);
  toggleWrap.appendChild(splitBtn);
  header.appendChild(toggleWrap);

  wrapper.appendChild(header);

  var currentBody = makeUnified();
  wrapper.appendChild(currentBody);

  unifiedBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (!isSplit) return;
    isSplit = false;
    unifiedBtn.classList.add("active");
    splitBtn.classList.remove("active");
    wrapper.removeChild(currentBody);
    currentBody = makeUnified();
    wrapper.appendChild(currentBody);
    refreshIcons(wrapper);
  });

  splitBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (isSplit) return;
    isSplit = true;
    splitBtn.classList.add("active");
    unifiedBtn.classList.remove("active");
    wrapper.removeChild(currentBody);
    currentBody = makeSplit();
    wrapper.appendChild(currentBody);
    refreshIcons(wrapper);
  });

  return wrapper;
}

function renderEditDiff(oldStr, newStr, filePath) {
  var lang = getLanguageFromPath(filePath);
  return buildDiffChrome(
    filePath,
    oldStr,
    newStr,
    function () { return renderUnifiedDiff(oldStr, newStr, lang); },
    function () { return renderSplitDiff(oldStr, newStr, lang); }
  );
}

function renderPatchDiffBlock(patchText, filePath) {
  var lang = getLanguageFromPath(filePath);
  var sources = reconstructPatchSources(patchText);
  return buildDiffChrome(
    filePath,
    sources.oldStr,
    sources.newStr,
    function () { return renderPatchDiff(patchText, lang); },
    function () { return renderSplitDiff(sources.oldStr, sources.newStr, lang); }
  );
}

function isDiffContent(text) {
  var lines = text.split("\n");
  var hasHunkHeader = false;
  var hasPatchLine = false;
  for (var i = 0; i < Math.min(lines.length, 20); i++) {
    var l = lines[i];
    if (l.startsWith("@@")) hasHunkHeader = true;
    if (l.startsWith("---") || l.startsWith("+++")) hasPatchLine = true;
    if ((l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))) {
      hasPatchLine = true;
    }
  }
  return (hasHunkHeader && hasPatchLine) || hasPatchLine;
}

function getLanguageFromPath(filePath) {
  if (!filePath) return null;
  var parts = filePath.split("/");
  var filename = parts[parts.length - 1].toLowerCase();
  var dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1 || dotIdx === filename.length - 1) return null;
  var ext = filename.substring(dotIdx + 1);
  var map = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", mts: "typescript",
    py: "python", rb: "ruby", rs: "rust", go: "go",
    java: "java", kt: "kotlin", kts: "kotlin",
    cs: "csharp", cpp: "cpp", cc: "cpp", c: "c", h: "c", hpp: "cpp",
    css: "css", scss: "scss", less: "less",
    html: "xml", htm: "xml", xml: "xml", svg: "xml",
    json: "json", yaml: "yaml", yml: "yaml",
    md: "markdown", sh: "bash", bash: "bash", zsh: "bash",
    sql: "sql", swift: "swift", php: "php",
    toml: "ini", ini: "ini", conf: "ini",
    lua: "lua", r: "r", pl: "perl",
    ex: "elixir", exs: "elixir",
    erl: "erlang", hs: "haskell",
    graphql: "graphql", gql: "graphql",
  };
  return map[ext] || null;
}

function parseLineNumberedContent(text) {
  var lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) return null;

  var pattern = /^\s*(\d+)[→\t](.*)$/;
  var checkCount = Math.min(lines.length, 5);
  var matchCount = 0;
  for (var i = 0; i < checkCount; i++) {
    if (pattern.test(lines[i])) matchCount++;
  }
  if (matchCount < Math.ceil(checkCount * 0.6)) return null;

  var numbers = [];
  var code = [];
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(pattern);
    if (m) {
      numbers.push(m[1]);
      code.push(m[2]);
    } else {
      numbers.push("");
      code.push(lines[i]);
    }
  }
  return { numbers: numbers, code: code };
}

var IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

function isImagePath(filePath) {
  if (!filePath) return false;
  var dotIdx = filePath.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return IMAGE_EXTS.has(filePath.substring(dotIdx).toLowerCase());
}

export function updateToolResult(id, content, isError, images) {
  var tool = tools[id];
  if (!tool) return;

  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText && tool.input) {
    subtitleText.textContent = toolActivityText(tool.name, tool.input);
  }

  var resultBlock = document.createElement("div");
  var displayContent = content || "(no output)";
  displayContent = displayContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (displayContent.length > 10000) displayContent = displayContent.substring(0, 10000) + "\n... (truncated)";

  var hasEditDiff = !isError && tool.name === "Edit" && tool.input && tool.input.old_string && tool.input.new_string;
  var expandByDefault = hasEditDiff || (!isError && tool.name === "Edit" && isDiffContent(displayContent));
  if (expandByDefault) {
    resultBlock.className = "tool-result-block";
    tool.el.classList.add("expanded");
  } else {
    resultBlock.className = "tool-result-block collapsed";
  }

  if (hasEditDiff) {
    resultBlock.appendChild(renderEditDiff(tool.input.old_string, tool.input.new_string, tool.input.file_path));
  } else if (!isError && isDiffContent(displayContent)) {
    var patchFilePath = tool.input && tool.input.file_path ? tool.input.file_path : null;
    if (patchFilePath) {
      resultBlock.appendChild(renderPatchDiffBlock(displayContent, patchFilePath));
    } else {
      resultBlock.appendChild(renderPatchDiff(displayContent, null));
    }
  } else if (!isError && tool.name === "Read" && tool.input && tool.input.file_path && isImagePath(tool.input.file_path)) {
    // Image file: show inline preview
    var imgWrap = document.createElement("div");
    imgWrap.className = "tool-result-image";
    var img = document.createElement("img");
    if (images && images.length > 0) {
      img.src = "data:" + images[0].mediaType + ";base64," + images[0].data;
    } else {
      img.src = "api/file?path=" + encodeURIComponent(tool.input.file_path);
    }
    img.alt = tool.input.file_path.split("/").pop();
    img.draggable = false;
    img.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      if (ctx.showImageModal) ctx.showImageModal(this.src);
    });
    imgWrap.appendChild(img);
    resultBlock.appendChild(imgWrap);
    resultBlock.className = "tool-result-block";
    tool.el.classList.add("expanded");
  } else if (!isError && tool.name === "Read" && tool.input && tool.input.file_path) {
    var parsed = parseLineNumberedContent(displayContent);
    if (parsed) {
      var lang = getLanguageFromPath(tool.input.file_path);
      var viewer = document.createElement("div");
      viewer.className = "code-viewer";

      var gutter = document.createElement("pre");
      gutter.className = "code-gutter";
      gutter.textContent = parsed.numbers.join("\n");

      var codeBlock = document.createElement("pre");
      codeBlock.className = "code-content";
      var codeText = parsed.code.join("\n");

      if (lang) {
        try {
          var highlighted = hljs.highlight(codeText, { language: lang });
          var codeEl = document.createElement("code");
          codeEl.className = "hljs language-" + lang;
          codeEl.innerHTML = highlighted.value;
          codeBlock.appendChild(codeEl);
        } catch (e) {
          codeBlock.textContent = codeText;
        }
      } else {
        codeBlock.textContent = codeText;
      }

      viewer.appendChild(gutter);
      viewer.appendChild(codeBlock);

      // Sync vertical scroll between gutter and code
      viewer.addEventListener("scroll", function () {
        gutter.scrollTop = viewer.scrollTop;
        codeBlock.scrollTop = viewer.scrollTop;
      });

      resultBlock.appendChild(viewer);
    } else {
      var pre = document.createElement("pre");
      pre.textContent = displayContent;
      resultBlock.appendChild(pre);
    }
  } else {
    var pre = document.createElement("pre");
    if (isError) pre.className = "is-error";
    pre.textContent = displayContent;
    resultBlock.appendChild(pre);
  }
  tool.el.appendChild(resultBlock);

  tool.el.querySelector(".tool-header").addEventListener("click", function () {
    resultBlock.classList.toggle("collapsed");
    tool.el.classList.toggle("expanded");
  });

  markToolDone(id, isError);
  maybeScrollToBottom();
}

export function markToolDone(id, isError) {
  var tool = tools[id];
  if (!tool || tool.done) return;

  tool.done = true;
  if (!tool.el) return; // hidden tool (plan mode)

  tool.el.classList.add("done");
  if (isError) tool.el.classList.add("error");

  var icon = tool.el.querySelector(".tool-status-icon");
  if (isError) {
    icon.innerHTML = '<span class="err-icon">' + iconHtml("alert-triangle") + '</span>';
  } else {
    icon.innerHTML = '<span class="check">' + iconHtml("check") + '</span>';
  }
  refreshIcons(icon);

  // Update group state
  if (tool.groupId) {
    var group = findToolGroup(tool.groupId);
    if (group) {
      group.doneCount++;
      if (isError) group.errorCount++;
      updateToolGroupHeader(group);
    }
  }
}

export function markAllToolsDone() {
  for (var id in tools) {
    if (tools.hasOwnProperty(id) && !tools[id].done) {
      markToolDone(id, false);
    }
  }
}

// --- Sub-agent (Task tool) log ---

export function updateSubagentActivity(parentToolId, text) {
  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;

  // Update subtitle text with current activity
  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = text;

  // Update or create the subagent log
  var log = tool.el.querySelector(".subagent-log");
  if (!log) {
    log = document.createElement("div");
    log.className = "subagent-log";
    tool.el.appendChild(log);
  }

  maybeScrollToBottom();
}

export function addSubagentToolEntry(parentToolId, toolName, toolId, text) {
  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;

  // Update subtitle
  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = text;

  // Create log if needed
  var log = tool.el.querySelector(".subagent-log");
  if (!log) {
    log = document.createElement("div");
    log.className = "subagent-log";
    tool.el.appendChild(log);
  }

  // Add entry
  var entry = document.createElement("div");
  entry.className = "subagent-log-entry";
  entry.innerHTML =
    '<span class="subagent-log-bullet"></span>' +
    '<span class="subagent-log-tool"></span>' +
    '<span class="subagent-log-text"></span>';
  entry.querySelector(".subagent-log-tool").textContent = toolName;
  entry.querySelector(".subagent-log-text").textContent = text;
  log.appendChild(entry);

  // Auto-scroll to latest entry
  log.scrollTop = log.scrollHeight;

  maybeScrollToBottom();
}

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function fmtDuration(ms) {
  var secs = Math.floor(ms / 1000);
  if (secs >= 60) return Math.floor(secs / 60) + "m " + (secs % 60) + "s";
  return secs + "s";
}

export function updateSubagentProgress(parentToolId, usage, lastToolName, summary) {
  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;
  var progressEl = tool.el.querySelector(".subagent-progress");
  if (!progressEl) {
    progressEl = document.createElement("div");
    progressEl.className = "subagent-progress";
    var log = tool.el.querySelector(".subagent-log");
    if (log) tool.el.insertBefore(progressEl, log);
    else tool.el.appendChild(progressEl);
  }
  var parts = [];
  if (usage) {
    if (usage.total_tokens) parts.push(fmtTokens(usage.total_tokens) + " tokens");
    if (usage.tool_uses) parts.push(usage.tool_uses + " tools");
    if (usage.duration_ms) parts.push(fmtDuration(usage.duration_ms));
  }
  if (lastToolName) parts.push(lastToolName);
  progressEl.textContent = parts.join(" · ");

  // AI-generated progress summary (agentProgressSummaries)
  if (summary) {
    var summaryEl = tool.el.querySelector(".subagent-summary");
    if (!summaryEl) {
      summaryEl = document.createElement("div");
      summaryEl.className = "subagent-summary";
      progressEl.parentNode.insertBefore(summaryEl, progressEl.nextSibling);
    }
    summaryEl.textContent = summary;
  }
}

export function initSubagentStop(parentToolId, taskId) {
  activeSubagentToolIds[parentToolId] = true;
  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;
  var header = tool.el.querySelector(".tool-header");
  if (!header || header.querySelector(".subagent-stop-btn")) return;
  var btn = document.createElement("button");
  btn.className = "subagent-stop-btn";
  btn.textContent = "Stop";
  btn.addEventListener("click", function(e) {
    e.stopPropagation();
    if (ctx.ws) ctx.ws.send(JSON.stringify({ type: "stop_task", taskId: taskId, parentToolId: parentToolId }));
    btn.disabled = true;
    btn.textContent = "Stopping...";
  });
  header.appendChild(btn);
}

export function updateSubagentTaskStatus(parentToolId, patch) {
  if (patch.status === "failed" || patch.status === "killed") {
    delete activeSubagentToolIds[parentToolId];
  }
  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;
  if (patch.description) {
    var summaryEl = tool.el.querySelector(".subagent-summary");
    if (!summaryEl) {
      var progressEl = tool.el.querySelector(".subagent-progress");
      if (progressEl) {
        summaryEl = document.createElement("div");
        summaryEl.className = "subagent-summary";
        progressEl.parentNode.insertBefore(summaryEl, progressEl.nextSibling);
      }
    }
    if (summaryEl) summaryEl.textContent = patch.description;
  }
  if (patch.status === "failed" || patch.status === "killed") {
    var subtitleText = tool.el.querySelector(".tool-subtitle-text");
    if (subtitleText) subtitleText.textContent = patch.status === "failed" ? "Agent failed" : "Agent killed";
    var stopBtn = tool.el.querySelector(".subagent-stop-btn");
    if (stopBtn) stopBtn.remove();
  }
}

export function markSubagentDone(parentToolId, status, summary, usage) {
  delete activeSubagentToolIds[parentToolId];
  // lr-66c118: the lr-255e hasActiveSubagents()-gated setActivity clear
  // call is removed — setActivity collapses to ONE optimistic raise
  // (input.js). activeSubagentToolIds tracking itself is unchanged and
  // still governs the real per-tool subagent UI below.

  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;

  var label = "Agent finished";
  if (status === "failed") label = "Agent failed";
  else if (status === "stopped") label = "Agent stopped";

  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = label;

  // Remove stop button
  var stopBtn = tool.el.querySelector(".subagent-stop-btn");
  if (stopBtn) stopBtn.remove();

  // Final usage update
  if (usage) updateSubagentProgress(parentToolId, usage, null);
}

var _lastCumulativeCost = 0;

export function resetTurnMetaCost() {
  _lastCumulativeCost = 0;
}

export function addTurnMeta(cost, duration) {
  closeToolGroup();
  var div = document.createElement("div");
  div.className = "turn-meta";
  div.dataset.turn = ctx.turnCounter;
  var parts = [];
  if (cost != null) {
    // cost is cumulative total_cost_usd from the SDK.
    // When the SDK session restarts, total_cost_usd resets to 0 so cost
    // can drop below _lastCumulativeCost.  In that case the entire cost
    // value IS the delta for this turn (fresh SDK session).
    var delta = cost - _lastCumulativeCost;
    if (delta < 0) delta = cost;
    _lastCumulativeCost = cost;
    var deltaStr = delta > 0 ? "+$" + delta.toFixed(4) : "$0.0000";
    parts.push(deltaStr + " \u2192 $" + cost.toFixed(4));
  }
  if (duration != null) parts.push((duration / 1000).toFixed(1) + "s");
  if (parts.length) {
    div.textContent = parts.join(" \u00b7 ");
    ctx.addToMessages(div);
    maybeScrollToBottom();
  }
}

// --- Tool group exports ---
export { closeToolGroup };

export function removeToolFromGroup(toolId) {
  var tool = tools[toolId];
  if (!tool || !tool.groupId) return;
  var group = findToolGroup(tool.groupId);
  if (!group) return;
  group.toolCount--;
  // Remove tool name from the names array (remove first occurrence)
  var idx = group.toolNames.indexOf(tool.name);
  if (idx !== -1) group.toolNames.splice(idx, 1);
  if (tool.done) group.doneCount--;
  updateToolGroupHeader(group);
}

// Expose state getters and reset
export function getTools() { return tools; }
export function isInPlanMode() { return inPlanMode; }
export function getPlanContent() { return planContent; }
export function setPlanContent(c) { planContent = c; }
export function isPlanFilePath(fp) { return isPlanFile(fp); }
export function getPlanModeTools() { return PLAN_MODE_TOOLS; }
export function getTodoTools() { return TODO_TOOLS; }
export function getHiddenResultTools() { return HIDDEN_RESULT_TOOLS; }

export function saveToolState() {
  return {
    tools: tools,
    currentThinking: currentThinking,
    todoWidgetEl: todoWidgetEl,
    todoMeta: todoMeta,
    inPlanMode: inPlanMode,
    planContent: planContent,
    currentPlanCardEl: currentPlanCardEl,
    currentToolGroup: currentToolGroup,
    toolGroupCounter: toolGroupCounter,
    toolGroups: toolGroups,
    lastCumulativeCost: _lastCumulativeCost,
  };
}

export function restoreToolState(saved) {
  tools = saved.tools;
  currentThinking = saved.currentThinking;
  todoWidgetEl = saved.todoWidgetEl;
  todoMeta = saved.todoMeta || normalizeTodoMeta();
  inPlanMode = saved.inPlanMode;
  planContent = saved.planContent;
  currentPlanCardEl = saved.currentPlanCardEl || null;
  currentToolGroup = saved.currentToolGroup;
  toolGroupCounter = saved.toolGroupCounter;
  toolGroups = saved.toolGroups;
  _lastCumulativeCost = saved.lastCumulativeCost || 0;
  if (todoWidgetEl) {
    setupTodoObserver();
  }
}

export function resetToolState() {
  tools = {};
  currentThinking = null;
  thinkingGroup = null;
  inPlanMode = false;
  planContent = null;
  currentPlanCardEl = null;
  todoItems = [];
  todoMeta = normalizeTodoMeta();
  todoWidgetEl = null;
  todoWidgetVisible = true;
  if (todoObserver) { todoObserver.disconnect(); todoObserver = null; }
  currentToolGroup = null;
  toolGroupCounter = 0;
  toolGroups = {};
  activeSubagentToolIds = {};
  // NOTE: do NOT reset _lastCumulativeCost here — it must persist across
  // turns so addTurnMeta can compute per-turn deltas.  It is only cleared
  // on new conversation via resetTurnMetaCost().
  var stickyEl = document.getElementById("todo-sticky");
  if (stickyEl) { stickyEl.classList.add("hidden"); stickyEl.innerHTML = ""; }
}

export function initTools(_ctx) {
  ctx = _ctx;
}

