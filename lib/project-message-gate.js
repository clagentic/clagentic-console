// The single access gate at the entry of project message handling.
//
// Before any handler sees a message, the gate settles two questions:
//   1. may this connection's user act on THIS project (access can change
//      after the socket was opened), and
//   2. if the message names another project (targetSlug), may the user act
//      on that one, and does it exist.
// A message is either refused here or handed on with the target resolved and
// the client-supplied slug removed, so handlers only ever act on a slug the
// gate authorized.
//
// deps:
//   slug                this project's slug
//   canAccess(userId, slug) -> boolean   fail-closed project access check
//                                        (null for a bare context with no access wiring)
//   getProject(slug)    -> project context | null

var DENIED = "Project not found or access denied";

function createMessageGate(deps) {
  var slug = deps.slug;
  var canAccess = deps.canAccess;
  var getProject = deps.getProject;

  function refuse(error) {
    return { allowed: false, error: error || null, target: null, message: null };
  }

  function authorize(ws, msg) {
    // Anything that is not a JSON object cannot be a message.
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return refuse(null);

    var user = ws && ws._clagenticUser;
    var wired = typeof canAccess === "function";

    if (wired && (!user || !canAccess(user.id, slug))) return refuse(DENIED);

    var named = msg.targetSlug;
    var hasTarget = named !== undefined && named !== null && named !== "";
    if (!hasTarget) return { allowed: true, error: null, target: null, message: msg };

    if (typeof named !== "string") return refuse(DENIED);

    var forwarded = Object.assign({}, msg);
    delete forwarded.targetSlug;
    if (named === slug) return { allowed: true, error: null, target: null, message: forwarded };

    // Another project: both the existence and the right to act must hold.
    if (!wired || !user || typeof getProject !== "function") return refuse(DENIED);
    if (!canAccess(user.id, named)) return refuse(DENIED);
    var target = getProject(named);
    if (!target) return refuse(DENIED);
    return { allowed: true, error: null, target: target, message: forwarded };
  }

  return { authorize: authorize };
}

module.exports = { createMessageGate: createMessageGate, DENIED: DENIED };
