// ============================================================================
// session-search.js - BM25 search for the command palette (Cmd+K)
//
// Was previously a shared engine for Mates digest/knowledge search too
// (removed lr-316f, pruned lr-439f/lr-509f); only the palette path survives.
// ============================================================================

// --- BM25 Parameters ---
var K1 = 1.2;   // term frequency saturation
var B = 0.75;    // document length normalization
var MAX_RESULTS = 10;

// --- Searchable session history entry types ---
var SEARCHABLE_TYPES = {
  "user_message": true,
  "delta": true,
  "mention_user": true,
  "mention_response": true
};

// ==========================================================================
// 1. BM25 CORE - tokenizer, index builder, scorer
// ==========================================================================

// Stopwords for major languages. Only high-frequency function words that
// carry almost no semantic meaning. Kept short to avoid false negatives.
var STOPWORDS = {};
var _sw = [
  // English
  "the a an is are was were be been being have has had do does did will would could",
  "should may might shall can to of in for on with at by from as into through about",
  "and or but not so if then it its this that these those i me my we our you your",
  "he she they them their what which who when where how all each every both few more",
  "other some such no nor only own same than too very just also now here there null none",
  // Spanish
  "el la los las un una unos unas de en con por para al del que es no se lo su sus",
  "como mas pero si ya muy te tu mi me nos le les fue ser estar hay este esta esto",
  // French
  "le la les un une des de du en au aux et est que qui ne pas pour sur avec dans par",
  "ce cette ces je tu il elle nous vous ils son sa ses lui sont ont fait plus",
  // German
  "der die das ein eine einer eines dem den des im auf ist und zu von mit dem den",
  "nicht sich auch es an als ich er sie wir ihr aber nach wie noch bei uns aus",
  // Portuguese
  "de da do das dos em um uma que se no na os as para com por mais",
  "mas como foi ao ele ela seu sua isso este esta esse essa",
  // Italian
  "il lo la le gli un una dei del della delle nel nella che di da in con su per",
  "non si come anche sono ha ho questo questa quello quella",
  // Dutch
  "de het een van en in is dat op te zijn voor met als bij om ook maar er nog",
  "niet aan dan ze wel dit die ze uit tot",
  // Russian (transliterated would not match, keep Cyrillic)
  "\u0438 \u0432 \u043d\u0430 \u043d\u0435 \u0447\u0442\u043e \u044d\u0442\u043e \u043a\u0430\u043a \u043e\u043d \u043e\u043d\u0430 \u043e\u043d\u0438 \u043c\u044b \u0432\u044b \u044f \u0441 \u043f\u043e \u0434\u043b\u044f \u043a \u043d\u043e \u0434\u0430 \u0442\u043e \u043e\u0442 \u043e \u0431\u044b\u043b \u0431\u044b\u043b\u0430 \u0431\u044b\u043b\u043e \u0435\u0441\u0442\u044c \u0431\u044b\u0442\u044c \u0443\u0436\u0435 \u0438\u043b\u0438 \u0442\u043e\u0436\u0435 \u0435\u0449\u0435",
  // Korean particles
  "\uC740 \uB294 \uC774 \uAC00 \uC744 \uB97C \uC758 \uC5D0 \uC5D0\uC11C \uB85C \uC73C\uB85C \uB3C4 \uB9CC \uAE4C\uC9C0 \uBD80\uD130 \uADF8 \uC800 \uB098 \uB108",
  // Japanese particles (hiragana)
  "\u306E \u306F \u304C \u3092 \u306B \u3078 \u3067 \u3068 \u3082 \u304B \u3088 \u306D \u306A \u3051\u3069 \u3057 \u305D\u306E \u3053\u306E \u305D\u308C \u3053\u308C \u3042\u308B \u3044\u308B \u3059\u308B \u306A\u3044 \u3067\u3059 \u307E\u3059",
  // Chinese function words
  "\u7684 \u4E86 \u5728 \u662F \u6211 \u4ED6 \u5979 \u4EEC \u8FD9 \u90A3 \u4E0D \u4E5F \u5C31 \u548C \u8981 \u4F1A \u80FD \u6709 \u5BF9 \u8BF4 \u8FD8 \u53EF\u4EE5 \u4EC0\u4E48 \u600E\u4E48",
  // Arabic
  "\u0641\u064A \u0645\u0646 \u0639\u0644\u0649 \u0625\u0644\u0649 \u0627\u0646 \u0647\u0630\u0627 \u0647\u0630\u0647 \u0630\u0644\u0643 \u0627\u0644\u062A\u064A \u0627\u0644\u0630\u064A \u0648 \u0623\u0648 \u0644\u0627 \u0645\u0627 \u0643\u0627\u0646 \u0639\u0646 \u0628\u0639\u062F \u0642\u062F \u0644\u0645 \u0628\u064A\u0646 \u0643\u0644",
  // Turkish
  "bir ve bu da de ile mi ne gibi ama icin olan var yok hem",
  // Vietnamese (common function words, diacritics lowercased)
  "la cua va trong cho den nhung cac voi nay nhu khong duoc con",
  // Hindi (Devanagari)
  "\u0915\u0947 \u0939\u0948 \u092E\u0947\u0902 \u0915\u093E \u0915\u0940 \u0938\u0947 \u0915\u094B \u0928\u0947 \u092F\u0939 \u0935\u0939 \u0914\u0930 \u092A\u0930 \u0907\u0938 \u0909\u0938 \u0928\u0939\u0940\u0902 \u0925\u093E \u0925\u0940 \u0925\u0947 \u0939\u0942\u0901 \u0939\u0948\u0902"
];
for (var _si = 0; _si < _sw.length; _si++) {
  var _words = _sw[_si].split(" ");
  for (var _wi = 0; _wi < _words.length; _wi++) {
    if (_words[_wi]) STOPWORDS[_words[_wi]] = 1;
  }
}

