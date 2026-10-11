// daemon-env-settings.js - where the shared and per-project environment texts
// are kept. The daemon holds the shared text on its config (sharedEnv) and each
// project's on its record (envrc); the Settings pages read and write them
// through the four callbacks this returns.
//
// A text is checked here as well as on the WebSocket handler that receives it,
// so a caller that reaches the store another way cannot save a protected
// variable.

var runtimeEnv = require("./runtime-env");

/**
 * @param {object} deps
 * @param {function(): object} deps.getConfig   the daemon config (projects[], sharedEnv)
 * @param {function(object): void} deps.saveConfig
 * @returns {{onGetProjectEnv: function, onSetProjectEnv: function, onGetSharedEnv: function, onSetSharedEnv: function}}
 */
function createEnvSettings(deps) {
  var getConfig = deps.getConfig;
  var saveConfig = deps.saveConfig;

  function findProject(slug) {
    var projects = getConfig().projects || [];
    for (var i = 0; i < projects.length; i++) {
      if (projects[i].slug === slug) return projects[i];
    }
    return null;
  }

  return {
    onGetProjectEnv: function (slug) {
      var project = findProject(slug);
      return { envrc: (project && project.envrc) || "" };
    },

    onSetProjectEnv: function (slug, envrc) {
      var project = findProject(slug);
      if (!project) return { ok: false, error: "Project not found" };
      var problem = runtimeEnv.validateEnvText(envrc);
      if (problem) return { ok: false, error: problem };
      if (envrc) {
        project.envrc = envrc;
      } else {
        delete project.envrc;
      }
      saveConfig(getConfig());
      return { ok: true };
    },

    onGetSharedEnv: function () {
      return { envrc: getConfig().sharedEnv || "" };
    },

    onSetSharedEnv: function (envrc) {
      var problem = runtimeEnv.validateEnvText(envrc);
      if (problem) return { ok: false, error: problem };
      var config = getConfig();
      if (envrc) {
        config.sharedEnv = envrc;
      } else {
        delete config.sharedEnv;
      }
      saveConfig(config);
      return { ok: true };
    },
  };
}

/**
 * A project's environment text was written by its owner and applies to the
 * owner's sessions: when the owner changes, the new owner does not inherit it.
 * @param {object} project  the project record (mutated)
 * @param {string|null} oldOwnerId
 * @param {string|null} newOwnerId
 * @returns {boolean} true when the text was removed
 */
function removeEnvrcOnOwnerChange(project, oldOwnerId, newOwnerId) {
  if ((oldOwnerId || null) === (newOwnerId || null)) return false;
  if (!project || !("envrc" in project)) return false;
  delete project.envrc;
  return true;
}

module.exports = { createEnvSettings: createEnvSettings, removeEnvrcOnOwnerChange: removeEnvrcOnOwnerChange };
