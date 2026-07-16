// app-home-hub.js - Home hub rendering, weather, tips
// Extracted from app.js (PR-25)

import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { escapeHtml, relativeTime } from './utils.js';
import { switchProject, getCachedProjects, renderProjectList } from './app-projects.js';
import { renderProjectIcon, projectIconHtml } from './project-icon.js';
import { openSchedulerToTab } from './scheduler.js';
// playbook imports removed (Quick Start section removed from hub)
import { exitDmMode } from './app-dm.js';
import { openCommandPalette } from './command-palette.js';

function $hub(id) { return document.getElementById(id); }

var homeHub = null;
var homeHubVisible = false;
var hubSchedules = [];

// tip data removed (Did You Know section no longer shown in hub)

var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
var WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// --- Weather (hidden detail) ---
var weatherEmoji = null;   // null = not yet fetched, "" = failed
var weatherCondition = "";  // e.g. "Light rain, Auckland"
var weatherFetchedAt = 0;
var WEATHER_CACHE_MS = 60 * 60 * 1000; // 1 hour
// WMO weather code -> emoji + description
var WMO_MAP = {
  0: ["☀️", "Clear sky"], 1: ["🌤", "Mainly clear"], 2: ["⛅", "Partly cloudy"], 3: ["☁️", "Overcast"],
  45: ["🌫", "Fog"], 48: ["🌫", "Depositing rime fog"],
  51: ["🌦", "Light drizzle"], 53: ["🌦", "Moderate drizzle"], 55: ["🌧", "Dense drizzle"],
  56: ["🌧", "Light freezing drizzle"], 57: ["🌧", "Dense freezing drizzle"],
  61: ["🌧", "Slight rain"], 63: ["🌧", "Moderate rain"], 65: ["🌧", "Heavy rain"],
  66: ["🌧", "Light freezing rain"], 67: ["🌧", "Heavy freezing rain"],
  71: ["🌨", "Slight snow"], 73: ["🌨", "Moderate snow"], 75: ["❄️", "Heavy snow"],
  77: ["🌨", "Snow grains"],
  80: ["🌦", "Slight rain showers"], 81: ["🌧", "Moderate rain showers"], 82: ["🌧", "Violent rain showers"],
  85: ["🌨", "Slight snow showers"], 86: ["❄️", "Heavy snow showers"],
  95: ["⛈", "Thunderstorm"], 96: ["⛈", "Thunderstorm with slight hail"], 99: ["⛈", "Thunderstorm with heavy hail"],
};

var SLOT_EMOJIS = ["☀️", "🌤", "⛅", "☁️", "🌧", "🌦", "⛈", "🌨", "❄️", "🌫", "🌙", "✨"];
var weatherSlotPlayed = false;

var hubCloseBtn = null;

export function initHomeHub() {
  homeHub = document.getElementById("home-hub");
  hubCloseBtn = document.getElementById("home-hub-close");

  // Hub search bar: focus or keydown delegates immediately to the command palette.
  var hubSearchInput = document.getElementById("hub-search-input");
  if (hubSearchInput) {
    function delegateToPalette() {
      hubSearchInput.blur();
      openCommandPalette();
    }
    hubSearchInput.addEventListener("focus", delegateToPalette);
    hubSearchInput.addEventListener("keydown", delegateToPalette);
  }

  if (hubCloseBtn) {
    hubCloseBtn.addEventListener("click", function () {
      hideHomeHub();
      if (store.get('currentSlug')) {
        if (document.documentElement.classList.contains("pwa-standalone")) {
          history.replaceState(null, "", "/p/" + store.get('currentSlug') + "/");
        } else {
          history.pushState(null, "", "/p/" + store.get('currentSlug') + "/");
        }
        // Restore icon strip active state
        var homeIcon = document.querySelector(".icon-strip-home");
        if (homeIcon) homeIcon.classList.remove("active");
        renderProjectList();
      }
    });
  }
}

export function isHomeHubVisible() { return homeHubVisible; }

