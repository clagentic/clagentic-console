// store.js - the scheduled inputs of one project, kept in a file in the console
// config directory so they survive a daemon restart.
//
// The file is written whole through a temporary file and a rename, so a crash
// leaves either the old list or the new one. A file that cannot be read is set
// aside under a new name, never silently overwritten, and the project starts
// with an empty list. If it cannot be set aside either, the store is read-only:
// every save is refused and the file is left exactly as it is.

var fs = require("fs");
var path = require("path");

var { STATE, isValidRecord } = require("./records");

var FORMAT = 1;
// Finished records stay listed for a while so a person or a script can see
// what happened to a schedule; only the newest are kept.
var MAX_FINISHED = 20;

function messageOf(err) {
  return err && err.message ? err.message : String(err);
}

// opts: { file }
function createStore(opts) {
  var file = opts.file;
  var records = [];
  // Set when the file is unreadable and could not be moved out of the way: a
  // save would then replace the only copy of the person's schedules, so none is
  // made. The store stays empty and read-only until the next load.
  var readOnlyReason = null;

  function setAside(reason) {
    var aside = file + ".unreadable-" + Date.now();
    try {
      fs.renameSync(file, aside);
      console.error("[scheduled-input] " + file + " is unreadable (" + reason + "); set aside as " + aside + ", starting empty");
    } catch (e) {
      readOnlyReason = file + " is unreadable (" + reason + ") and could not be set aside (" + messageOf(e) + "); saving is refused so it is not overwritten";
      console.error("[scheduled-input] " + readOnlyReason);
    }
  }

  function load() {
    records = [];
    readOnlyReason = null;
    var raw;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (e) {
      if (e && e.code === "ENOENT") return records;
      setAside(messageOf(e));
      return records;
    }
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      setAside("not valid JSON");
      return records;
    }
    if (!parsed || !Array.isArray(parsed.records)) {
      setAside("no records list");
      return records;
    }
    if (parsed.format !== FORMAT) {
      setAside("format " + JSON.stringify(parsed.format) + " is not the supported format " + FORMAT);
      return records;
    }
    if (!parsed.records.every(isValidRecord)) {
      setAside("a record is missing what it needs to fire");
      return records;
    }
    records = parsed.records;
    return records;
  }

  function prune() {
    var finished = records.filter(function (r) { return r.state !== STATE.ARMED; });
    if (finished.length <= MAX_FINISHED) return;
    finished.sort(function (a, b) { return (b.endedAt || 0) - (a.endedAt || 0); });
    var drop = finished.slice(MAX_FINISHED);
    records = records.filter(function (r) { return drop.indexOf(r) === -1; });
  }

  // Returns true when the list reached the disk.
  function save() {
    if (readOnlyReason !== null) {
      console.error("[scheduled-input] save refused: " + readOnlyReason);
      return false;
    }
    prune();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      var tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ format: FORMAT, records: records }, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      console.error("[scheduled-input] could not save " + file + ":", messageOf(e));
      return false;
    }
  }

  function all() {
    return records;
  }

  function get(id) {
    for (var i = 0; i < records.length; i++) {
      if (records[i].id === id) return records[i];
    }
    return null;
  }

  function add(record) {
    records.push(record);
  }

  function remove(id) {
    var before = records.length;
    records = records.filter(function (r) { return r.id !== id; });
    return records.length !== before;
  }

  // { readOnly, error }: error is the reason saving is refused, or null.
  function health() {
    return { readOnly: readOnlyReason !== null, error: readOnlyReason };
  }

  return { load: load, save: save, all: all, get: get, add: add, remove: remove, health: health };
}

module.exports = { createStore: createStore, MAX_FINISHED: MAX_FINISHED };
