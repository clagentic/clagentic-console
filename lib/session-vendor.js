// One answer to "which vendor does this session run on", shared by the query
// start, fork/rewind and the session switch so none of them can disagree.
//
// Order: the vendor on the session in memory, else the one its stored meta
// records, else the project's default vendor, else none. `source` says which
// one answered; only the caller that runs a query acts on "default" (binds it).

function resolveVendor(session, deps) {
  if (session && session.vendor) return { vendor: session.vendor, source: "session" };
  var readMeta = deps && deps.readMetaVendor;
  var recorded = session && typeof readMeta === "function" ? readMeta(session) : null;
  if (recorded) return { vendor: recorded, source: "meta" };
  var fallback = deps && deps.defaultVendor;
  if (fallback) return { vendor: fallback, source: "default" };
  return { vendor: null, source: null };
}

module.exports = { resolveVendor: resolveVendor };
