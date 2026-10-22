// schedule-panel.js - the small panel the clock button opens: arm the next
// message to go once (in N minutes, or at a clock time) or on a repeat (every N
// minutes, until a clock time or for N times), and see, send now or cancel the
// session's armed scheduled inputs.
//
// Arming works as the minutes field always did: it sets what the next typed
// message is scheduled as; pressing Send in the composer sends it. The panel
// shows when it will go, "tomorrow" included, before anything is armed.
//
// The time logic is in schedule-time.js; this file only builds and updates the
// elements.

import { buildSchedule, inputSummary } from './schedule-time.js';

var ATTRS_MINUTES = { type: "number", min: "1", max: "1440", placeholder: "min" };

function make(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(className, attrs) {
  var input = make("input", className);
  Object.keys(attrs).forEach(function (k) { input.setAttribute(k, attrs[k]); });
  return input;
}

function labeled(text, input, trailing) {
  var row = make("label", "schedule-row");
  if (text) row.appendChild(make("span", "schedule-row-label", text));
  row.appendChild(input);
  if (trailing) row.appendChild(make("span", "schedule-row-unit", trailing));
  return row;
}

// deps: { anchorEl, getInputs() -> list, canArm() -> bool, onArm(spec),
//         onSendNow(id), onCancel(id), now()? }
export function createSchedulePanel(deps) {
  var now = deps.now || Date.now;
  var form = { mode: "once", onceBy: "in", inMinutes: "", at: "", everyMinutes: "", endBy: "until", until: "", count: "" };
  var el = null;
  var refs = {};
  var open = false;
  var outsideHandler = null;
  var keyHandler = null;

  function radio(name, value, onPick) {
    var r = field("schedule-radio", { type: "radio", name: "schedule-" + name, value: value });
    r.addEventListener("change", onPick);
    r.addEventListener("click", onPick);
    return r;
  }

  function bindText(input, key) {
    input.addEventListener("input", function () { form[key] = input.value; render(); });
  }

  function build() {
    el = make("div", "schedule-panel hidden");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Schedule a message");

    var tabs = make("div", "schedule-tabs");
    refs.tabs = {};
    [["once", "Once"], ["repeat", "Repeat"]].forEach(function (pair) {
      var tab = make("button", "schedule-tab", pair[1]);
      tab.setAttribute("type", "button");
      tab.addEventListener("click", function () { form.mode = pair[0]; render(); });
      refs.tabs[pair[0]] = tab;
      tabs.appendChild(tab);
    });
    el.appendChild(tabs);

    refs.once = make("div", "schedule-section");
    refs.inRadio = radio("once-by", "in", function () { form.onceBy = "in"; render(); });
    refs.inMinutes = field("schedule-inline-input", ATTRS_MINUTES);
    bindText(refs.inMinutes, "inMinutes");
    var inRow = labeled("", refs.inMinutes, "min from now");
    inRow.insertBefore(refs.inRadio, inRow.firstChild);
    inRow.insertBefore(make("span", "schedule-row-label", "In"), refs.inMinutes);
    refs.once.appendChild(inRow);
    refs.atRadio = radio("once-by", "at", function () { form.onceBy = "at"; render(); });
    refs.at = field("schedule-time-input", { type: "time" });
    bindText(refs.at, "at");
    var atRow = labeled("", refs.at);
    atRow.insertBefore(refs.atRadio, atRow.firstChild);
    atRow.insertBefore(make("span", "schedule-row-label", "At"), refs.at);
    refs.once.appendChild(atRow);
    el.appendChild(refs.once);

    refs.repeat = make("div", "schedule-section");
    refs.every = field("schedule-inline-input", ATTRS_MINUTES);
    bindText(refs.every, "everyMinutes");
    refs.repeat.appendChild(labeled("Every", refs.every, "min"));
    refs.untilRadio = radio("end-by", "until", function () { form.endBy = "until"; render(); });
    refs.until = field("schedule-time-input", { type: "time" });
    bindText(refs.until, "until");
    var untilRow = labeled("", refs.until);
    untilRow.insertBefore(refs.untilRadio, untilRow.firstChild);
    untilRow.insertBefore(make("span", "schedule-row-label", "Until"), refs.until);
    refs.repeat.appendChild(untilRow);
    refs.countRadio = radio("end-by", "count", function () { form.endBy = "count"; render(); });
    refs.count = field("schedule-inline-input", { type: "number", min: "1", max: "1000", placeholder: "times" });
    bindText(refs.count, "count");
    var countRow = labeled("", refs.count, "times");
    countRow.insertBefore(refs.countRadio, countRow.firstChild);
    countRow.insertBefore(make("span", "schedule-row-label", "For"), refs.count);
    refs.repeat.appendChild(countRow);
    refs.repeat.appendChild(make("div", "schedule-note", "A repeat always has an end."));
    el.appendChild(refs.repeat);

    refs.preview = make("div", "schedule-preview");
    el.appendChild(refs.preview);

    var actions = make("div", "schedule-actions");
    refs.arm = make("button", "schedule-arm", "Schedule");
    refs.arm.setAttribute("type", "button");
    refs.arm.addEventListener("click", function () {
      var built = buildSchedule(form, now());
      if (built.error || !deps.canArm()) return;
      deps.onArm(built.spec);
      close();
    });
    actions.appendChild(refs.arm);
    actions.appendChild(make("span", "schedule-hint", "Then type your message and press Send."));
    el.appendChild(actions);

    refs.listTitle = make("div", "schedule-list-title");
    el.appendChild(refs.listTitle);
    refs.list = make("div", "schedule-list");
    el.appendChild(refs.list);

    document.body.appendChild(el);
  }

  function blank() {
    if (form.mode === "once") return form.onceBy === "at" ? !form.at : !form.inMinutes;
    if (!form.everyMinutes) return true;
    return form.endBy === "count" ? !form.count : !form.until;
  }

  function render() {
    if (!el) return;
    refs.tabs.once.classList.toggle("active", form.mode === "once");
    refs.tabs.repeat.classList.toggle("active", form.mode === "repeat");
    refs.tabs.once.setAttribute("aria-pressed", String(form.mode === "once"));
    refs.tabs.repeat.setAttribute("aria-pressed", String(form.mode === "repeat"));
    refs.once.classList.toggle("hidden", form.mode !== "once");
    refs.repeat.classList.toggle("hidden", form.mode !== "repeat");
    refs.inRadio.checked = form.onceBy === "in";
    refs.atRadio.checked = form.onceBy === "at";
    refs.untilRadio.checked = form.endBy === "until";
    refs.countRadio.checked = form.endBy === "count";

    var canArm = deps.canArm();
    var built = buildSchedule(form, now());
    if (!canArm) {
      refs.preview.textContent = "This session has reached its limit of scheduled messages. Cancel one to add another.";
      refs.preview.classList.add("error");
    } else if (blank()) {
      refs.preview.textContent = "Choose when to send.";
      refs.preview.classList.remove("error");
    } else {
      refs.preview.textContent = built.error || built.summary;
      refs.preview.classList.toggle("error", !!built.error);
    }
    refs.arm.disabled = !canArm || blank() || !!built.error;
    renderList();
  }

  function renderList() {
    if (!el) return;
    var inputs = deps.getInputs();
    refs.listTitle.textContent = inputs.length ? "Scheduled for this session" : "";
    refs.list.innerHTML = "";
    inputs.forEach(function (input) {
      var row = make("div", "schedule-list-row");
      row.setAttribute("data-id", input.id);
      row.appendChild(make("span", "schedule-list-text", inputSummary(input, now())));
      var send = make("button", "scheduled-msg-send-now", "Send now");
      send.setAttribute("type", "button");
      send.addEventListener("click", function () { deps.onSendNow(input.id); });
      var cancel = make("button", "scheduled-msg-cancel", "Cancel");
      cancel.setAttribute("type", "button");
      cancel.addEventListener("click", function () { deps.onCancel(input.id); });
      var actions = make("span", "scheduled-msg-actions");
      actions.appendChild(send);
      actions.appendChild(make("span", "scheduled-msg-sep", "·"));
      actions.appendChild(cancel);
      row.appendChild(actions);
      refs.list.appendChild(row);
    });
  }

  function position() {
    var rect = deps.anchorEl && deps.anchorEl.getBoundingClientRect ? deps.anchorEl.getBoundingClientRect() : null;
    if (!rect) return;
    el.style.left = Math.max(8, rect.left) + "px";
    el.style.bottom = Math.max(8, window.innerHeight - rect.top + 8) + "px";
  }

  function openPanel() {
    if (!el) build();
    open = true;
    el.classList.remove("hidden");
    position();
    render();
    outsideHandler = function (ev) {
      if (el.contains(ev.target) || (deps.anchorEl && deps.anchorEl.contains(ev.target))) return;
      close();
    };
    keyHandler = function (ev) { if (ev.key === "Escape") close(); };
    document.addEventListener("mousedown", outsideHandler);
    document.addEventListener("keydown", keyHandler);
  }

  function close() {
    open = false;
    if (el) el.classList.add("hidden");
    if (outsideHandler) { document.removeEventListener("mousedown", outsideHandler); outsideHandler = null; }
    if (keyHandler) { document.removeEventListener("keydown", keyHandler); keyHandler = null; }
  }

  return {
    toggle: function () { if (open) close(); else openPanel(); },
    close: close,
    isOpen: function () { return open; },
    // The session's list or the cap changed: redraw if the panel is showing.
    refresh: function () { if (open) render(); },
  };
}
