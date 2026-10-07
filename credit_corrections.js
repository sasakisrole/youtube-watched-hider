(function (root) {
  'use strict';
  var ROLES = ['composer', 'lyricist', 'arranger'];
  function normalized(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }
  function creditNames(value) {
    var depth = 0, start = 0, names = [];
    for (var i = 0; i < value.length; i++) {
      if ('(（[【'.includes(value[i])) depth++;
      else if (')）]】'.includes(value[i])) depth--;
      else if (!depth && /[,，、]/u.test(value[i])) {
        names.push(value.slice(start, i).trim()); start = i + 1;
      }
    }
    names.push(value.slice(start).trim());
    return names.filter(Boolean);
  }
  function isRemix(title) { return /remix|リミックス/iu.test(title || ''); }

  // Headings bound evidence to a song/version. Unknown or conflicting sections
  // are held for review instead of concatenating everybody in the description.
  function analyze(description, title, extract, clean, creditTarget) {
    var scope = 'current', heading = '', section = 0;
    var labels = new Set(), rejected = new Set();
    // Role-like text that the tokenizer cannot establish is not proof of absence.
    var roleHints = {
      composer: /作曲|作編曲|\b(?:composers?|compose|composition|composed\s+by|music)\b/iu,
      lyricist: /作詞|作詩|\b(?:lyricists?|lyrics?|words|songwriters?|written\s+by)\b/iu,
      arranger: /編曲|\b(?:arrangers?|arrange|arrangement|arranged\s+by)\b/iu
    };
    var namedSections = new Set(), matchedSections = new Set();
    var entries = [], excluded = [], hasVersionSections = false;
    var candidateLines = { composer: [], lyricist: [], arranger: [] };
    String(description || '').split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim();
      var segments = extract(line);
      var headingLine = segments.length && typeof segments[0].prefix === 'string'
        ? segments[0].prefix.trim().replace(/[/／|｜;；]+\s*$/u, '').trim() : trimmed;
      var marker = headingLine.normalize('NFKC').replace(/^[\s#■◆●・*\[【「『(]+|[\s\]】」』):：]+$/gu, '').trim();
      var original = /^(?:original(?:\s+(?:song|version|credits?))?|原曲(?:情報|クレジット)?)(?=\s*(?:[:：/|]|$))/iu.test(marker);
      if (original) {
        section++; scope = 'original'; heading = trimmed; hasVersionSections = true;
      } else if (/^(?:remix(?:\s+(?:version|credits?))?|リミックス(?:クレジット)?)$/iu.test(marker)) {
        section++; scope = isRemix(title) ? 'current' : 'unknown'; heading = trimmed; hasVersionSections = true;
      } else {
        var match = headingLine.match(/^(?:[「『【\[]([^」』】\]]+)[」』】\]](?:\s*[:：/|\-]?\s*.*)?|(?:曲名|楽曲|song|track|title)\s*[:：]\s*(.+)|[■◆#●•・*\-]+\s*(.+)|(?:\d{1,3}[.)．、]\s*|\d{1,3}\s+|\d{1,2}:\d{2}\s+)(.+))\s*$/iu);
        if (match) {
          var name = (match[1] || match[2] || match[3] || match[4]).trim();
          if (!/^(?:credits?|クレジット|staff|スタッフ)$/iu.test(name) && !(match[1] && extract('[' + name + ']: Example Person').length)) {
            var key = normalized(name), target = normalized(title);
            var matches = key.length > 0 && target === key;
            if (isRemix(title) && !isRemix(name)) matches = false;
            namedSections.add(key);
            if (matches) matchedSections.add(key);
            section++; scope = matches ? 'current' : 'other'; heading = trimmed;
          }
        }
      }
      // Preserve only role-related lines and their section heading, including
      // rejected values and role-like text that could not be tokenized.
      ROLES.forEach(function (role) {
        if (segments.some(function (segment) { return segment.roles.includes(role); }) || roleHints[role].test(line)) {
          if (heading && heading !== trimmed) candidateLines[role].push(heading);
          candidateLines[role].push(trimmed);
        }
      });
      segments.forEach(function (segment) {
        var value = clean(segment.value);
        segment.roles.forEach(function (role) { labels.add(role); });
        if (!creditTarget.isValidCreditValue(value, title)) {
          segment.roles.forEach(function (role) { rejected.add(role); });
          return;
        }
        segment.roles.forEach(function (role) {
          var entry = { role: role, value: value, evidence: (heading ? heading + '\n' : '') + trimmed, scope: scope, named: !!heading, section: section };
          if (scope === 'current') entries.push(entry); else excluded.push(entry);
        });
      });
    });
    var credits = {}, evidence = {}, held = [], reasons = {};
    ROLES.forEach(function (role) {
      var selected = entries.filter(function (entry) { return entry.role === role; });
      // Repeated role lines in the same scope describe co-contributors.
      // Split only list punctuation; preserve slashes and parenthesized band names.
      var values = Array.from(new Set(selected.flatMap(function (entry) {
        return creditNames(entry.value);
      })));
      var originals = Array.from(new Set(selected.map(function (entry) { return entry.value; })));
      // Preserve existing punctuation when a single complete list needs no merge.
      var joined = originals.length === 1 && creditNames(originals[0]).length === values.length
        ? originals[0] : values.join(', ');
      var ambiguous = matchedSections.size > 1
        || ((namedSections.size > 0 || hasVersionSections) && selected.some(function (entry) { return !entry.named; }));
      // Different complete lists under repeated matching headings disagree.
      // Multiple lines inside one section still describe co-contributors.
      var sections = new Map();
      selected.forEach(function (entry) {
        if (!entry.named) return;
        if (!sections.has(entry.section)) sections.set(entry.section, new Set());
        creditNames(entry.value).forEach(function (name) { sections.get(entry.section).add(normalized(name)); });
      });
      var conflict = new Set(Array.from(sections.values()).map(function (names) {
        return Array.from(names).sort().join('|');
      })).size > 1;
      credits[role] = !conflict && !ambiguous && creditTarget.isValidCreditValue(joined, title) ? joined : '';
      evidence[role] = credits[role] ? selected.map(function (entry) { return entry.evidence; }).join('\n') : '';
      if (conflict || ambiguous || (!credits[role] && excluded.some(function (entry) { return entry.role === role; }))) held.push(role);
      if (!credits[role]) {
        var outside = excluded.some(function (entry) { return entry.role === role; });
        reasons[role] = conflict ? 'conflict'
          : !labels.has(role) ? (roleHints[role].test(description || '') ? 'unknown' : 'no-evidence')
          : ambiguous ? 'unknown'
          : outside && !selected.length && !rejected.has(role) ? 'scope-mismatch'
          : !outside && (rejected.has(role) || selected.length) ? 'unparsed'
          : 'unknown';
      }
    });
    return { credits: credits, evidence: evidence, held: held, reasons: reasons, candidateLines: candidateLines };
  }

  function targets(records, scope, checked, limit, creditTarget) {
    return (records || []).filter(function (record) {
      return /^[\w-]{11}$/.test(record.videoId || '') && (!checked || !checked.has(record.videoId))
        && (scope !== 'remix' || isRemix(record.title))
        && ROLES.some(function (role) { return !creditTarget.creditIsBlank(record[role]) && creditTarget.effectiveRoleSource(record, role) !== 'manual'; });
    }).slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
  }

  function candidates(record, result, creditTarget) {
    if (!result || !result.ok || !result.maintenance) return [];
    return ROLES.filter(function (role) {
      var value = result.maintenance.credits[role];
      return value && value !== record[role] && !creditTarget.creditIsBlank(record[role])
        && creditTarget.effectiveRoleSource(record, role) !== 'manual'
        && creditTarget.isValidCreditValue(value, result.title);
    }).map(function (role) {
      return { videoId: record.videoId, role: role, value: result.maintenance.credits[role],
        source: 'description-recheck', sourceDetail: 'https://www.youtube.com/watch?v=' + record.videoId,
        evidence: result.maintenance.evidence[role], selected: false };
    });
  }

  // A diagnostic snapshot; never include the full description or fetch payload.
  function exportItem(record, result, creditTarget) {
    var ok = !!(result && result.ok), maintenance = ok && result.maintenance || {};
    var proposed = candidates(record, result, creditTarget);
    var roles = {}, hasHeld = false;
    ROLES.forEach(function (role) {
      var current = record[role] || '';
      var source = creditTarget.effectiveRoleSource(record, role) === 'manual' ? 'manual' : 'auto';
      var candidate = (maintenance.credits || {})[role] || '';
      var isHeld = ok && !creditTarget.creditIsBlank(current) && source !== 'manual' && !candidate;
      hasHeld = hasHeld || isHeld;
      var lines = (maintenance.candidateLines || {})[role];
      if (!Array.isArray(lines)) lines = ((maintenance.evidence || {})[role] || '').split(/\r?\n/).filter(Boolean);
      roles[role] = { current: current, currentSource: source, candidate: candidate,
        heldReason: isHeld ? (maintenance.reasons || {})[role] || 'unknown' : '',
        evidence: lines.slice() };
    });
    return { videoId: record.videoId || '', title: record.title || '', channel: record.channel || '',
      status: !ok ? 'failed' : proposed.length ? 'proposal' : hasHeld ? 'held' : 'ok',
      fetchReason: !ok && result && result.reason || '', roles: roles };
  }

  async function scan(videoIds, fetchCredits, onProgress, signal) {
    var ids = Array.from(new Set((videoIds || []).filter(function (id) { return /^[\w-]{11}$/.test(id); }))).slice(0, 500);
    var processed = 0, failed = 0, stopped = '';
    for (var id of ids) {
      if (signal && signal.aborted) break;
      var result;
      try { result = await fetchCredits(id, signal); } catch (_error) { result = { ok: false, reason: 'fetch-error' }; }
      if ((signal && signal.aborted) || result.aborted) break;
      processed++;
      if (!result.ok) failed++;
      onProgress({ videoId: id, processed: processed, total: ids.length, failed: failed, result: result });
      if (['sorry-redirect', 'no-youtube-tab', 'proxy-failed'].includes(result.reason)) { stopped = result.reason; break; }
    }
    return { success: true, processed: processed, total: ids.length, failed: failed, stopped: stopped, aborted: !!(signal && signal.aborted) };
  }
  var api = { exportItem: exportItem, analyze: analyze, targets: targets, candidates: candidates, scan: scan, isRemix: isRemix };
  if (root) root.CreditMaintenance = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
