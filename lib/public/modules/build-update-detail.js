// build-update-detail.js — the body of a "newer build installed" diagnostic:
// which build is running, which is installed, and the commits between them
// when git history was available. Every value is set with textContent: commit
// subjects are repository content, never markup.

var SHORT_SHA_LENGTH = 12;

export function shortSha(sha) {
  return typeof sha === 'string' && sha ? sha.slice(0, SHORT_SHA_LENGTH) : '(unknown)';
}

function line(className, text) {
  var el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * @param {{loadedBuildSha: ?string, installedBuildSha: ?string, reason: string,
 *          changes: {available: boolean, commits: Array<{sha: string, subject: string}>, truncated: boolean, reason: ?string}}} offer
 * @returns {?HTMLElement} null when the diagnostic carries no offer
 */
export function buildUpdateDetailEl(offer) {
  if (!offer || typeof offer !== 'object') return null;
  var root = document.createElement('div');
  root.className = 'build-update-detail';

  root.appendChild(line('build-update-builds',
    'Running: ' + shortSha(offer.loadedBuildSha) + '    Installed: ' + shortSha(offer.installedBuildSha)));

  var changes = offer.changes || {};
  if (offer.reason === 'content') {
    root.appendChild(line('build-update-note',
      'Both report the same build, but the installed files differ from the ones this process loaded.'));
  } else if (changes.available && Array.isArray(changes.commits) && changes.commits.length > 0) {
    root.appendChild(line('build-update-heading', 'Changes since the running build:'));
    var list = document.createElement('ul');
    list.className = 'build-update-commits';
    changes.commits.forEach(function (c) {
      var item = document.createElement('li');
      item.textContent = shortSha(c.sha).slice(0, 8) + ' ' + c.subject;
      list.appendChild(item);
    });
    root.appendChild(list);
    if (changes.truncated) root.appendChild(line('build-update-note', 'More commits not shown.'));
  } else if (changes.available) {
    root.appendChild(line('build-update-note', 'No commits between these builds were found in the available history.'));
  } else {
    root.appendChild(line('build-update-note',
      'Change list unavailable' + (changes.reason ? ': ' + changes.reason : '') + '.'));
  }
  return root;
}
