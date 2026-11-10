// scheduled-input-actions.js - the messages the schedule panel and the
// scheduled-message bubbles send to the server about a scheduled input. One
// place, so the two surfaces cannot drift apart.

import { sendWs } from './ws-ref.js';

// requestId is optional: the server echoes it on its answer to the request, so
// a caller that waits for the answer (the composer's outbox) can tell which of
// its requests an answer or an error is for. The schedule panel sends none.
function withRequestId(msg, requestId) {
  if (requestId) msg.requestId = requestId;
  return msg;
}

export function sendScheduledNow(id, requestId) {
  return sendWs(withRequestId({ type: "send_scheduled_now", id: id }, requestId));
}

export function cancelScheduledInput(id, requestId) {
  return sendWs(withRequestId({ type: "cancel_scheduled_message", id: id }, requestId));
}

// Asks for the armed inputs of the session on screen; the answer arrives as
// scheduled_input_list.
export function requestScheduledInputList() {
  return sendWs({ type: "scheduled_input_list_request" });
}
