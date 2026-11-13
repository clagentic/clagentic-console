// Request-body helpers shared by the HTTP route modules (server-settings.js,
// server-admin.js). One definition each, so every JSON route answers a bad body,
// an oversized body and a persistence failure the same way.

// Parse a JSON request body. A body that is not a JSON object is a client error:
// answer 400 here and return null. Only the parse is guarded, so a failure while
// persisting is never reported as a bad request.
function parseJsonObjectBody(body, res) {
  var data = null;
  try {
    data = JSON.parse(body);
  } catch (e) {
    data = null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end('{"error":"Invalid request"}');
    return null;
  }
  return data;
}

// JSON route payloads are a few fields or short lists. The cap is a resource bound
// on what one request can make the daemon buffer, not a validation rule.
var JSON_BODY_CAP_BYTES = 64 * 1024;

// Read a JSON request body with a byte cap, then hand the parsed object to
// onData. Over the cap: answer 413, pause the request so no further data is
// read, drop what was buffered and close the connection once the answer is out.
// A body that is not a JSON object is answered 400 (see parseJsonObjectBody).
function readJsonObjectBody(req, res, onData) {
  var chunks = [];
  var size = 0;
  var tooLarge = false;
  req.on("data", function (chunk) {
    if (tooLarge) return;
    var piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += piece.length;
    if (size > JSON_BODY_CAP_BYTES) {
      tooLarge = true;
      chunks = [];
      req.pause();
      res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
      res.end('{"error":"Request body too large"}', function () { req.destroy(); });
      return;
    }
    chunks.push(piece);
  });
  req.on("end", function () {
    if (tooLarge) return;
    var data = parseJsonObjectBody(Buffer.concat(chunks).toString("utf8"), res);
    if (!data) return;
    onData(data);
  });
}

// A setter or the users-file write threw: the request was fine, the server could
// not keep it. Log it and answer 500.
function respondPersistFailure(res, what, e) {
  console.error("[request-body] saving " + what + " failed:", e && e.message ? e.message : e);
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end('{"error":"Could not save"}');
}

module.exports = {
  parseJsonObjectBody: parseJsonObjectBody,
  readJsonObjectBody: readJsonObjectBody,
  respondPersistFailure: respondPersistFailure,
  JSON_BODY_CAP_BYTES: JSON_BODY_CAP_BYTES,
};