function fetchWeather() {
  // Use cache if we have a successful result within the last hour
  if (weatherEmoji && weatherFetchedAt && (Date.now() - weatherFetchedAt < WEATHER_CACHE_MS)) return;
  // Try localStorage cache
  if (!weatherEmoji) {
    try {
      var cached = JSON.parse(localStorage.getItem("clagentic-weather") || localStorage.getItem("clay-weather") || "null");
      if (cached && cached.emoji && (Date.now() - cached.ts < WEATHER_CACHE_MS)) {
        weatherEmoji = cached.emoji;
        weatherCondition = cached.condition || "";
        weatherFetchedAt = cached.ts;
        if (homeHubVisible) updateGreetingWeather();
        return;
      }
    } catch (e) {}
  }
  if (weatherFetchedAt && (Date.now() - weatherFetchedAt < 30000)) return; // don't retry within 30s
  weatherFetchedAt = Date.now();
  // Step 1: IP geolocation -> lat/lon + city
  fetch("https://ipapi.co/json/", { signal: AbortSignal.timeout(4000) })
    .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
    .then(function (geo) {
      var lat = geo.latitude;
      var lon = geo.longitude;
      var city = geo.city || geo.region || "";
      var country = geo.country_name || "";
      var locationStr = city + (country ? ", " + country : "");
      // Step 2: Open-Meteo -> current weather
      var meteoUrl = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current=weather_code&timezone=auto";
      return fetch(meteoUrl, { signal: AbortSignal.timeout(4000) })
        .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
        .then(function (data) {
          var code = data && data.current && data.current.weather_code;
          if (code === undefined || code === null) return;
          var mapped = WMO_MAP[code] || WMO_MAP[0];
          weatherEmoji = mapped[0];
          weatherCondition = mapped[1] + (locationStr ? " in " + locationStr : "");
          weatherFetchedAt = Date.now();
          try {
            localStorage.setItem("clagentic-weather", JSON.stringify({
              emoji: weatherEmoji, condition: weatherCondition, ts: weatherFetchedAt
            }));
          } catch (e) {}
          if (homeHubVisible) updateGreetingWeather();
        });
    })
    .catch(function () {
      if (!weatherEmoji) weatherEmoji = "";
    });
}

function updateGreetingWeather() {
  var greetEl = $hub("hub-greeting-text");
  if (!greetEl) return;
  // If we have real weather and haven't played the slot yet, do the reel
  if (weatherEmoji && !weatherSlotPlayed && homeHubVisible) {
    weatherSlotPlayed = true;
    playWeatherSlot(greetEl);
    return;
  }
  // Normal update (no animation)
  greetEl.textContent = getGreeting();

  applyWeatherTooltip(greetEl);
}

function applyWeatherTooltip(greetEl) {
  if (!weatherCondition) return;
  var emojis = greetEl.querySelectorAll("img.emoji");
  var lastEmoji = emojis.length > 0 ? emojis[emojis.length - 1] : null;
  if (lastEmoji) {
    lastEmoji.title = weatherCondition;
    lastEmoji.style.cursor = "default";
  }
}

function playWeatherSlot(greetEl) {
  var h = new Date().getHours();
  var prefix;
  if (h < 6) prefix = "Good night";
  else if (h < 12) prefix = "Good morning";
  else if (h < 18) prefix = "Good afternoon";
  else prefix = "Good evening";

  // Build schedule: fast ticks -> slow ticks -> land (~3s total)
  var intervals = [50, 50, 50, 60, 70, 80, 100, 120, 150, 190, 240, 300, 370, 450, 530, 640];
  var totalSteps = intervals.length;
  var step = 0;
  var startIdx = Math.floor(Math.random() * SLOT_EMOJIS.length);

  function tick() {
    if (step < totalSteps) {
      var idx = (startIdx + step) % SLOT_EMOJIS.length;
      greetEl.textContent = prefix + " " + SLOT_EMOJIS[idx];

      step++;
      setTimeout(tick, intervals[step - 1]);
    } else {
      // Final: land on actual weather
      greetEl.textContent = prefix + " " + weatherEmoji;

      applyWeatherTooltip(greetEl);
    }
  }
  tick();
}

function getGreeting() {
  var h = new Date().getHours();
  var emoji = weatherEmoji || "";
  // Fallback to time-based emoji if weather not available
  if (!emoji) {
    if (h < 6) emoji = "✨";
    else if (h < 12) emoji = "☀️";
    else if (h < 18) emoji = "🌤";
    else emoji = "🌙";
  }
  var prefix;
  if (h < 6) prefix = "Good night";
  else if (h < 12) prefix = "Good morning";
  else if (h < 18) prefix = "Good afternoon";
  else prefix = "Good evening";
  return prefix + " " + emoji;
}

function getFormattedDate() {
  var now = new Date();
  return WEEKDAY_NAMES[now.getDay()] + ", " + MONTH_NAMES[now.getMonth()] + " " + now.getDate() + ", " + now.getFullYear();
}

