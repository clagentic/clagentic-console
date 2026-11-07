// The notification target model, shared by the server notification core
// (lib/notify/), the service worker (importScripts) and the page's ES modules
// (side-effect import, then read from globalThis). A classic script with no
// import/export so all three can load it.
//
// A target names where a notification's action lives: the project (slug), the
// console session (sessionId) and, where there is one, the prompt (requestId).
// Session ids restart in every project, so a target without its slug is
// ambiguous: the slug is always part of its identity.
(function (root, factory) {
  var api = factory();
  // Always published on the global too: a module-graph import in a CommonJS
  // host (the tests) evaluates this file as CJS and reads it from there.
  root.NotifyTarget = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  var SLUG_RE = /^[a-z0-9_-]+$/;

  function present(v) {
    return v !== undefined && v !== null && v !== "";
  }

  /**
   * @param {{slug: ?string, sessionId: ?(number|string), requestId: ?string}} t
   * @returns {{slug: ?string, sessionId: ?string, requestId: ?string}|null}
   *   a normalised target, or null when the input names no valid target. An id
   *   is carried as a string; a slug that is not a plain project slug is
   *   refused, since it ends up in a URL path.
   */
  function makeTarget(t) {
    if (!t || typeof t !== "object") return null;
    var slug = present(t.slug) ? String(t.slug) : null;
    if (slug !== null && !SLUG_RE.test(slug)) return null;
    return {
      slug: slug,
      sessionId: present(t.sessionId) ? String(t.sessionId) : null,
      requestId: present(t.requestId) ? String(t.requestId) : null,
    };
  }

  /** The one identity behind collapse, close and route: slug:sessionId[:requestId]. */
  function targetKey(t) {
    var n = makeTarget(t);
    if (!n) return "";
    var key = (n.slug || "") + ":" + (n.sessionId || "");
    return n.requestId ? key + ":" + n.requestId : key;
  }

  /** The session-level identity (no request): slug:sessionId. */
  function sessionKey(t) {
    var n = makeTarget(t);
    return n ? (n.slug || "") + ":" + (n.sessionId || "") : "";
  }

  /**
   * The deep link that opens a target: <base>p/<slug>/?session=<id>[&request=<id>].
   * A target with no slug (a system notice) opens the base page.
   * @param {object} target
   * @param {string} [base] the app root with a trailing slash; "/" by default.
   */
  function urlForTarget(target, base) {
    var n = makeTarget(target);
    var root = base || "/";
    if (root.charAt(root.length - 1) !== "/") root += "/";
    if (!n || !n.slug) return root;
    var url = root + "p/" + n.slug + "/";
    var q = [];
    if (n.sessionId) q.push("session=" + encodeURIComponent(n.sessionId));
    if (n.requestId) q.push("request=" + encodeURIComponent(n.requestId));
    return q.length ? url + "?" + q.join("&") : url;
  }

  /**
   * Reads a deep link's query. The slug comes from the path the page was
   * served on, so only the session and the request are in the query.
   * @param {string} search location.search
   * @returns {{sessionId: string, requestId: ?string}|null}
   */
  function parseDeepLink(search) {
    if (typeof search !== "string" || !search) return null;
    var params = new URLSearchParams(search);
    var session = params.get("session");
    if (!session || !/^[0-9]+$/.test(session)) return null;
    var request = params.get("request");
    return { sessionId: session, requestId: request || null };
  }

  return {
    makeTarget: makeTarget,
    targetKey: targetKey,
    sessionKey: sessionKey,
    urlForTarget: urlForTarget,
    parseDeepLink: parseDeepLink,
  };
});
