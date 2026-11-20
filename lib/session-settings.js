"use strict";

// The per-session settings other than model and permission mode: effort, betas,
// thinking and the thinking token budget. A session holds its own value (saved
// with it, lib/sessions.js); the saved defaults live on the session manager as
// sm._savedDefaultEffort / _savedDefaultBetas / _savedDefaultThinking /
// _savedDefaultThinkingBudget (loaded from the project, else the server, at
// project start and reloaded in every project when a server default changes).
// There is no shared "current" field for any of them, so one
// session's pick cannot reach another session's request or its clients.
//
// Precedence at query start: loop settings > session > project default >
// server default > fallback (lib/sdk-bridge.js applies the loop layer).

// What a picker shows for a setting nothing has set.
var FALLBACKS = { effort: "medium", thinking: "adaptive", thinkingBudget: 10000 };

/**
 * @param {?object} session
 * @param {?object} sm - the session manager (or a double) carrying the saved defaults.
 * @returns {{effort: string, betas: string[], thinking: string, thinkingBudget: number}}
 *   what this session runs with and its clients are shown.
 */
function effectiveSessionSettings(session, sm) {
  var s = session || {};
  var d = sm || {};
  return {
    effort: s.effort || d._savedDefaultEffort || FALLBACKS.effort,
    // An empty array is the session's choice of "no betas", not "unset".
    betas: Array.isArray(s.betas) ? s.betas : (Array.isArray(d._savedDefaultBetas) ? d._savedDefaultBetas : []),
    thinking: s.thinking || d._savedDefaultThinking || FALLBACKS.thinking,
    thinkingBudget: s.thinkingBudget || d._savedDefaultThinkingBudget || FALLBACKS.thinkingBudget,
  };
}

/**
 * The config_state push for a session: its model and mode (as the caller
 * resolved them) with its effective settings. Every sender that describes a
 * session builds the push here, so none can read a shared field instead.
 */
function configStateFor(session, sm, model, mode) {
  return Object.assign({ type: "config_state", model: model, mode: mode }, effectiveSessionSettings(session, sm));
}

function readOne(getter, arg) {
  return typeof getter === "function" ? getter(arg) : null;
}

/**
 * The saved defaults a project starts with, read from the project's own store
 * and the server's: the project default when it names a value, else the server
 * default, else null (effort falls back to "medium"). Betas count as named only
 * when non-empty (an empty list is stored as no key). Thinking carries its
 * budget from the same level as the mode.
 * @param {object} opts - the onGet*DefaultEffort / Betas / Thinking callbacks.
 * @param {string} slug
 * @returns {{effort: string, betas: string[], thinking: ?string, thinkingBudget: ?number}}
 */
function readSavedDefaults(opts, slug) {
  var o = opts || {};
  var projEffort = readOne(o.onGetProjectDefaultEffort, slug);
  var srvEffort = readOne(o.onGetServerDefaultEffort);
  var projBetas = readOne(o.onGetProjectDefaultBetas, slug);
  var srvBetas = readOne(o.onGetServerDefaultBetas);
  var projThinking = readOne(o.onGetProjectDefaultThinking, slug);
  var srvThinking = readOne(o.onGetServerDefaultThinking);
  var thinkingSource = (projThinking && projThinking.thinking) ? projThinking : ((srvThinking && srvThinking.thinking) ? srvThinking : null);
  return {
    effort: (projEffort && projEffort.effort) || (srvEffort && srvEffort.effort) || FALLBACKS.effort,
    betas: (projBetas && projBetas.betas && projBetas.betas.length > 0 && projBetas.betas) || (srvBetas && srvBetas.betas) || [],
    thinking: thinkingSource ? thinkingSource.thinking : null,
    thinkingBudget: thinkingSource && thinkingSource.thinkingBudget ? thinkingSource.thinkingBudget : null,
  };
}

/**
 * Loads the saved defaults (model, effort, betas, thinking) from the stores onto
 * the session manager: the project's own default, else the server's. Run at
 * project start and again in every project when a server default changes, so a
 * project never keeps a stale server default until restart. The model default
 * also becomes the manager's fallback model when one is named, as at start.
 * @param {object} sm - the session manager.
 * @param {object} opts - the onGet*Default* callbacks.
 * @param {string} slug
 */
function refreshSavedDefaults(sm, opts, slug) {
  var o = opts || {};
  var saved = readSavedDefaults(o, slug);
  sm._savedDefaultEffort = saved.effort;
  sm._savedDefaultBetas = saved.betas;
  sm._savedDefaultThinking = saved.thinking;
  sm._savedDefaultThinkingBudget = saved.thinkingBudget;
  var projModel = readOne(o.onGetProjectDefaultModel, slug);
  var srvModel = readOne(o.onGetServerDefaultModel);
  sm._savedDefaultModel = (projModel && projModel.model) || (srvModel && srvModel.model) || null;
  if (sm._savedDefaultModel) sm.currentModel = sm._savedDefaultModel;
}

// The saved values of one level, each null (betas []) when that level names none.
function savedLevel(model, effort, betas, thinking) {
  return {
    model: (model && model.model) || null,
    effort: (effort && effort.effort) || null,
    betas: (betas && Array.isArray(betas.betas) && betas.betas) || [],
    thinking: (thinking && thinking.thinking) || null,
    thinkingBudget: (thinking && thinking.thinkingBudget) || null,
  };
}

/**
 * The saved_defaults push: the model, effort, betas and thinking saved for the
 * server and for this project, each as stored and not merged. The Settings
 * pickers show these and not any session's values (which config_state carries).
 * @param {object} opts - the onGet*Default* callbacks.
 * @param {string} slug
 */
function savedDefaultsMessage(opts, slug) {
  var o = opts || {};
  return {
    type: "saved_defaults",
    server: savedLevel(readOne(o.onGetServerDefaultModel), readOne(o.onGetServerDefaultEffort),
      readOne(o.onGetServerDefaultBetas), readOne(o.onGetServerDefaultThinking)),
    project: savedLevel(readOne(o.onGetProjectDefaultModel, slug), readOne(o.onGetProjectDefaultEffort, slug),
      readOne(o.onGetProjectDefaultBetas, slug), readOne(o.onGetProjectDefaultThinking, slug)),
  };
}

module.exports = {
  savedDefaultsMessage: savedDefaultsMessage,
  effectiveSessionSettings: effectiveSessionSettings,
  configStateFor: configStateFor,
  readSavedDefaults: readSavedDefaults,
  refreshSavedDefaults: refreshSavedDefaults,
  FALLBACKS: FALLBACKS,
};
