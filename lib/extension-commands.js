// Commands the daemon sends to a connected browser extension, and the rule for
// who may answer them.
//
// A command is an "extension" prompt in the prompt registry; the extension
// answers with an extension_result naming the command's requestId. Any client
// of the project can send that message, so each command remembers the socket
// it went to and only that socket's answer is accepted.

var { promptsFor } = require("./prompt-registry");

/**
 * @param {object} deps
 * @param {function(): object} deps.getSessionManager  the session manager whose
 *   prompt registry opens the commands (read per command: it may not exist yet
 *   when this is created)
 * @param {function(object, object)} deps.sendTo  (ws, message)
 */
function createExtensionCommands(deps) {
  var targets = new Map(); // requestId -> ws

  // Resolves with the extension's result, or null after the timeout.
  function send(ws, command, args, timeout) {
    var opened = promptsFor(deps.getSessionManager()).open(null, "extension", { command: command, args: args }, { timeoutMs: timeout });
    targets.set(opened.requestId, ws);
    var forget = function () { targets.delete(opened.requestId); };
    opened.answer.then(forget, forget);
    deps.sendTo(ws, {
      type: "extension_command",
      command: command,
      args: args,
      requestId: opened.requestId,
    });
    return opened.answer;
  }

  // Whether `ws` is the socket command `requestId` was sent to. Any other
  // requestId, of any type, is not.
  function mayAnswer(requestId, ws) {
    return targets.get(requestId) === ws;
  }

  return { send: send, mayAnswer: mayAnswer };
}

module.exports = { createExtensionCommands: createExtensionCommands };
