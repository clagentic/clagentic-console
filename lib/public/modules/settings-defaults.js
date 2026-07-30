// settings-defaults.js — Shared rendering for model/mode/effort/thinking controls
// Used by both server-settings.js and project-settings.js

import { refreshIcons } from './icons.js';
import { isSonnetModel } from './model-families.js';

export var MODE_OPTIONS = [
  { value: "default", label: "Default", desc: "Claude asks for permission before running tools and editing files." },
  { value: "plan", label: "Plan", desc: "Claude creates a plan first and asks for approval before making changes." },
  { value: "acceptEdits", label: "Auto-accept edits", desc: "File edits are applied automatically. Claude still asks before running commands." },
];

export var EFFORT_LEVELS = [
  { value: "low", desc: "Quick, concise responses. Best for simple questions." },
  { value: "medium", desc: "Balanced responses with moderate reasoning. Good for most tasks." },
  { value: "high", desc: "Thorough responses with deeper analysis. Good for complex tasks." },
  { value: "max", desc: "Maximum reasoning depth. Best for the most difficult problems." },
];

export var THINKING_OPTIONS = [
  { value: "disabled", label: "Off", desc: "Disable extended thinking." },
  { value: "adaptive", label: "Adaptive", desc: "Claude decides when to use extended thinking." },
  { value: "budget", label: "Budget", desc: "Set a token budget for extended thinking." },
];

export var MODEL_DESCRIPTIONS = {
  // Claude families
  "default": "Automatically selects the best model for the task.",
  "sonnet": "Fast and capable. Great balance of speed and intelligence.",
  "haiku": "Fastest model. Best for quick tasks and simple questions.",
  "opus": "Highly capable. Best for complex reasoning and analysis.",
  "fable": "Anthropic's most capable model. Best for the hardest problems.",
  // Codex/OpenAI families
  "gpt-5.5": "Latest GPT-5.5. Frontier model for complex coding and agentic workflows.",
  "gpt-5.4": "GPT-5.4. Strong reasoning and agentic coding.",
  "gpt-5.4-mini": "Faster, lighter GPT-5.4 variant. Great for most coding tasks.",
  "gpt-5.3-codex": "GPT-5.3 Codex. Strong at agentic coding and tool use.",
  "gpt-5.3-codex-spark": "Lean GPT-5.3 Codex. Optimized for speed.",
  "gpt-5.2": "GPT-5.2. Solid all-around performance.",
};

export function getModelDesc(model) {
  if (!model) return "";
  var lower = (model.value || model).toLowerCase();
  // Exact match first to avoid "gpt-5.4" matching "gpt-5.4-mini"
  if (MODEL_DESCRIPTIONS[lower]) return MODEL_DESCRIPTIONS[lower];
  // Substring match for family names (e.g. "sonnet", "opus", "haiku")
  // Sort keys longest-first so more-specific keys win (gpt-5.3-codex-spark > gpt-5.3-codex)
  var keys = Object.keys(MODEL_DESCRIPTIONS).sort(function(a, b) { return b.length - a.length; });
  for (var i = 0; i < keys.length; i++) {
    if (lower.indexOf(keys[i]) !== -1) return MODEL_DESCRIPTIONS[keys[i]];
  }
  return "";
}

// isSonnetModel re-exported from ./model-families.js (lr-d91ecf) — the
// single shared family-detection module also consumed by app-panels.js.
// Re-exported (not just imported) because server-settings.js imports it
// from this module directly.
export { isSonnetModel };

// --- Render functions ---
// Each takes an element ID prefix (e.g. "ss" or "ps"), a send function, and state getters.

// lr-db0437: every model/mode picker surface must state the scope it
// applies to ("This session only" / "Default for new sessions in this
// project" / "Server default" / loop-scoped) — model-scope honesty was the
// point of this task, not just the plumbing fix. Single shared renderer so
// each surface (session chip, project settings, server settings, Ralph-loop,
// scheduler) gets identical markup/behavior; each call site just passes its
// own static scope string via opts.scopeLabel.
export function renderScopeLabel(prefix, scopeLabel) {
  var el = document.getElementById(prefix + "-model-scope");
  if (!el) return;
  if (scopeLabel) {
    el.textContent = scopeLabel;
    el.style.display = "";
  } else {
    el.style.display = "none";
  }
}