function formatScheduleTime(ts) {
  var d = new Date(ts);
  var now = new Date();
  var todayStr = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  var schedStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  var h = d.getHours();
  var m = String(d.getMinutes()).padStart(2, "0");
  var ampm = h >= 12 ? "PM" : "AM";
  var h12 = h % 12 || 12;
  var timeStr = h12 + ":" + m + " " + ampm;
  if (schedStr === todayStr) return timeStr;
  // Tomorrow check
  var tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  var tomStr = tomorrow.getFullYear() + "-" + String(tomorrow.getMonth() + 1).padStart(2, "0") + "-" + String(tomorrow.getDate()).padStart(2, "0");
  if (schedStr === tomStr) return "Tomorrow";
  return DAY_NAMES[d.getDay()] + " " + timeStr;
}

// Looks up whether a project has unresolved alerts, using the SAME source
// that drives the Projects-list unread badge (proj.unread, populated in
// renderProjectList() / app-projects.js and rendered as
// .icon-strip-project-badge.has-unread / .hub-project-sessions elsewhere).
// No separate alert data path — this is a read of the existing cache.
function projectHasAlert(projectSlug) {
  if (!projectSlug) return false;
  var projects = getCachedProjects();
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].slug === projectSlug) {
      return (projects[i].unread || 0) > 0;
    }
  }
  return false;
}

