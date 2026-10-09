(function (root) {
  'use strict';
  var ROLES = ['composer', 'lyricist', 'arranger'];
  // Bump whenever description parsing or candidate rules change, so every
  // stored recheck stamp expires and those videos become recheck targets again.
  var PARSER_REVISION = '2026-10-09.2';
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
  function sameContributors(left, right) {
    // List formatting and order do not change attribution; punctuation within names can.
    var a = creditNames(String(left || '')).sort();
    var b = creditNames(String(right || '')).sort();
    return a.length === b.length && a.every(function (name, index) { return name === b[index]; });
  }
  function isRemix(title) { return /remix|リミックス/iu.test(title || ''); }
  function nameKeys(value) {
    return Array.from(new Set(String(value || '').split(/[,，、・\/／]/u).map(normalized).filter(Boolean)));
  }
  // How another source's names relate to a saved credit. Credits keep the name
  // used on the work, so a source that only spells the person differently
  // (real name, other script, other alias) is 'different', never a correction.
  function compareNames(saved, other) {
    var a = nameKeys(saved), b = nameKeys(other);
    if (!a.length || !b.length) return 'different';
    var covered = a.every(function (key) { return b.indexOf(key) !== -1; });
    if (covered) return a.length === b.length ? 'same' : 'adds';
    return 'different';
  }
  // Names on the auto-generated "Title · Artist · …" row. The row has no role
  // labels and its order varies by distributor, so it can show that a name is
  // present but never which role that name holds.
  function topicLineNames(description) {
    var lines = String(description || '').split(/\r?\n/), provided = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (/Provided to YouTube by/i.test(line)) { provided = true; continue; }
      if (!provided || !line) continue;
      if (line.indexOf(' · ') === -1) return [];
      return line.split(' · ').slice(1).map(function (field) { return field.trim(); }).filter(Boolean);
    }
    return [];
  }
  function namesOnTopicLine(value, topicNames) {
    var keys = nameKeys(value);
    var present = nameKeys((topicNames || []).join('/'));
    return keys.length > 0 && keys.every(function (key) { return present.indexOf(key) !== -1; });
  }

  // Compare complete title candidates, never substrings of song names.
  function titleKeys(title) {
    var candidates = [String(title || '').normalize('NFKC')];
    for (var quote of candidates[0].matchAll(/[「『]([^」』]+)[」』]/gu)) candidates.push(quote[1]);
    for (var i = 0; i < candidates.length; i++) {
      var value = candidates[i];
      var shorter = value.replace(/\s*#[^\s#]+(?:\s+#[^\s#]+)*\s*$/u, '').trim()
        .replace(/\s*【[^】]*】\s*$/u, '').trim();
      if (shorter && !candidates.includes(shorter)) candidates.push(shorter);
      var song = value.split(/\s+[\/／-]\s+/u)[0].trim();
      if (song && !candidates.includes(song)) candidates.push(song);
    }
    return new Set(candidates.map(normalized));
  }

  function nonSongHeading(line) {
    // Nested decoration, hashtags, and explicit notices are not song titles.
    // Ordinary bracketed/numbered titles still establish a section boundary.
    return /[\[【][\[【]|[\]】][\]】]/u.test(line)
      || /^#[^\s#]+(?:\s+#[^\s#]+)*$/u.test(line)
      || /^(?:[■◆●▶︎\s\[【]+)?(?:this\s+remix\s+is\s+unofficial|配信\s*\((?:subscribe|download)[^)]*\)|(?:en|jp)\s+credits\.?)[\]】\s]*$/iu.test(line);
  }

  // Headings bound evidence to a song/version. Unknown or conflicting sections
  // are held for review instead of concatenating everybody in the description.
  function analyze(description, title, extract, clean, creditTarget) {
    var scope = 'current', heading = '', section = 0;
    var targetKeys = titleKeys(title);
    var labels = new Set(), rejected = new Set();
    // Role-like text that the tokenizer cannot establish is not proof of absence.
    var roleHints = {
      composer: /作曲|作編曲|\b(?:composers?|compose|composition|composed\s+by|music)\b/iu,
      lyricist: /作詞|作詩|\b(?:lyricists?|lyrics?|words|songwriters?|written\s+by)\b/iu,
      arranger: /編曲|\b(?:arrangers?|arrange|arrangement|arranged\s+by)\b/iu
    };
    var namedSections = new Set(), matchedSections = new Set();
    var namedKey = '';
    var entries = [], excluded = [], hasVersionSections = false;
    var candidateLines = { composer: [], lyricist: [], arranger: [] };
    String(description || '').split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim();
      var segments = extract(line);
      var headingLine = segments.length && typeof segments[0].prefix === 'string'
        ? segments[0].prefix.trim().replace(/[/／|｜;；]+\s*$/u, '').trim() : trimmed;
      var marker = headingLine.normalize('NFKC').replace(/^[\s#■◆●・*\[【「『(]+|[\s\]】」』):：]+$/gu, '').trim();
      var original = /^(?:original(?:\s+(?:song|version|credits?))?|原曲(?:情報|クレジット)?)(?=\s*(?:[:：/|]|https?:\/\/|$))/iu.test(marker);
      if (original) {
        namedKey = ''; section++; scope = 'original'; heading = trimmed; hasVersionSections = true;
      } else if (/^(?:remix(?:\s+(?:version|credits?))?|リミックス(?:クレジット)?)$/iu.test(marker)) {
        namedKey = ''; section++; scope = isRemix(title) ? 'current' : 'unknown'; heading = trimmed; hasVersionSections = true;
      } else {
        var match = headingLine.match(/^(?:[「『【\[]([^」』】\]]+)[」』】\]](?:\s*[:：/|\-]?\s*.*)?|(?:曲名|楽曲|song|track|title)\s*[:：]\s*(.+)|[■◆#●•・*\-]+\s*(.+)|(?:\d{1,3}[.)．、]\s*|\d{1,3}\s+|\d{1,2}:\d{2}\s+)(.+))\s*$/iu);
        if (match && !nonSongHeading(headingLine)) {
          var name = (match[1] || match[2] || match[3] || match[4]).trim();
          if (!/^(?:credits?|クレジット|staff|スタッフ)$/iu.test(name) && !(match[1] && extract('[' + name + ']: Example Person').length)) {
            var key = normalized(name);
            var matches = key.length > 0 && targetKeys.has(key);
            if (isRemix(title) && !isRemix(name)) matches = false;
            namedKey = key;
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
        // A caption without credit evidence does not make earlier roles ambiguous.
        if (segment.roles.length && namedKey) {
          namedSections.add(namedKey);
          if (scope === 'current') matchedSections.add(namedKey);
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
      // Only composition and lyrics survive a remix; explicit current roles win.
      if (!selected.length && isRemix(title) && role !== 'arranger') {
        selected = excluded.filter(function (entry) { return entry.role === role && entry.scope === 'original'; });
      }
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
    return { credits: credits, evidence: evidence, held: held, reasons: reasons, candidateLines: candidateLines,
      topicNames: topicLineNames(description) };
  }

  // A stamp covers the parser revision and the role values it saw; a later
  // edit to any role makes the video a target again.
  function recheckStamp(record) {
    var text = PARSER_REVISION + '\u001f' + ROLES.map(function (role) { return String((record && record[role]) || ''); }).join('\u001f');
    var hash = 5381;
    for (var i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    return PARSER_REVISION + ':' + hash.toString(16);
  }
  function targets(records, scope, checked, limit, creditTarget, includeStamped) {
    return (records || []).filter(function (record) {
      return /^[\w-]{11}$/.test(record.videoId || '') && (!checked || !checked.has(record.videoId))
        && (includeStamped || record.creditsRecheck !== recheckStamp(record))
        && (scope !== 'remix' || isRemix(record.title))
        && ROLES.some(function (role) { return !creditTarget.creditIsBlank(record[role]) && creditTarget.effectiveRoleSource(record, role) !== 'manual'; });
    }).slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
  }

  function candidates(record, result, creditTarget) {
    if (!result || !result.ok || !result.maintenance) return [];
    return ROLES.filter(function (role) {
      var value = result.maintenance.credits[role];
      return value && !sameContributors(value, record[role]) && !creditTarget.creditIsBlank(record[role])
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
      if (isHeld && namesOnTopicLine(current, maintenance.topicNames)) roles[role].topicMatch = true;
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
  var api = { exportItem: exportItem, analyze: analyze, targets: targets, candidates: candidates, scan: scan, isRemix: isRemix,
    recheckStamp: recheckStamp, PARSER_REVISION: PARSER_REVISION, sameContributors: sameContributors,
    compareNames: compareNames, namesOnTopicLine: namesOnTopicLine, topicLineNames: topicLineNames };
  if (root) root.CreditMaintenance = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
