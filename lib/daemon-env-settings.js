// daemon-env-settings.js - where the shared and per-project environment texts
// are kept. The daemon holds the shared text on its config (sharedEnv) and each
// project's on its record (envrc); the Settings pages read and write them
// through the four callbacks this returns.
//
// A text is checked here as well as on the WebSocket handler that receives it,
// so a caller that reaches the store another way cannot save a protected
// variable. A saved change is reported through onChanged so a runtime that is
// already idle can be restarted to pick it up.

var runtimeEnv = require("./runtime-env");

/**
 * @param {object} deps
 * @param {function(): object} deps.getConfig   the daemon config (projects[], sharedEnv)
 * @param {function(object): void} deps.saveConfig
 * @param {function({scope: string, slug: string|null}): void} [deps.onChanged]
 * @returns {{onGetProjectEnv: function, onSetProjectEnv: function, onGetSharedEnv: function, onSetSharedEnv: function}}
 */
function createEnvSettings(deps) {
  var getConfig = deps.getConfig;
  var saveConfig = deps.saveConfig;
  var onChanged = deps.onChanged || function () {};

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
      onChanged({ scope: "project", slug: slug });
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
      onChanged({ scope: "shared", slug: null });
      return { ok: true };
    },
  };
}

module.exports = { createEnvSettings: createEnvSettings };