export function renderHomeHub(projects) {
  // Greeting + weather tooltip
  updateGreetingWeather();

  // Date
  var dateEl = $hub("hub-greeting-date");
  if (dateEl) dateEl.textContent = getFormattedDate();

  // --- Upcoming tasks ---
  var upcomingList = $hub("hub-upcoming-list");
  var upcomingCount = $hub("hub-upcoming-count");
  if (upcomingList) {
    var now = Date.now();
    var upcoming = hubSchedules.filter(function (s) {
      return s.enabled && s.nextRunAt && s.nextRunAt > now;
    }).sort(function (a, b) {
      return a.nextRunAt - b.nextRunAt;
    });
    // Show up to next 48 hours
    var cutoff = now + 48 * 60 * 60 * 1000;
    var filtered = upcoming.filter(function (s) { return s.nextRunAt <= cutoff; });

    if (upcomingCount) {
      upcomingCount.textContent = filtered.length > 0 ? filtered.length : "";
    }

    upcomingList.innerHTML = "";
    if (filtered.length === 0) {
      // Empty state with CTA
      var emptyDiv = document.createElement("div");
      emptyDiv.className = "hub-upcoming-empty";
      emptyDiv.innerHTML = '<div class="hub-upcoming-empty-icon">📋</div>' +
        '<div class="hub-upcoming-empty-text">No upcoming tasks</div>' +
        '<button class="hub-upcoming-cta" id="hub-upcoming-cta">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>' +
        'Create a schedule</button>';
      upcomingList.appendChild(emptyDiv);
      var ctaBtn = emptyDiv.querySelector("#hub-upcoming-cta");
      if (ctaBtn) {
        ctaBtn.addEventListener("click", function () {
          hideHomeHub();
          openSchedulerToTab("calendar");
        });
      }
    } else {
      var maxShow = 5;
      var shown = filtered.slice(0, maxShow);
      for (var i = 0; i < shown.length; i++) {
        (function (sched) {
          var item = document.createElement("div");
          item.className = "hub-upcoming-item";
          var dotColor = sched.color || "";
          item.innerHTML = '<span class="hub-upcoming-dot"' + (dotColor ? ' style="background:' + dotColor + '"' : '') + '></span>' +
            '<span class="hub-upcoming-time">' + formatScheduleTime(sched.nextRunAt) + '</span>' +
            '<span class="hub-upcoming-name">' + escapeHtml(sched.name || "Untitled") + '</span>' +
            '<span class="hub-upcoming-project">' + escapeHtml(sched.projectTitle || "") + '</span>';
          item.addEventListener("click", function () {
            if (sched.projectSlug) {
              switchProject(sched.projectSlug);
              setTimeout(function () {
                openSchedulerToTab("library");
              }, 300);
            }
          });
          upcomingList.appendChild(item);
        })(shown[i]);
      }
      if (filtered.length > maxShow) {
        var moreEl = document.createElement("div");
        moreEl.className = "hub-upcoming-more";
        moreEl.textContent = "+" + (filtered.length - maxShow) + " more";
        upcomingList.appendChild(moreEl);
      }
    }
  }

  // --- Projects summary ---
  var projectsList = $hub("hub-projects-list");
  if (projectsList && projects) {
    projectsList.innerHTML = "";
    var hubProjects = projects.filter(function (p) { return !p.isWorktree; });
    for (var p = 0; p < hubProjects.length; p++) {
      (function (proj) {
        var item = document.createElement("div");
        item.className = "hub-project-item";

        var dot = document.createElement("span");
        dot.className = "hub-project-dot" + (proj.isProcessing ? " processing" : "");
        item.appendChild(dot);

        if (proj.icon) {
          var iconSpan = document.createElement("span");
          iconSpan.className = "hub-project-icon";
          // renderProjectIcon routes custom (:slug:) to <img> and emoji to text,
          // avoiding the pre-existing XSS gap of raw proj.icon in innerHTML.
          renderProjectIcon(proj.icon, iconSpan, null);
          item.appendChild(iconSpan);
        }

        var nameSpan = document.createElement("span");
        nameSpan.className = "hub-project-name";
        nameSpan.textContent = proj.title || proj.project || proj.slug;
        item.appendChild(nameSpan);

        var sessionsLabel = typeof proj.sessions === "number" ? proj.sessions : "";
        if (sessionsLabel !== "") {
          var sessSpan = document.createElement("span");
          sessSpan.className = "hub-project-sessions";
          sessSpan.textContent = String(sessionsLabel);
          item.appendChild(sessSpan);
        }

        item.addEventListener("click", function () {
          switchProject(proj.slug);
        });
        projectsList.appendChild(item);
      })(hubProjects[p]);
    }
    // Render emoji icons

  }

  // --- Week strip ---
  var weekStrip = $hub("hub-week-strip");
  if (weekStrip) {
    weekStrip.innerHTML = "";
    var today = new Date();
    var todayDate = today.getDate();
    var todayMonth = today.getMonth();
    var todayYear = today.getFullYear();
    // Find Monday of current week
    var dayOfWeek = today.getDay();
    var mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    var monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);

    // Build set of dates that have events
    var eventDates = {};
    for (var si = 0; si < hubSchedules.length; si++) {
      var sched = hubSchedules[si];
      if (!sched.enabled) continue;
      if (sched.nextRunAt) {
        var sd = new Date(sched.nextRunAt);
        var key = sd.getFullYear() + "-" + sd.getMonth() + "-" + sd.getDate();
        eventDates[key] = (eventDates[key] || 0) + 1;
      }
      if (sched.date) {
        var parts = sched.date.split("-");
        var dateKey = parseInt(parts[0], 10) + "-" + (parseInt(parts[1], 10) - 1) + "-" + parseInt(parts[2], 10);
        eventDates[dateKey] = (eventDates[dateKey] || 0) + 1;
      }
    }

    for (var d = 0; d < 7; d++) {
      var dayDate = new Date(monday);
      dayDate.setDate(monday.getDate() + d);
      var isToday = dayDate.getDate() === todayDate && dayDate.getMonth() === todayMonth && dayDate.getFullYear() === todayYear;
      var dateKey = dayDate.getFullYear() + "-" + dayDate.getMonth() + "-" + dayDate.getDate();
      var eventCount = eventDates[dateKey] || 0;

      var cell = document.createElement("div");
      cell.className = "hub-week-day" + (isToday ? " today" : "");
      var dotsHtml = '<div class="hub-week-dots">';
      var dotCount = Math.min(eventCount, 3);
      for (var di = 0; di < dotCount; di++) {
        dotsHtml += '<span class="hub-week-dot"></span>';
      }
      dotsHtml += '</div>';
      cell.innerHTML = '<span class="hub-week-label">' + DAY_NAMES[(dayDate.getDay())] + '</span>' +
        '<span class="hub-week-num">' + dayDate.getDate() + '</span>' +
        dotsHtml;
      weekStrip.appendChild(cell);
    }
  }

  // Quick Start playbooks and Did You Know tip sections have been removed from the hub.

  // Render twemoji for all emoji in the hub

}

export function handleHubSchedules(msg) {
  if (msg.schedules) {
    hubSchedules = msg.schedules;
    if (homeHubVisible) renderHomeHub(getCachedProjects());
  }
}

