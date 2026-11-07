"use strict";

// The target model is defined once, in the file the browser and the service
// worker load too, so the server and the client cannot disagree on identity.
module.exports = require("../public/notify-target.js");
