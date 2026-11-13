// vendor-catalog.js - what each agent vendor says it offers, kept as it was
// reported: the models it lists and the built-in helpers it ships, each entry
// tagged with the vendor that reported it.
//
// Nothing here names a model, a helper or a vendor. A vendor adapter calls
// report(vendor, {models, helpers}) with what its own listing call returned, so
// a model or helper a vendor newly reports is in the catalog and in every
// reader of it with no code change. A listing call that failed reports nothing:
// the catalog keeps what that vendor last reported (empty if it never did), and
// no built-in table is merged in to cover the gap.
//
// Readers: the Team view roster classifies identities with classify() (via
// lib/agent-roster.js), the browser receives snapshot() with the roster, and the
// model-family list is derived from the Claude alias entries (lib/model-families.js).

// models:  [{value, displayName?, resolvedModel?}]  a vendor's model list
// helpers: [{name, description?}]                  a vendor's built-in helper types
function cleanModels(list) {
  var out = [];
  var seen = Object.create(null);
  (Array.isArray(list) ? list : []).forEach(function (m) {
    var entry = typeof m === "string" ? { value: m } : m;
    if (!entry || typeof entry.value !== "string" || !entry.value || seen[entry.value]) return;
    seen[entry.value] = true;
    var clean = { value: entry.value };
    if (typeof entry.displayName === "string" && entry.displayName) clean.displayName = entry.displayName;
    if (typeof entry.resolvedModel === "string" && entry.resolvedModel) clean.resolvedModel = entry.resolvedModel;
    out.push(clean);
  });
  return out;
}

function cleanHelpers(list) {
  var out = [];
  var seen = Object.create(null);
  (Array.isArray(list) ? list : []).forEach(function (h) {
    var entry = typeof h === "string" ? { name: h } : h;
    if (!entry || typeof entry.name !== "string" || !entry.name || seen[entry.name]) return;
    seen[entry.name] = true;
    var clean = { name: entry.name };
    if (typeof entry.description === "string" && entry.description) clean.description = entry.description;
    out.push(clean);
  });
  return out;
}

function createVendorCatalog() {
  // vendor id -> {models, helpers}. Insertion order is report order.
  var vendors = new Map();
  var listeners = [];

  function notify() {
    listeners.slice().forEach(function (fn) {
      try { fn(); }
      catch (e) { console.error("[vendor-catalog] change hook failed:", e && e.message ? e.message : e); }
    });
  }

  // Replaces what a vendor reported for each part given (models and/or
  // helpers); a part left out is untouched. Returns true when the catalog changed.
  function report(vendor, parts) {
    if (typeof vendor !== "string" || !vendor || !parts || typeof parts !== "object") return false;
    var held = vendors.get(vendor) || { models: [], helpers: [] };
    var next = { models: held.models, helpers: held.helpers };
    if (Array.isArray(parts.models)) next.models = cleanModels(parts.models);
    if (Array.isArray(parts.helpers)) next.helpers = cleanHelpers(parts.helpers);
    var changed = !vendors.has(vendor) || JSON.stringify(next) !== JSON.stringify(held);
    if (!changed) return false;
    vendors.set(vendor, next);
    notify();
    return true;
  }

  // The reported data, copied: [{vendor, models, helpers}].
  function snapshot() {
    var out = [];
    vendors.forEach(function (held, vendor) {
      out.push({
        vendor: vendor,
        models: held.models.map(function (m) { return Object.assign({}, m); }),
        helpers: held.helpers.map(function (h) { return Object.assign({}, h); }),
      });
    });
    return out;
  }

  // The model entries one vendor reported (copies), [] when it reported none.
  function modelsOf(vendor) {
    var held = vendors.get(vendor);
    return held ? held.models.map(function (m) { return Object.assign({}, m); }) : [];
  }

  // What a roster identity is, by the vendor listings alone:
  //   {group: "model", vendor}   its key is a reported model value or resolved model
  //   {group: "helper", vendor}  isSubagent and its key is a reported helper name
  //   null                       the catalog does not know it (a named agent)
  // A model match wins over a helper match; the first vendor that reported the
  // key is the one named, so the vendor is the one whose list held it.
  function classify(key, isSubagent) {
    if (typeof key !== "string" || !key) return null;
    var found = null;
    vendors.forEach(function (held, vendor) {
      if (found && found.group === "model") return;
      for (var i = 0; i < held.models.length; i++) {
        if (held.models[i].value === key || held.models[i].resolvedModel === key) {
          found = { group: "model", vendor: vendor };
          return;
        }
      }
      if (found || !isSubagent) return;
      for (var j = 0; j < held.helpers.length; j++) {
        if (held.helpers[j].name === key) { found = { group: "helper", vendor: vendor }; return; }
      }
    });
    return found;
  }

  // Calls fn after every change. Returns a function that stops it.
  function subscribe(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  return { report: report, snapshot: snapshot, modelsOf: modelsOf, classify: classify, subscribe: subscribe };
}

// The daemon's catalog: vendor adapters report into it, the server reads it.
var defaultCatalog = createVendorCatalog();

module.exports = { createVendorCatalog: createVendorCatalog, defaultCatalog: defaultCatalog };