export function handleHubRecentSessions(msg) {
  var sessions = msg.sessions || [];
  var list = document.getElementById("hub-recent-sessions-list");
  if (!list) return;
  list.innerHTML = "";
  if (sessions.length === 0) {
    var emptyDiv = document.createElement("div");
    emptyDiv.className = "hub-recent-empty";
    emptyDiv.textContent = "No recent sessions";
    list.appendChild(emptyDiv);
    return;
  }
  sessions.forEach(function (sess) {
    var item = document.createElement("div");
    item.className = "hub-recent-item";
    // projectIconHtml() routes custom (:slug:) icons to a safe <img> tag and
    // emoji to escaped text, replacing the raw escapeHtml(sess.projectIcon)
    // which showed ':slug:' as literal text (lr-a6da).
    var iconHtml = sess.projectIcon
      ? '<span class="hub-recent-project-icon">' + projectIconHtml(sess.projectIcon) + '</span>'
      : '<span class="hub-recent-project-icon hub-recent-project-icon--blank"></span>';
    var timeStr = relativeTime(sess.lastActivity);
    var agentBadge = sess.agentName
      ? '<span class="hub-recent-agent">' + escapeHtml(sess.agentName) + '</span>'
      : '';
    var dotClass = "hub-recent-dot" + (sess.isProcessing ? " processing" : "");
    // Alert indicator: reuse the same per-project unread count that drives
    // the Projects-list badge (icon-strip-project-badge / hub-project-*),
    // rather than a new data path. A count won't fit this row, so render a
    // plain dot when the row's project has 1+ unresolved (unread) items.
    var alertHtml = projectHasAlert(sess.projectSlug)
      ? '<span class="hub-recent-alert-dot" title="Unread activity"></span>'
      : '';
    item.innerHTML =
      '<span class="' + dotClass + '"></span>' +
      iconHtml +
      '<span class="hub-recent-title">' + escapeHtml(sess.title) + '</span>' +
      alertHtml +
      agentBadge +
      '<span class="hub-recent-time">' + timeStr + '</span>';
    item.addEventListener("click", function () {
      var currentSlug = store.get('currentSlug');
      if (sess.projectSlug && sess.projectSlug !== currentSlug) {
        // Store the target session ID so the session_list handler can drain it
        // once the new project's WS is confirmed open — same pattern as
        // pending-notif-session in app-notifications.js.
        try { sessionStorage.setItem("pending-hub-session", String(sess.id)); } catch (e) {}
        switchProject(sess.projectSlug);
      } else {
        if (getWs() && getWs().readyState === 1) {
          getWs().send(JSON.stringify({ type: "switch_session", id: sess.id }));
        }
      }
      hideHomeHub();
    });
    list.appendChild(item);
  });
}

function startTipRotation() {} // removed: tip section no longer shown
function stopTipRotation() {}

export function showHomeHub() {
  if (store.get('dmMode')) exitDmMode();
  homeHubVisible = true;
  homeHub.classList.remove("hidden");
  // Show close button only if there's a project to return to
  if (hubCloseBtn) {
    if (store.get('currentSlug')) hubCloseBtn.classList.remove("hidden");
    else hubCloseBtn.classList.add("hidden");
  }
  // Fetch weather silently (once)
  fetchWeather();
  // Request cross-project schedules and recent sessions
  if (getWs() && getWs().readyState === 1) {
    getWs().send(JSON.stringify({ type: "hub_schedules_list" }));
    getWs().send(JSON.stringify({ type: "hub_recent_sessions_list" }));
  }
  renderHomeHub(getCachedProjects());
  startTipRotation();
  if (document.documentElement.classList.contains("pwa-standalone")) {
    history.replaceState(null, "", "/");
  } else {
    history.pushState(null, "", "/");
  }
  // Update icon strip active state
  var homeIcon = document.querySelector(".icon-strip-home");
  if (homeIcon) homeIcon.classList.add("active");
  var activeProj = document.querySelector("#icon-strip-projects .icon-strip-item.active");
  if (activeProj) activeProj.classList.remove("active");
  // Mobile home button active
  var mobileHome = document.getElementById("mobile-home-btn");
  if (mobileHome) mobileHome.classList.add("active");
}

export function hideHomeHub() {
  if (!homeHubVisible) return;
  homeHubVisible = false;
  homeHub.classList.add("hidden");
  stopTipRotation();
  var mobileHome = document.getElementById("mobile-home-btn");
  if (mobileHome) mobileHome.classList.remove("active");
}

