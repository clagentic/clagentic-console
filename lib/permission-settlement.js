"use strict";

// History replay is paged, so a permission_request can be replayed without the
// permission_resolved/permission_cancel that closed it (the resolution sits in a
// newer page). A client that renders the request alone draws a live card for a
// request the server no longer holds. These helpers mark such requests on the
// wire copy only; stored history is never mutated.

// Maps requestId -> decision (string) or null (cancelled) for every resolution
// found in history[from..]. A resolution always follows its request, so
// scanning forward from the earliest replayed index is sufficient.
function buildSettlementIndex(history, from) {
  var index = Object.create(null);
  for (var i = Math.max(0, from || 0); i < history.length; i++) {
    var e = history[i];
    if (!e || !e.requestId || index[e.requestId] !== undefined) continue;
    if (e.type === "permission_resolved") index[e.requestId] = e.decision || null;
    else if (e.type === "permission_cancel") index[e.requestId] = null;
  }
  return index;
}

// Returns item unchanged unless it is a permission_request the session no
// longer holds pending, in which case a copy carrying settled:true (and the
// decision, when one was recorded) is returned.
function annotateSettledPermission(session, item, settlementIndex) {
  if (!item || item.type !== "permission_request") return item;
  var pending = session && session.pendingPermissions;
  if (pending && pending[item.requestId]) return item;
  var copy = Object.assign({}, item, { settled: true });
  var decision = settlementIndex[item.requestId];
  if (decision) copy.decision = decision;
  return copy;
}

module.exports = {
  buildSettlementIndex: buildSettlementIndex,
  annotateSettledPermission: annotateSettledPermission,
};