// lr-e03635: split a models array into { latest, older } tiers.
//
// Both vendor adapters attach isLatest per model at the source (Codex from
// model/list's "upgrade" field, Claude from runtime ID version-ordering — see
// lib/yoke/adapters/claude.js deriveClaudeLatestTiers). A model with no
// isLatest field at all (an older/unenriched shape) is treated as latest —
// never hidden by a field it doesn't carry.
//
// Single shared partition function so every picker surface (renderModelList
// below and app-panels.js's session-chip rebuildModelList) applies identical
// tiering logic.
export function splitModelsByTier(models) {
  var latest = [];
  var older = [];
  for (var i = 0; i < (models || []).length; i++) {
    var m = models[i];
    var isLatest = (m && typeof m === "object") ? (m.isLatest !== false) : true;
    if (isLatest) latest.push(m);
    else older.push(m);
  }
  return { latest: latest, older: older };
}

// Build one `.settings-model-item` row. Shared by the always-visible latest
// list and the collapsible older-models body so both render identically.
function buildModelItem(m, currentModel, listEl, opts) {
  var value = m.value || "";
  var label = m.displayName || value;
  var item = document.createElement("div");
  item.className = "settings-model-item" + (value === currentModel ? " active" : "");
  item.dataset.model = value;

  var nameSpan = document.createElement("span");
  nameSpan.className = "settings-model-name";
  nameSpan.textContent = label;
  item.appendChild(nameSpan);

  var desc = getModelDesc(value);
  if (desc) {
    var descSpan = document.createElement("span");
    descSpan.className = "settings-model-desc";
    descSpan.textContent = desc;
    item.appendChild(descSpan);
  }

  item.addEventListener("click", function () {
    opts.sendMsg(opts.modelMsgType, { model: value });
    var items = listEl.querySelectorAll(".settings-model-item");
    for (var j = 0; j < items.length; j++) items[j].classList.remove("active");
    item.classList.add("active");
    if (opts.onModelSelect) opts.onModelSelect(value);
  });

  return item;
}

/**
 * Build the "Use a specific version" disclosure: a free-text model ID input
 * plus a submit button, appended after the enumerated list. (lr-f22787)
 *
 * Why this exists: the vendor's model-enumeration API (Claude
 * `stream.supportedModels()`, confirmed against a live CLI probe — see
 * test/claude-model-capability-lr-af9d66.test.js LIVE_PROBE_MODELS) reports
 * exactly one entry per family — the current release — never prior versions,
 * even though a specific older version (e.g. a previous Opus release) is a
 * real, selectable, runnable model. The `claude` CLI's own `/model` command
 * can list and switch to those older versions because it accepts an
 * arbitrary model ID string and lets the backend validate it, not because it
 * has a richer enumeration source than the SDK exposes — `setModel(model?:
 * string)` / the `set_model` control request both take a free string with no
 * client-side allowlist (@anthropic-ai/claude-agent-sdk sdk.d.ts). This form
 * reproduces that exact path: whatever the user types is sent through the
 * same message type an enumerated-list click would use, so the runtime
 * itself is the source of truth on whether the ID is valid — never a
 * hardcoded table here.
 *
 * @param {string} currentModel
 * @param {object} opts - same opts passed to renderModelList (sendMsg, modelMsgType, onModelSelect)
 */
function buildCustomModelForm(currentModel, opts) {
  var wrap = document.createElement("div");
  wrap.className = "settings-custom-model-row";

  var input = document.createElement("input");
  input.type = "text";
  input.className = "settings-budget-input settings-custom-model-input";
  input.placeholder = "e.g. claude-opus-4-6";
  input.setAttribute("aria-label", "Model ID");
  input.spellcheck = false;

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "settings-btn-sm";
  btn.textContent = "Use";

  function submit() {
    var value = input.value.trim();
    if (!value) return;
    opts.sendMsg(opts.modelMsgType, { model: value });
    if (opts.onModelSelect) opts.onModelSelect(value);
  }

  btn.addEventListener("click", submit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });

  wrap.appendChild(input);
  wrap.appendChild(btn);
  return wrap;
}

/**
 * Render model list into `${prefix}-model-list`
 * @param {string} prefix - Element ID prefix
 * @param {object} opts - { models, currentModel, sendMsg, onModelSelect, scopeLabel }
 */
