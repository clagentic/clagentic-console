// user-shell.js - receives the ! command line's two server messages. The server
// sends the settings on connect and after a change, and a shell_result for every
// outcome of a command. The composer that sends a command and the card that shows
// its result are not here: a result is received and kept by the session history
// until they exist. Handlers are registered by app-messages.js.

import { store } from './store.js';

/** The ! settings the server last sent, for the controls that read them. */
export function handleUserShellSettings(msg) {
  store.set({
    userShellSettings: {
      enabled: msg.userShellEnabled !== false,
      timeoutMinutes: msg.userShellTimeoutMinutes,
      maxOutputKiB: msg.userShellMaxOutputKiB,
    },
  });
}

/** A command's outcome: nothing draws it yet, and nothing may treat it as an unknown message. */
export function handleShellResult() {}
