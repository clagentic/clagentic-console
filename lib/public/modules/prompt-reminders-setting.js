// prompt-reminders-setting.js - the per-session switch for reminders about
// unanswered prompts (the server side is lib/prompt-reminders.js).

import { store } from './store.js';
import { getWs } from './ws-ref.js';

/** Asks the server to turn a session's prompt reminders on or off. */
export function sendSessionPromptReminders(sessionId, enabled) {
  var ws = getWs();
  if (ws && store.get('connected')) {
    ws.send(JSON.stringify({ type: "set_session_prompt_reminders", sessionId: sessionId, enabled: !!enabled }));
  }
}
