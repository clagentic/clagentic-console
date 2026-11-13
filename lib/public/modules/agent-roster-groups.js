// agent-roster-groups.js - the three groups the Team view's Agents section is
// drawn in, and the leading mark of a row that has no operator-chosen avatar.
//
// The server (lib/agent-roster.js) says which group each identity belongs to,
// read from what the vendors reported (lib/vendor-catalog.js); nothing here
// names a model, a helper or a vendor. An entry whose group is missing or
// unknown is a named agent, so nothing is ever dropped from the view.
//
// DOM-light: builders only, no app state, no icon library import. The caller
// resolves the <i data-lucide> placeholders with refreshIcons once placed.

export var GROUP = { AGENT: "agent", HELPER: "helper", MODEL: "model" };

// Named agents are always open; the other two groups start collapsed.
export var GROUPS = [
  { id: GROUP.AGENT, title: "Named agents", collapsible: false },
  { id: GROUP.HELPER, title: "Built-in helpers", collapsible: true },
  { id: GROUP.MODEL, title: "Models", collapsible: true },
];

// The glyph a row with no chosen avatar and no vendor logo shows, per group.
var GLYPH_ICON = { helper: "wrench", model: "cpu", agent: "bot" };

/** Splits the roster into {agent, helper, model}, keeping each list's order. */
export function partitionRoster(agents) {
  var out = { agent: [], helper: [], model: [] };
  (Array.isArray(agents) ? agents : []).forEach(function (a) {
    var group = a && (a.group === GROUP.HELPER || a.group === GROUP.MODEL) ? a.group : GROUP.AGENT;
    out[group].push(a);
  });
  return out;
}

/**
 * What a redraw depends on: each agent's key, avatar choice, group and vendor
 * (the vendor picks a model's logo), without the sighting times that change on
 * every use. While a picker is open, a roster that differs only in times does
 * not redraw it, so a seed being typed is not lost.
 */
export function choicesSignature(list) {
  return JSON.stringify((list || []).map(function (a) { return [a.key, a.avatar || null, a.group || null, a.vendor || null]; }));
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * The mark of a helper or model row that has no chosen avatar: a model shows the
 * logo of the vendor whose list held it (logoUrl, from the agent registry), and
 * falls back to a neutral chip icon when the registry holds none; a helper shows
 * the neutral tool icon, never the robot.
 * @param {string} group  "helper" or "model"
 * @param {?string} logoUrl
 * @param {number} size
 */
export function buildGroupMark(group, logoUrl, size) {
  if (group === GROUP.MODEL && logoUrl) {
    var img = el("img", "ar-avatar ar-logo");
    img.alt = "";
    img.width = size;
    img.height = size;
    img.src = logoUrl;
    img.setAttribute("data-ar-mark", "logo");
    return img;
  }
  var glyph = el("span", "ar-avatar ar-glyph");
  glyph.setAttribute("data-ar-mark", group === GROUP.HELPER ? "tool" : "neutral");
  glyph.setAttribute("role", "img");
  var icon = document.createElement("i");
  icon.setAttribute("data-lucide", GLYPH_ICON[group] || GLYPH_ICON.agent);
  glyph.appendChild(icon);
  return glyph;
}

/**
 * The avatar of one row. A chosen avatar shows in every group (deps.chosen says
 * whether the operator picked one, deps.plain draws it); without one a named
 * agent keeps its seeded robot (deps.plain too), a helper shows the neutral tool
 * icon and a model the logo of the vendor whose list held it.
 * @param {{key: string, group?: string, vendor?: ?string}} agent
 * @param {number} size
 * @param {{chosen: function(string): boolean, plain: function(string, number): Element,
 *          logoFor: function(string): ?string}} deps
 */
export function buildRowAvatar(agent, size, deps) {
  var grouped = agent.group === GROUP.HELPER || agent.group === GROUP.MODEL;
  if (grouped && !deps.chosen(agent.key)) {
    return buildGroupMark(agent.group, agent.vendor ? deps.logoFor(agent.vendor) || null : null, size);
  }
  return deps.plain(agent.key, size);
}

/**
 * One group: a heading with its count, then its rows. A collapsible group is a
 * toggle button; its rows are only built when it is expanded.
 * @param {{id: string, title: string, collapsible: boolean}} group
 * @param {Array<Element>} rows
 * @param {{count: number, expanded: boolean, onToggle: function()}} state
 *   count is how many identities the group holds, shown even while collapsed
 */
export function buildGroupSection(group, rows, state) {
  var section = el("section", "ar-group ar-group-" + group.id);
  section.setAttribute("data-ar-group", group.id);
  var label = group.title + " (" + state.count + ")";
  if (group.collapsible) {
    var toggle = el("button", "ar-group-toggle", label);
    toggle.setAttribute("type", "button");
    toggle.setAttribute("aria-expanded", state.expanded ? "true" : "false");
    toggle.addEventListener("click", state.onToggle);
    section.appendChild(toggle);
  } else {
    section.appendChild(el("h3", "ar-group-title", label));
  }
  if (!group.collapsible || state.expanded) {
    var list = el("div", "ar-list");
    rows.forEach(function (row) { list.appendChild(row); });
    section.appendChild(list);
  }
  return section;
}
