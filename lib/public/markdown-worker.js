// markdown-worker.js — off-main-thread markdown parsing
// Loaded as a Web Worker by markdown.js. Handles the marked.parse()
// call which is the heaviest synchronous operation on the main thread
// during streaming. DOMPurify.sanitize() stays on the main thread
// (requires DOM access) and runs on the returned HTML string.

importScripts("/marked.min.js");

// Mirror the exact configuration from markdown.js
marked.use({ gfm: true, breaks: false });

marked.use({
  renderer: {
    link: function (token) {
      var href = token.href || "";
      var title = token.title || "";
      var text = token.text || "";
      var isExternal = href.startsWith("http://") || href.startsWith("https://");
      var titleAttr = title ? ' title="' + title + '"' : "";
      var targetAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : "";
      return "<a href=\"" + href + "\"" + titleAttr + targetAttr + ">" + text + "</a>";
    }
  }
});

self.onmessage = function (e) {
  var id = e.data.id;
  var text = e.data.text;

  // Normalize smart quotes (mirrors renderMarkdown in markdown.js)
  var normalized = text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  var html;
  try {
    html = marked.parse(normalized);
  } catch (err) {
    html = "<p>" + text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>";
  }

  self.postMessage({ id: id, html: html });
};
