// Client renderers for every operator-prompt kind. A renderer draws the
// card body and its answer controls and names its outcome labels; the
// lifecycle (pending, sending, settled, server state) is the shell's
// (prompts.js, prompt-card.js).

import permission from './permission.js';
import plan from './plan.js';
import askUser from './ask-user.js';
import elicitation from './elicitation.js';

export var PROMPT_KINDS = {
  permission: permission,
  plan: plan,
  ask_user: askUser,
  elicitation: elicitation,
};

export { askWording } from './permission.js';