export function renderModelList(prefix, opts) {
  var listEl = document.getElementById(prefix + "-model-list");
  if (!listEl) return;

  renderScopeLabel(prefix, opts.scopeLabel);

  var models = opts.models || [];
  var currentModel = opts.currentModel || "";

  listEl.innerHTML = "";
  if (models.length === 0) {
    listEl.innerHTML = '<div style="font-size:13px;color:var(--text-dimmer);">No models available</div>';
    listEl.appendChild(buildCustomModelForm(currentModel, opts));
    return;
  }

  var tiers = splitModelsByTier(models);

  for (var i = 0; i < tiers.latest.length; i++) {
    listEl.appendChild(buildModelItem(tiers.latest[i], currentModel, listEl, opts));
  }

  // lr-e03635: empty-disclosure rule — if the vendor reports no older
  // models, the disclosure must be ABSENT, not present-and-empty.
  if (tiers.older.length > 0) {
    // Reuse the existing in-section collapsible "Advanced" disclosure pattern
    // (aria-expanded toggle + hidden body) rather than inventing a new one —
    // see lib/public/index.html's settings-advanced-memory-toggle/-body for
    // the reference implementation this mirrors.
    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "settings-older-models-toggle";
    toggle.setAttribute("aria-expanded", "false");

    var toggleLabel = document.createElement("span");
    toggleLabel.textContent = "Older models";
    toggle.appendChild(toggleLabel);

    var chevron = document.createElement("i");
    chevron.setAttribute("data-lucide", "chevron-right");
    chevron.className = "settings-adv-chevron";
    toggle.appendChild(chevron);

    var body = document.createElement("div");
    body.className = "settings-older-models-body hidden";

    for (var k = 0; k < tiers.older.length; k++) {
      body.appendChild(buildModelItem(tiers.older[k], currentModel, listEl, opts));
    }

    toggle.addEventListener("click", function () {
      var isOpen = !body.classList.contains("hidden");
      body.classList.toggle("hidden", isOpen);
      toggle.setAttribute("aria-expanded", String(!isOpen));
      chevron.style.transform = isOpen ? "" : "rotate(90deg)";
    });

    listEl.appendChild(toggle);
    listEl.appendChild(body);
  }

  // lr-f22787: always offer the free-text escape hatch, tiered list or not —
  // see buildCustomModelForm's doc comment for why this is required rather
  // than optional polish.
  var customToggle = document.createElement("button");
  customToggle.type = "button";
  customToggle.className = "settings-older-models-toggle";
  customToggle.setAttribute("aria-expanded", "false");

  var customToggleLabel = document.createElement("span");
  customToggleLabel.textContent = "Use a specific version";
  customToggle.appendChild(customToggleLabel);

  var customChevron = document.createElement("i");
  customChevron.setAttribute("data-lucide", "chevron-right");
  customChevron.className = "settings-adv-chevron";
  customToggle.appendChild(customChevron);

  var customBody = document.createElement("div");
  customBody.className = "settings-older-models-body hidden";
  customBody.appendChild(buildCustomModelForm(currentModel, opts));

  customToggle.addEventListener("click", function () {
    var isOpen = !customBody.classList.contains("hidden");
    customBody.classList.toggle("hidden", isOpen);
    customToggle.setAttribute("aria-expanded", String(!isOpen));
    customChevron.style.transform = isOpen ? "" : "rotate(90deg)";
  });

  listEl.appendChild(customToggle);
  listEl.appendChild(customBody);

  refreshIcons(listEl);
}

/**
 * Render mode list into `${prefix}-mode-list`
 */
export function renderModeList(prefix, opts) {
  var listEl = document.getElementById(prefix + "-mode-list");
  if (!listEl) return;

  var currentMode = opts.currentMode || "default";
  listEl.innerHTML = "";

  for (var i = 0; i < MODE_OPTIONS.length; i++) {
    (function (opt) {
      var item = document.createElement("div");
      item.className = "settings-model-item" + (opt.value === currentMode ? " active" : "");

      var nameSpan = document.createElement("span");
      nameSpan.className = "settings-model-name";
      nameSpan.textContent = opt.label;
      item.appendChild(nameSpan);

      var descSpan = document.createElement("span");
      descSpan.className = "settings-model-desc";
      descSpan.textContent = opt.desc;
      item.appendChild(descSpan);

      item.addEventListener("click", function () {
        opts.sendMsg(opts.modeMsgType, { mode: opt.value });
        var items = listEl.querySelectorAll(".settings-model-item");
        for (var j = 0; j < items.length; j++) items[j].classList.remove("active");
        item.classList.add("active");
      });

      listEl.appendChild(item);
    })(MODE_OPTIONS[i]);
  }
}

