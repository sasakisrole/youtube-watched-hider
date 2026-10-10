(function (root) {
  'use strict';
  var ROLES = ['composer', 'lyricist', 'arranger'];
  // Bump whenever description parsing or candidate rules change, so every
  // stored recheck stamp expires and those videos become recheck targets again.
  var PARSER_REVISION = '2026-10-10.1';
  // Bump when proposal rules change without a parser change: stored proposals
  // from older rules are dropped and their videos become recheck targets again.
  var PROPOSAL_REVISION = '2026-10-10.3';
  function normalized(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }
  function creditNames(value, separators) {
    var depth = 0, start = 0, names = [];
    for (var i = 0; i < value.length; i++) {
      if ('(（[【'.includes(value[i])) depth++;
      else if (')）]】'.includes(value[i])) depth--;
      else if (!depth && /[,，、]/u.test(value[i])) {
        if (separators) separators.push(value[i]);
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
  // Romanized readings: case, word order and Hepburn long vowels
  // (ou/oo/oh, uu, and macrons as in "Saitō") are ignored, so "Ko Nakamura"
  // matches "Nakamura, Kou" and "Shinya Saito" matches "Saitō, Shin'ya".
  var JAPANESE_SCRIPT = /[\u3040-\u30ff\u3400-\u9fff]/u;
  function isLatinName(name) { return /[a-z]/iu.test(name) && !JAPANESE_SCRIPT.test(name); }
  function readingKey(value) {
    return String(value || '').normalize('NFKC').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().split(/[\s,，.・]+/u)
      .map(function (token) { return token.replace(/[^a-z]/g, '').replace(/ou|oo|oh(?![aeiou])/g, 'o').replace(/uu/g, 'u'); })
      .filter(Boolean).sort().join(' ');
  }
  // The Japanese-script name whose reading (MusicBrainz sort name) is this
  // romanized name, or ''. Aliases are deliberately not used: an alias may be
  // another name of the person, not the same name in another script.
  function japaneseForReading(latin, sortNames) {
    if (!isLatinName(latin) || !sortNames) return '';
    var key = readingKey(latin), found = '';
    Object.keys(sortNames).forEach(function (name) {
      if (!found && JAPANESE_SCRIPT.test(String(name).normalize('NFKC')) && key && readingKey(sortNames[name]) === key) found = name;
    });
    return found;
  }
  // Rewrites romanized saved names into the Japanese script MusicBrainz
  // records for the same reading; names without such a reading stay as
  // credited. Returns '' when nothing changes.
  function unifyReading(saved, sortNames) {
    var names = creditNames(String(saved || '')), changed = false;
    if (!names.length) return '';
    var out = names.map(function (name) {
      var japanese = japaneseForReading(name, sortNames);
      if (japanese) { changed = true; return japanese; }
      return name;
    });
    return changed ? Array.from(new Set(out)).join(', ') : '';
  }
  function mixedJapaneseNames(value) {
    var names = creditNames(String(value || ''));
    return names.some(isLatinName) ? names.filter(function (name) { return JAPANESE_SCRIPT.test(String(name).normalize('NFKC')); }) : [];
  }
  // Cache promises too, so concurrent roles and batches share each name search.
  function createArtistReadingLookup(query) {
    var cache = new Map();
    return async function (value, enabled, japanese) {
      if (!enabled || !japanese) return null;
      var names = mixedJapaneseNames(value), sortNames = {}, urls = [], complete = true, error = '';
      for (var name of names) {
        var normalizedName = name.normalize('NFKC');
        if (!cache.has(normalizedName)) cache.set(normalizedName, Promise.resolve().then(function (n) {
          return query(n);
        }.bind(null, normalizedName)).catch(function () { return null; }));
        var response = await cache.get(normalizedName);
        if (!response || !response.success) { complete = false; error = response && response.error || error; continue; }
        var exact = (response.artists || []).filter(function (artist) {
          return String(artist.name || '').normalize('NFKC') === normalizedName;
        });
        var keys = exact.map(function (artist) { return readingKey(artist['sort-name']); });
        if (!keys.length || !keys[0] || !keys.every(function (key) { return key === keys[0]; })) continue;
        // Keep the spelling already credited, including its normalization form.
        sortNames[name] = exact[0]['sort-name'];
        if (unifyReading(value, { [name]: sortNames[name] })) {
          exact.forEach(function (artist) { if (artist.id) urls.push('https://musicbrainz.org/artist/' + encodeURIComponent(artist.id)); });
        }
      }
      return { value: unifyReading(value, sortNames), urls: Array.from(new Set(urls)), complete: complete, error: error };
    };
  }
  // True when the two lists name the same people, allowing a romanized name
  // on one side to stand for its Japanese-script reading on the other.
  function sameByReading(left, right, sortNames) {
    var a = unifyReading(left, sortNames) || String(left || '');
    var b = unifyReading(right, sortNames) || String(right || '');
    return compareNames(a, b) === 'same';
  }
  // Topic descriptions romanize Japanese credits, so a Japanese name facing only
  // a romanized one is a spelling of the same credit, not evidence of a mistake.
  function scriptOnlyRename(saved, proposed) {
    function split(value) { return String(value || '').split(/[,，、・\/／]/u).map(function (name) { return name.trim(); }).filter(Boolean); }
    // Only the saved side splits on ・ and /: a proposed "R・O・N" is one name.
    var before = split(saved), after = creditNames(String(proposed || ''));
    var keysBefore = before.map(normalized), keysAfter = after.map(normalized);
    var gone = before.filter(function (name, i) { return keysAfter.indexOf(keysBefore[i]) === -1; });
    var added = after.filter(function (name, i) { return keysBefore.indexOf(keysAfter[i]) === -1; });
    return gone.length > 0 && gone.length === added.length
      && gone.every(function (name) { return JAPANESE_SCRIPT.test(name); }) && added.every(isLatinName);
  }
  // True when an added or removed name sits beside a name in the other script
  // (romanized vs Japanese). Descriptions often credit one person twice, as
  // "Lyricist: Eiko Shimamiya" and "Lyricist: 島みやえい子"; without a reading
  // that may be the same person, so such a change is reviewed one by one.
  // A name in `distinct` was seen beside several unrelated names in the other
  // script, so it cannot be the reading of any one of them.
  function scriptMixedChange(saved, proposed, distinct) {
    function script(name) { return isLatinName(name) ? 'latin' : JAPANESE_SCRIPT.test(name) ? 'ja' : ''; }
    var before = creditNames(String(saved || '')), after = creditNames(String(proposed || ''));
    var keysBefore = before.map(normalized), keysAfter = after.map(normalized);
    var changed = after.filter(function (name, i) { return keysBefore.indexOf(keysAfter[i]) === -1; })
      .concat(before.filter(function (name, i) { return keysAfter.indexOf(keysBefore[i]) === -1; }));
    return changed.some(function (name) {
      if (distinct && distinct.has(normalized(name))) return false;
      var own = script(name);
      return own && after.some(function (other) { var s = script(other); return s && s !== own; });
    });
  }
  function distinctNames(entries) {
    function script(name) { return isLatinName(name) ? 'latin' : JAPANESE_SCRIPT.test(name) ? 'ja' : ''; }
    var seen = new Map(), aliases = new Set();
    (entries || []).forEach(function (entry) {
      // A name MusicBrainz already matched to a Japanese reading is a spelling, not another person.
      if (entry.source === 'musicbrainz-reading') {
        var kept = creditNames(String(entry.value || '')).map(normalized);
        creditNames(String(entry.saved || '')).map(normalized).forEach(function (key) { if (kept.indexOf(key) === -1) aliases.add(key); });
      }
      var before = creditNames(String(entry.saved || '')).map(normalized);
      var after = creditNames(String(entry.value || ''));
      after.forEach(function (name) {
        var key = normalized(name), own = script(name);
        if (!own || before.indexOf(key) !== -1) return;
        var others = after.filter(function (other) { var s = script(other); return s && s !== own; }).map(normalized);
        if (!others.length) return;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(others);
      });
    });
    var distinct = new Set();
    seen.forEach(function (groups, key) {
      var union = new Set([].concat.apply([], groups));
      var shared = groups.reduce(function (common, group) { return common.filter(function (name) { return group.indexOf(name) !== -1; }); }, groups[0]);
      if (groups.length > 1 && union.size > 1 && !shared.length && !aliases.has(key)) distinct.add(key);
    });
    return distinct;
  }
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
  // Lines that name a producer, label, publisher or the song itself, never a role.
  var META_LABEL = /^(?:producers?|music\s+directors?|(?:music\s+)?labels?|(?:music\s+)?publishers?|(?:music|song)\s+title|曲名|プロデューサー|レーベル)$/iu;
  var HONORIFIC_ONLY = /^\s*(?:様|さん|氏|先生)\s*$/u;
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
    var nonSongLines = [], linkedSong = false, metaValues = [];
    var materialHeading = '';
    // Only attribution labels count; a phrase such as "Event Menu BGM" names the track itself.
    var materialPattern = /(?:^|[\s【\[■◆●▼・#])BGM\s*(?:[:：】\]]|by\b|提供)|使用楽曲|使用曲|音楽素材|使用素材|使用させていただいた素材|Music provided by/iu;
    // A quoted anime or game name in the title is the work, not the song.
    var workKeys = new Set();
    for (var work of String(title || '').normalize('NFKC').matchAll(/(?:アニメ|映画|劇場版|ドラマ|ゲーム)\s*[「『]([^」』]+)[」』]/gu)) workKeys.add(normalized(work[1]));
    String(description || '').split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) materialHeading = '';
      var segments = extract(line);
      var headingLine = segments.length && typeof segments[0].prefix === 'string'
        ? segments[0].prefix.trim().replace(/[/／|｜;；]+\s*$/u, '').trim() : trimmed;
      var marker = headingLine.normalize('NFKC').replace(/^[\s#■◆●・*\[【「『(]+|[\s\]】」』):：]+$/gu, '').trim();
      if (materialPattern.test(headingLine)) materialHeading = trimmed;
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
            if (matches && !workKeys.has(key)) linkedSong = true;
            if (!materialPattern.test(headingLine)) materialHeading = '';
            if (isRemix(title) && !isRemix(name)) matches = false;
            namedKey = key;
            section++; scope = matches ? 'current' : 'other'; heading = trimmed;
          }
        }
      }
      if (trimmed.includes(' · ') && targetKeys.has(normalized(trimmed.split(' · ')[0]))) linkedSong = true;
      var titleLine = /^(?:music\s+title|song\s+title|曲名)\s*[:：]\s*(.+)$/iu.exec(trimmed);
      if (titleLine && targetKeys.has(normalized(titleLine[1]))) linkedSong = true;
      var meta = /^([^:：]{2,40}?)\s*[:：]\s*(.+)$/u.exec(trimmed);
      if (meta && meta[1].split(/\s*[,，&\/／]\s*/u).every(function (label) { return META_LABEL.test(label.trim()); })) {
        metaValues.push(normalized(meta[2]));
      }
      if (materialPattern.test(trimmed) || (materialHeading && segments.length)) {
        nonSongLines.push({line: trimmed, heading: materialHeading, roles: segments.flatMap(function (s) { return s.roles; })});
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
      topicNames: topicLineNames(description), nonSongLines: nonSongLines, linkedSong: linkedSong, metaValues: metaValues };
  }

  // A stamp covers the parser revision and the role values it saw; a later
  // edit to any role makes the video a target again.
  // ':mb' marks a check that also consulted MusicBrainz; it satisfies a plain
  // check, but a MusicBrainz check still revisits videos stamped without it.
  // ':src' marks a check that also looked at confirmed values (since v1.60.51);
  // only videos that have one are revisited for it, not the whole history.
  // ':artist' records the exact-name reading check for mixed-script fields.
  // ':held' / ':clear' record whether the video still had held roles or proposals
  // needing review; stamps without either predate it and count as unknown.
  function recheckStamp(record, withMb, withSource, withArtist, held) {
    var text = PARSER_REVISION + '\u001f' + ROLES.map(function (role) { return String((record && record[role]) || ''); }).join('\u001f');
    var hash = 5381;
    for (var i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    return PARSER_REVISION + ':' + hash.toString(16) + (withMb ? ':mb' : '') + (withSource ? ':src' : '') + (withArtist ? ':artist' : '')
      + (held === true ? ':held' : held === false ? ':clear' : '');
  }
  // Flags of a stamp for the record's current values, or null when stale.
  function stampFlags(record) {
    var stamp = String((record && record.creditsRecheck) || ''), base = recheckStamp(record);
    if (stamp.indexOf(base) !== 0) return null;
    var rest = stamp.slice(base.length);
    if (!/^(?::mb)?(?::src)?(?::artist)?(?::held|:clear)?$/.test(rest)) return null;
    return { mb: rest.indexOf(':mb') !== -1, source: rest.indexOf(':src') !== -1, artist: rest.indexOf(':artist') !== -1,
      held: /:held$/.test(rest) ? true : /:clear$/.test(rest) ? false : undefined };
  }
  // Confirmed (manual) roles are only revisited by a MusicBrainz check, and
  // only when romanized, since the sole change allowed to them is the same
  // name written in Japanese.
  function hasManualRomanized(record, creditTarget) {
    return ROLES.some(function (role) {
      return creditTarget.effectiveRoleSource(record, role) === 'manual' && isLatinName(String(record[role] || ''));
    });
  }
  function targets(records, scope, checked, limit, creditTarget, includeStamped, withMb) {
    return (records || []).filter(function (record) {
      var flags = stampFlags(record);
      var manualReading = !!withMb && hasManualRomanized(record, creditTarget);
      var auto = ROLES.some(function (role) { return !creditTarget.creditIsBlank(record[role]) && creditTarget.effectiveRoleSource(record, role) !== 'manual'; });
      // A confirmed value may be one adopted before adoptions kept the recheck
      // source; checking it once lets a description-backed one become correctable.
      var manualValue = ROLES.some(function (role) { return !creditTarget.creditIsBlank(record[role]) && creditTarget.effectiveRoleSource(record, role) === 'manual'; });
      // A MusicBrainz check revisits videos last checked without it when it could
      // change something there (an automatic value, or a romanized confirmed one).
      var mixedReading = !!withMb && ROLES.some(function (role) { return mixedJapaneseNames(record[role]).length; });
      var cleanupDue = ROLES.some(function (role) { return creditTarget.effectiveRoleSource(record, role) !== 'manual' && creditTarget.cleanupCreditValue(record[role], record.title); });
      var due = cleanupDue || includeStamped || !flags || (mixedReading && !flags.artist) || (!!withMb && !flags.mb && (auto || manualReading)) || (manualValue && !flags.source);
      // The held scope revisits only videos left with held roles or proposals to review.
      if (scope === 'held') due = !flags || flags.held !== false;
      return /^[\w-]{11}$/.test(record.videoId || '') && (!checked || !checked.has(record.videoId))
        && due && (scope !== 'remix' || isRemix(record.title)) && (auto || manualReading || manualValue);
    }).slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
  }

  function namesOnLine(line, value) {
    var text = String(line || '').normalize('NFKC'), names = creditNames(String(value || ''));
    return names.length > 0 && names.every(function (name) {
      var escaped = name.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(?:^|[^\\p{L}\\p{N}])' + escaped + '(?:$|[^\\p{L}\\p{N}])', 'iu').test(text);
    });
  }
  // True when the change only drops names that the description gives as a
  // producer, label, publisher or song title, so nothing about the credit is guessed.
  function removesOnlyMeta(saved, value, metaValues) {
    var before = creditNames(String(saved || '')), after = creditNames(String(value || '')).map(normalized);
    var keys = before.map(normalized);
    var removed = keys.filter(function (key) { return after.indexOf(key) === -1; });
    return removed.length > 0 && after.every(function (key) { return keys.indexOf(key) !== -1; })
      && removed.every(function (key) { return (metaValues || []).indexOf(key) !== -1; });
  }
  function candidates(record, result, creditTarget) {
    if (!result || !result.ok || !result.maintenance) return [];
    return ROLES.map(function (role) {
      var value = result.maintenance.credits[role], saved = record[role];
      if (creditTarget.creditIsBlank(saved) || creditTarget.effectiveRoleSource(record, role) === 'manual') return null;
      var cleanup = creditTarget.cleanupCreditValue(saved, record.title);
      var analysis = result.maintenance;
      // Soundtrack uploads are the music itself even when the description says BGM.
      var nonSongCheck = creditTarget.effectiveRoleSource(record, role) === 'general'
        && !/\bOST\b|サウンドトラック|soundtrack/iu.test(record.title || '') && analysis.linkedSong === false;
      // A song's own MV can name its tie-in or supplier, so material lines count only when no heading or Topic row ties the description to this title.
      var material = nonSongCheck && (analysis.nonSongLines || []).find(function (entry) {
        return (entry.roles.includes(role) || !entry.roles.length) && namesOnLine(entry.line, cleanup ? cleanup.value : saved);
      });
      // Every name carrying an honorific or a singer note means the value was copied from another work's credit line.
      var chunks = creditNames(String(saved));
      // An honorific alone is usual in cover credits, so it is cleaned rather than cleared.
      var annotated = nonSongCheck && chunks.length && chunks.every(function (chunk) { return creditTarget.cleanupCreditValue(chunk, record.title); })
        && chunks.some(function (chunk) { return !HONORIFIC_ONLY.test(creditTarget.cleanupCreditValue(chunk, record.title).removed); })
        && (analysis.candidateLines[role] || []).length;
      if (material || annotated) {
        return { videoId: record.videoId, role: role, value: '', source: 'description-nonsong',
          sourceDetail: 'https://www.youtube.com/watch?v=' + record.videoId,
          evidence: material ? (material.heading + '\n' + material.line).trim() : analysis.candidateLines[role].join('\n'), selected: false };
      }
      // A name followed by a separate singer credit came from another song's line; a slash-joined singer is the same line.
      if (nonSongCheck && chunks.length > 1) {
        var kept = chunks.filter(function (chunk) {
          var tidy = creditTarget.cleanupCreditValue(chunk, record.title);
          return !(tidy && /^\s+(?:歌唱|vo\.|vocals?)/iu.test(tidy.removed));
        });
        if (kept.length && kept.length < chunks.length) return { videoId: record.videoId, role: role, value: kept.join(', '),
          source: 'description-cleanup', sourceDetail: 'https://www.youtube.com/watch?v=' + record.videoId,
          evidence: chunks.filter(function (chunk) { return kept.indexOf(chunk) === -1; }).join(', '), selected: false };
      }
      if (cleanup) return { videoId: record.videoId, role: role, value: cleanup.value,
        source: 'description-cleanup', sourceDetail: 'https://www.youtube.com/watch?v=' + record.videoId,
        evidence: cleanup.removed, selected: false };
      var source = 'description-recheck';
      var tidy = value && creditTarget.cleanupCreditValue(value, record.title);
      if (tidy) value = tidy.value;
      if (!value || sameContributors(value, saved)) {
        var separators = [], names = creditNames(saved, separators);
        if (!separators.some(function (separator) { return /[、，]/u.test(separator); })) return null;
        value = names.join(', ');
        source = 'description-format';
      }
      if (source === 'description-recheck' && scriptOnlyRename(saved, value)) return null;
      if (!creditTarget.isValidCreditValue(value, result.title)) return null;
      var proposal = { videoId: record.videoId, role: role, value: value,
        source: source, sourceDetail: 'https://www.youtube.com/watch?v=' + record.videoId,
        evidence: result.maintenance.evidence[role], selected: false };
      if (source === 'description-recheck' && removesOnlyMeta(saved, value, analysis.metaValues)) proposal.metaOnly = true;
      return proposal;
    }).filter(Boolean);
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
  // Recheck-only presentation policy; history verification states stay unchanged.
  function proposalBucket(saved, proposal, adopted, distinct) {
    if (adopted) return 'adopted';
    var value = proposal.value === undefined ? proposal.to : proposal.value;
    if (proposal.metaOnly && proposal.source === 'description-recheck') return 'bulk';
    if (proposal.source === 'description-nonsong' || proposal.source === 'description-cleanup'
      || (JAPANESE_SCRIPT.test(String(saved || '').normalize('NFKC')) && isLatinName(value))) return 'visual';
    var adds = compareNames(saved, value) === 'adds' || compareNames(value, saved) === 'adds';
    return adds && scriptMixedChange(saved, value, distinct) ? 'visual' : 'bulk';
  }
  function pendingProposals(entries, records, creditTarget) {
    var byId = new Map(records.map(function (r) { return [r.videoId, r]; }));
    return (Array.isArray(entries) ? entries : []).filter(function (entry) {
      var record = entry && byId.get(entry.videoId);
      return record && ROLES.includes(entry.role) && entry.savedValue === (record[entry.role] || '')
        && entry.savedSource === creditTarget.effectiveRoleSource(record, entry.role);
    });
  }
  // What a recheck proposal changes, so a card can say it in words; current and
  // candidate values often differ only by a separator or one added name.
  function changeSummary(saved, proposal) {
    var source = proposal && proposal.source, value = String(proposal && proposal.value || '');
    if (source === 'description-format') return { kind: 'format' };
    if (source === 'description-nonsong' || !value) return { kind: 'clear' };
    if (source === 'description-cleanup') return { kind: 'cleanup' };
    if (source === 'musicbrainz-reading') return { kind: 'reading' };
    var before = creditNames(String(saved || '')), after = creditNames(value);
    var beforeKeys = before.map(normalized), afterKeys = after.map(normalized);
    var added = after.filter(function (name, i) { return beforeKeys.indexOf(afterKeys[i]) === -1; });
    var removed = before.filter(function (name, i) { return afterKeys.indexOf(beforeKeys[i]) === -1; });
    return added.length || removed.length ? { kind: 'names', added: added, removed: removed } : { kind: 'spelling' };
  }
  var api = { distinctNames: distinctNames, removesOnlyMeta: removesOnlyMeta, stampFlags: stampFlags, changeSummary: changeSummary, scriptOnlyRename: scriptOnlyRename, proposalBucket: proposalBucket, pendingProposals: pendingProposals, exportItem: exportItem, analyze: analyze, targets: targets, candidates: candidates, scan: scan, isRemix: isRemix,
    recheckStamp: recheckStamp, PARSER_REVISION: PARSER_REVISION, PROPOSAL_REVISION: PROPOSAL_REVISION, sameContributors: sameContributors,
    compareNames: compareNames, namesOnTopicLine: namesOnTopicLine, topicLineNames: topicLineNames,
    mixedJapaneseNames: mixedJapaneseNames, createArtistReadingLookup: createArtistReadingLookup,
    unifyReading: unifyReading, sameByReading: sameByReading, isLatinName: isLatinName, scriptMixedChange: scriptMixedChange };
  if (root) root.CreditMaintenance = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
