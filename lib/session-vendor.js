// One answer to "which vendor does this session run on", shared by the query
// start, fork/rewind and the session switch so none of them can disagree.
//
// Order: the vendor on the session in memory, else the one its stored meta
// records, else the project's default vendor, else none. `source` says which
// one answered; only the caller that runs a query acts on "default" (binds it).
//
// The meta lookup has three states (see sessions.js lookupMetaVendor): present,
// absent, error. An error answers `source: "error"` with no vendor and never
// falls through to the default, because the default would overwrite a vendor
// that is recorded but could not be read.

function resolveVendor(session, deps) {
  if (session && session.vendor) return { vendor: session.vendor, source: "session" };
  var lookup = deps && deps.lookupMetaVendor;
  if (session && typeof lookup === "function") {
    var meta = lookup(session);
    if (meta && meta.state === "present" && meta.vendor) return { vendor: meta.vendor, source: "meta" };
    if (meta && meta.state === "error") return { vendor: null, source: "error" };
  }
  var fallback = deps && deps.defaultVendor;
  if (fallback) return { vendor: fallback, source: "default" };
  return { vendor: null, source: null };
}

// The wire name of a resolution source, for a client that must tell a vendor
// the session records ("present"), one the project default stands in for
// ("default-bound"), a meta that could not be read ("error") and no vendor at
// all ("absent").
function vendorSourceLabel(source) {
  if (source === "session" || source === "meta") return "present";
  if (source === "default") return "default-bound";
  if (source === "error") return "error";
  return "absent";
}

module.exports = { resolveVendor: resolveVendor, vendorSourceLabel: vendorSourceLabel };