// --- Script detection for tokenization strategy ---
// Scripts that don't use spaces between words need character n-gram tokenization.

/**
 * Check if a character belongs to a script that needs n-gram segmentation.
 * Returns true for CJK (Chinese, Japanese Kanji, Korean), Japanese kana, and Thai.
 */
function needsNgramSegmentation(ch) {
  var code = ch.charCodeAt(0);
  return (code >= 0xAC00 && code <= 0xD7AF) ||  // Hangul Syllables (Korean)
         (code >= 0x3130 && code <= 0x318F) ||  // Hangul Compatibility Jamo
         (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK Unified Ideographs (Chinese/Kanji)
         (code >= 0x3400 && code <= 0x4DBF) ||  // CJK Extension A
         (code >= 0x3040 && code <= 0x309F) ||  // Hiragana (Japanese)
         (code >= 0x30A0 && code <= 0x30FF) ||  // Katakana (Japanese)
         (code >= 0x0E00 && code <= 0x0E7F);    // Thai
}

/**
 * Tokenize text for BM25. Multi-language support:
 * - Space-delimited scripts (Latin, Cyrillic, Arabic, Devanagari, etc.): word splitting
 * - Non-delimited scripts (CJK, Japanese, Thai): word + character bigrams
 * - Mixed text handled per-word
 */
function tokenize(text) {
  if (!text || typeof text !== "string") return [];

  var tokens = [];
  var words = text.toLowerCase().split(/[\s,.\-:;!?\u3001\u3002\u060C\u061B'"()\[\]{}<>|/\\@#$%^&*+=~`\u300C\u300D\u300E\u300F\u3010\u3011\uFF08\uFF09]+/);

  for (var i = 0; i < words.length; i++) {
    var word = words[i].trim();
    if (!word || word.length < 2) continue;
    if (STOPWORDS[word]) continue;

    // Check if word contains characters needing n-gram segmentation
    var hasNgram = false;
    for (var c = 0; c < word.length; c++) {
      if (needsNgramSegmentation(word[c])) { hasNgram = true; break; }
    }

    if (hasNgram) {
      // Non-delimited script: add whole word + character bigrams
      if (word.length >= 2) tokens.push(word);
      for (var bi = 0; bi < word.length - 1; bi++) {
        if (needsNgramSegmentation(word[bi]) || needsNgramSegmentation(word[bi + 1])) {
          tokens.push(word[bi] + word[bi + 1]);
        }
      }
    } else {
      // Space-delimited script (Latin, Cyrillic, Arabic, Devanagari, etc.)
      tokens.push(word);
    }
  }

  return tokens;
}

/**
 * Build BM25 index from generic documents.
 * @param {Array} docs - [{ id: any, text: string, meta: any }]
 * @returns {object} Index for searchIndex()
 */
function buildIndex(docs) {
  var indexed = [];
  var df = {};
  var totalLength = 0;

  for (var i = 0; i < docs.length; i++) {
    var tokens = tokenize(docs[i].text);
    var docTerms = {};
    var tf = {};

    for (var t = 0; t < tokens.length; t++) {
      var term = tokens[t];
      tf[term] = (tf[term] || 0) + 1;
      docTerms[term] = true;
    }

    var terms = Object.keys(docTerms);
    for (var dt = 0; dt < terms.length; dt++) {
      df[terms[dt]] = (df[terms[dt]] || 0) + 1;
    }

    indexed.push({ id: docs[i].id, tf: tf, length: tokens.length, meta: docs[i].meta });
    totalLength += tokens.length;
  }

  return { docs: indexed, df: df, N: indexed.length, avgdl: indexed.length > 0 ? totalLength / indexed.length : 0 };
}

/**
 * Search a BM25 index. Returns [{ id, score, meta }] sorted by score desc.
 */
function searchIndex(index, query, maxResults) {
  if (!index || index.N === 0) return [];
  maxResults = maxResults || MAX_RESULTS;

  var queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Deduplicate
  var seen = {};
  var unique = [];
  for (var q = 0; q < queryTokens.length; q++) {
    if (!seen[queryTokens[q]]) {
      seen[queryTokens[q]] = true;
      unique.push(queryTokens[q]);
    }
  }

  var scores = [];
  for (var d = 0; d < index.docs.length; d++) {
    var doc = index.docs[d];
    var score = 0;

    for (var qt = 0; qt < unique.length; qt++) {
      var term = unique[qt];
      var termFreq = doc.tf[term] || 0;
      if (termFreq === 0) continue;

      var docFreq = index.df[term] || 0;
      var idf = Math.log((index.N - docFreq + 0.5) / (docFreq + 0.5) + 1);
      var tfNorm = (termFreq * (K1 + 1)) /
        (termFreq + K1 * (1 - B + B * doc.length / index.avgdl));

      score += idf * tfNorm;
    }

    if (score > 0) {
      scores.push({ id: doc.id, score: score, meta: doc.meta });
    }
  }

  scores.sort(function (a, b) { return b.score - a.score; });
  return scores.slice(0, maxResults);
}

// ==========================================================================
// 2. DATA SOURCES - convert various data into generic {id, text, meta} docs
// ==========================================================================

/**
 * Convert a session's history into searchable documents.
 * Groups consecutive deltas into turns for better context.
 * Each "turn" (user message or assistant response block) becomes one document.
 *
 * lr-a3e175: `history` is passed in explicitly rather than read off
 * session.history so callers can supply a streaming disk-backed read
 * (sm.readSessionHistoryFromDisk) for sessions that are LRU-evicted or never
 * loaded into heap. Falls back to session.history for callers that already
 * have a fully-loaded session (or in tests) and don't pass one.
 */
function sessionHistoryToDocs(session, history) {
  var docs = [];
  history = history || session.history || [];
  var sessionMeta = {
    sessionId: session.localId || session.cliSessionId,
    sessionTitle: session.title || "New Session"
  };
  var currentText = "";
  var currentType = null;
  var turnIdx = 0;

  function flushTurn() {
    var text = currentText.trim();
    if (text && text.length > 10) {
      docs.push({
        id: "session:" + sessionMeta.sessionId + ":turn:" + turnIdx,
        text: text,
        meta: {
          source: "session",
          sessionId: sessionMeta.sessionId,
          sessionTitle: sessionMeta.sessionTitle,
          turnIdx: turnIdx,
          turnType: currentType,
          snippet: text.length > 200 ? text.substring(0, 200) + "..." : text
        }
      });
      turnIdx++;
    }
    currentText = "";
    currentType = null;
  }

  for (var i = 0; i < history.length; i++) {
    var entry = history[i];
    if (!SEARCHABLE_TYPES[entry.type]) continue;
    if (!entry.text) continue;

    if (entry.type === "user_message" || entry.type === "mention_user") {
      // New turn boundary
      flushTurn();
      currentType = entry.type;
      currentText = entry.text;
    } else if (entry.type === "delta") {
      // Continuation of assistant response
      if (currentType !== "delta") flushTurn();
      currentType = "delta";
      currentText += entry.text;
    } else {
      // mention_response and similar turn markers
      flushTurn();
      currentType = entry.type;
      currentText = entry.text;
    }
  }
  flushTurn();

  return docs;
}

// ==========================================================================
// 3. HIGH-LEVEL SEARCH API - the public interface
// ==========================================================================

/**
 * Search for command palette (Cmd+K). Replaces substring search in server.js.
 * Accepts pre-collected session data from all projects.
 *
 * @param {Array} projectSessions - [{ projectSlug, projectTitle, projectIcon, isMate, mateId, sessions }]
 *   where sessions = [{ localId, title, history, lastActivity, hidden }]
 * @param {string} query
 * @param {object} opts - { maxResults, getHistory }
 *   getHistory(session) - lr-a3e175: optional per-session history getter. When
 *   provided, called instead of reading session.history directly so a caller
 *   can supply a streaming disk-backed read (sm.readSessionHistoryFromDisk)
 *   for sessions that are LRU-evicted or never loaded into heap. Falls back
 *   to session.history when omitted.
 * @returns {Array} [{ projectSlug, projectTitle, projectIcon, sessionId, sessionTitle, lastActivity, matchType, snippet, score, isMate, mateId }]
 */
function searchPalette(projectSessions, query, opts) {
  opts = opts || {};
  if (!query || !query.trim()) return [];
  var maxResults = opts.maxResults || 30;
  var getHistory = typeof opts.getHistory === "function" ? opts.getHistory : null;

  var allDocs = [];

  for (var p = 0; p < projectSessions.length; p++) {
    var proj = projectSessions[p];
    var sessions = proj.sessions || [];

    for (var s = 0; s < sessions.length; s++) {
      var session = sessions[s];
      if (session.hidden) continue;

      // Title as a separate high-weight doc
      var title = session.title || "New Session";
      allDocs.push({
        id: "title:" + proj.projectSlug + ":" + session.localId,
        text: title + " " + title, // double weight for title
        meta: {
          source: "palette",
          projectSlug: proj.projectSlug,
          projectTitle: proj.projectTitle,
          projectIcon: proj.projectIcon || null,
          sessionId: session.localId,
          sessionTitle: title,
          lastActivity: session.lastActivity || session.createdAt || 0,
          isMate: proj.isMate || false,
          mateId: proj.mateId || null,
          matchType: "title",
          snippet: null
        }
      });

      // Content turns as docs. lr-a3e175: stream from disk via getHistory
      // when supplied instead of reading the possibly-unloaded/trimmed
      // session.history heap array directly (does not mutate heap/LRU state).
      var sessionHistory = getHistory ? getHistory(session) : session.history;
      var turnDocs = sessionHistoryToDocs(session, sessionHistory);
      for (var td = 0; td < turnDocs.length; td++) {
        var turnDoc = turnDocs[td];
        allDocs.push({
          id: turnDoc.id,
          text: turnDoc.text,
          meta: {
            source: "palette",
            projectSlug: proj.projectSlug,
            projectTitle: proj.projectTitle,
            projectIcon: proj.projectIcon || null,
            sessionId: session.localId,
            sessionTitle: title,
            lastActivity: session.lastActivity || session.createdAt || 0,
            isMate: proj.isMate || false,
            mateId: proj.mateId || null,
            matchType: "content",
            snippet: turnDoc.meta.snippet
          }
        });
      }
    }
  }

  if (allDocs.length === 0) return [];

  var index = buildIndex(allDocs);
  var raw = searchIndex(index, query, maxResults * 3); // over-fetch for dedup

  // Deduplicate: keep best match per session
  var bestPerSession = {};
  for (var r = 0; r < raw.length; r++) {
    var m = raw[r].meta;
    var key = m.projectSlug + ":" + m.sessionId;
    if (!bestPerSession[key] || raw[r].score > bestPerSession[key].score) {
      bestPerSession[key] = {
        projectSlug: m.projectSlug,
        projectTitle: m.projectTitle,
        projectIcon: m.projectIcon,
        sessionId: m.sessionId,
        sessionTitle: m.sessionTitle,
        lastActivity: m.lastActivity,
        matchType: m.matchType,
        snippet: m.snippet,
        score: raw[r].score,
        isMate: m.isMate,
        mateId: m.mateId
      };
      // If we already have a title match, upgrade to "both"
    } else if (bestPerSession[key].matchType !== m.matchType) {
      bestPerSession[key].matchType = "both";
      if (m.snippet && !bestPerSession[key].snippet) {
        bestPerSession[key].snippet = m.snippet;
      }
    }
  }

  // Sort by score desc, take top results
  var deduped = Object.keys(bestPerSession).map(function (k) { return bestPerSession[k]; });
  deduped.sort(function (a, b) { return b.score - a.score; });
  return deduped.slice(0, maxResults);
}

module.exports = {
  searchPalette: searchPalette,
};