/**
 * Render effort bar into `${prefix}-effort-bar`
 */
export function renderEffortBar(prefix, opts) {
  var bar = document.getElementById(prefix + "-effort-bar");
  if (!bar) return;

  var currentEffort = opts.currentEffort || "medium";
  bar.innerHTML = "";

  for (var i = 0; i < EFFORT_LEVELS.length; i++) {
    (function (lvl) {
      var btn = document.createElement("button");
      btn.className = "settings-btn-option" + (lvl.value === currentEffort ? " active" : "");
      btn.textContent = lvl.value.charAt(0).toUpperCase() + lvl.value.slice(1);
      btn.title = lvl.desc;
      btn.addEventListener("click", function () {
        opts.sendMsg(opts.effortMsgType, { effort: lvl.value });
        var btns = bar.querySelectorAll(".settings-btn-option");
        for (var j = 0; j < btns.length; j++) btns[j].classList.remove("active");
        btn.classList.add("active");
      });
      bar.appendChild(btn);
    })(EFFORT_LEVELS[i]);
  }
}

/**
 * Render thinking bar into `${prefix}-thinking-bar`
 */
export function renderThinkingBar(prefix, opts) {
  var bar = document.getElementById(prefix + "-thinking-bar");
  if (!bar) return;

  var currentThinking = opts.currentThinking || "adaptive";
  var currentBudget = opts.currentThinkingBudget || 10000;
  var budgetRow = document.getElementById(prefix + "-thinking-budget-row");
  var budgetInput = document.getElementById(prefix + "-thinking-budget");
  bar.innerHTML = "";

  for (var i = 0; i < THINKING_OPTIONS.length; i++) {
    (function (opt) {
      var btn = document.createElement("button");
      btn.className = "settings-btn-option" + (opt.value === currentThinking ? " active" : "");
      btn.textContent = opt.label;
      btn.title = opt.desc;
      btn.addEventListener("click", function () {
        var msg = { thinking: opt.value };
        if (opt.value === "budget") {
          msg.budgetTokens = budgetInput ? parseInt(budgetInput.value, 10) || 10000 : 10000;
        }
        opts.sendMsg("set_thinking", msg);
        var btns = bar.querySelectorAll(".settings-btn-option");
        for (var j = 0; j < btns.length; j++) btns[j].classList.remove("active");
        btn.classList.add("active");
        if (budgetRow) budgetRow.style.display = opt.value === "budget" ? "" : "none";
      });
      bar.appendChild(btn);
    })(THINKING_OPTIONS[i]);
  }

  if (budgetRow) budgetRow.style.display = currentThinking === "budget" ? "" : "none";
  if (budgetInput) {
    budgetInput.value = currentBudget;
    budgetInput.addEventListener("change", function () {
      var val = Math.max(1024, Math.min(128000, parseInt(this.value, 10) || 10000));
      this.value = val;
      opts.sendMsg("set_thinking", { thinking: "budget", budgetTokens: val });
    });
  }
}

/**
 * Update beta card visibility and bind toggle
 */
export function renderBetaCard(prefix, opts) {
  var model = opts.overrideModel || opts.currentModel || "";
  var card = document.getElementById(prefix + "-beta-card");
  if (card) {
    card.style.display = isSonnetModel(model) ? "" : "none";
  }

  var toggle = document.getElementById(prefix + "-beta-1m");
  if (toggle) {
    var betas = opts.currentBetas || [];
    var hasBeta = false;
    for (var i = 0; i < betas.length; i++) {
      if (betas[i].indexOf("context-1m") !== -1) { hasBeta = true; break; }
    }
    toggle.checked = hasBeta;
    toggle.onchange = function () {
      var currentBetas = opts.currentBetas || [];
      var newBetas;
      if (this.checked) {
        newBetas = currentBetas.slice();
        newBetas.push("context-1m-2025-08-07");
      } else {
        newBetas = [];
        for (var j = 0; j < currentBetas.length; j++) {
          if (currentBetas[j].indexOf("context-1m") === -1) {
            newBetas.push(currentBetas[j]);
          }
        }
      }
      opts.sendMsg(opts.betasMsgType || "set_betas", { betas: newBetas });
    };
  }
}
