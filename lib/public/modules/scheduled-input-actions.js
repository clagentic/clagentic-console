// scheduled-input-actions.js - the messages the schedule panel and the
// scheduled-message bubbles send to the server about a scheduled input. One
// place, so the two surfaces cannot drift apart.

import { sendWs } from './ws-ref.js';

export function sendScheduledNow(id) {
  return sendWs({ type: "send_scheduled_now", id: id });
}

export function cancelScheduledInput(id) {
  return sendWs({ type: "cancel_scheduled_message", id: id });
}

// Asks for the armed inputs of the session on screen; the answer arrives as
// scheduled_input_list.
export function requestScheduledInputList() {
  return sendWs({ type: "scheduled_input_list_request" });
}
