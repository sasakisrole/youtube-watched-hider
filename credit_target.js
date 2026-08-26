// Path A (概要欄 Fix Credits) target selection — HANDOFF §3.1 + §3.4 (lightweight).
//
// Role-unit targeting: a video is a Fix-Credits target when ANY of
// composer / lyricist / arranger is still blank — not only when ALL three are
// blank. The old whole-video gate excluded a video as soon as one role (or a
// raw credit line) was present, so "composer filled, arranger blank" videos
// were stranded and never re-scanned.
//
// Re-fetch cool-down: the YouTube 概要欄 is a SINGLE source, so re-reading an
// unchanged description yields the same result. Role-unit targeting without a
// cool-down would re-fetch partial-credit videos every run and risk YouTube's
// bot challenge. This lightweight form gates re-fetch by the existing
// `creditsCheckedAt` timestamp (which, for this path, IS the YouTube-source
// check time). Repeated empty descriptions get a longer, capped window; a
// never-checked video (including unstamped fetch failures) stays immediately
// eligible.
//
// Loaded as a plain script by the history/offscreen pages and service worker
// (sets globalThis.CreditTarget), and as a CommonJS module in Node tests.
(function (root) {
  'use strict';

  var CREDIT_ROLES = ['composer', 'lyricist', 'arranger'];
  var CREDIT_ROLE_SOURCES = ['topic', 'general', 'enrich:rule', 'enrich:mb', 'manual'];

  // 30 days — matches DESIGN B-9 RETRY.YOUTUBE_NOT_FOUND.
  var CREDIT_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
  var CREDIT_RECHECK_EMPTY_MS = 180 * 24 * 60 * 60 * 1000;
  var CREDIT_RECHECK_EMPTY_MAX_MS = 720 * 24 * 60 * 60 * 1000;
  var CREDIT_RECHECK_SPREAD_MS = 30 * 24 * 60 * 60 * 1000;
  // MusicBrainz successful negative/partial results are stable enough to avoid
  // repeating the same lookup on every Enrich Credits run.
  var MB_RECHECK_MS = 90 * 24 * 60 * 60 * 1000;
  var MB_ERROR_BASE_MS = 60 * 60 * 1000;
  var MB_ERROR_MAX_MS = 24 * 60 * 60 * 1000;
  var MB_LOOKUP_STATUSES = ['found', 'not-found', 'no-roles', 'error'];

  var TOPIC_SUFFIX_RE = /\s*-\s*(?:topic|トピック)\s*$/i;
  var CREDIT_ROLE_TEXT_RE = /(?:作詞(?:家|者)?|作詩|作曲(?:家|者)?|編曲(?:家|者)?|作編曲|lyrics?(?:\s+by)?|lyricists?|written\s+by|songwriters?|words\s*(?:&|and)\s*music|compos(?:e|ed\s+by|er|ers|ition)|arrang(?:e|ed\s+by|er|ers|ement))/iu;
  var DOMAIN_LIKE_RE = /(?:^|[\s([{'"<>])(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|jp|co|io|ly|tv|me|info|biz|app|dev)(?=$|[\s/\\:?#)\]}'"<>])/iu;
  // Exact whole-value placeholders only. Keep this deliberately narrow: a
  // broad vocabulary risks rejecting real artist names.
  var NON_PERSON_CREDIT_VALUES = new Set(['BGM']);

  function creditIsBlank(value) {
    return value == null || String(value).trim() === '';
  }

  function getMissingCreditRoles(record) {
    return CREDIT_ROLES.filter(function (role) {
      return creditIsBlank(record && record[role]);
    });
  }

  function effectiveRoleSource(record, role) {
    var roleSources = record && record.creditRoleSources;
    var roleSource = roleSources && !Array.isArray(roleSources) ? roleSources[role] : undefined;
    if (typeof roleSource === 'string' && CREDIT_ROLE_SOURCES.indexOf(roleSource) !== -1) return roleSource;
    return record && typeof record.creditsSource === 'string' ? record.creditsSource : '';
  }

  // Pure, role-unit classification for the future Credit Review Center (N4).
  // Candidate objects use the same role fields/source/selected shape as
  // enrich_credits.js. `rules` and `donorIndex` may be passed directly so the
  // caller does not need to mutate a record or persist an enrichment plan.
  var REVIEW_SAME_SONG_DECORATOR_RE = /\b(?:official|music\s+video|mv|audio|lyrics?|full|hd|4k|remaster(?:ed)?|live|cover|feat\.?|ft\.?|short\s+ver\.?|tv\s+size)\b/giu;
  var REVIEW_SAME_SONG_DISALLOWED_RE = /[^a-z0-9\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;

  function reviewSameSongTitle(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\(\uff08\[\u3010][\s\S]*?[\)\uff09\]\u3011]/g, '')
      .replace(REVIEW_SAME_SONG_DECORATOR_RE, '')
      .replace(REVIEW_SAME_SONG_DISALLOWED_RE, '');
  }

  function reviewSameSongChannel(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s*-\s*topic\s*$/u, '')
      .replace(REVIEW_SAME_SONG_DISALLOWED_RE, '');
  }

  function reviewSameSongKey(record) {
    var title = reviewSameSongTitle(record && record.title);
    var channel = reviewSameSongChannel(record && record.channel);
    return title && channel ? title + '\n' + channel : '';
  }

  function reviewDurationMatches(record, donor) {
    if (!record || !donor || !Number.isFinite(record.durationSec) || record.durationSec <= 0
      || !Number.isFinite(donor.durationSec) || donor.durationSec <= 0) return false;
    return Math.abs(record.durationSec - donor.durationSec)
      / Math.max(record.durationSec, donor.durationSec) <= 0.1;
  }

  function addReviewCandidate(target, role, candidate, defaultSource, defaultSelected) {
    var rawValue = candidate && (candidate.role === role && !creditIsBlank(candidate.value)
      ? candidate.value : candidate[role]);
    if (creditIsBlank(rawValue)) return;
    target.push({
      value: String(rawValue).trim(),
      source: typeof candidate.source === 'string' ? candidate.source : defaultSource,
      sourceDetail: typeof candidate.sourceDetail === 'string' ? candidate.sourceDetail : '',
      selected: typeof candidate.selected === 'boolean' ? candidate.selected : defaultSelected,
    });
  }

  function collectReviewCandidates(record, role, materials) {
    materials = materials || {};
    var collected = [];
    var supplied = Array.isArray(materials.candidates) ? materials.candidates : [];
    supplied.forEach(function (candidate) {
      // Missing auto-eligibility is deliberately not inferred.
      addReviewCandidate(collected, role, candidate, '', false);
    });

    var rules = Array.isArray(materials.rules) ? materials.rules : [];
    if (materials.rule && typeof materials.rule === 'object') rules = rules.concat([materials.rule]);
    rules.forEach(function (rule) {
      if (rule && (!rule.channel || rule.channel === (record && record.channel))) {
        addReviewCandidate(collected, role, rule, 'rule', true);
      }
    });

    var donorIndex = materials.donorIndex;
    var key = reviewSameSongKey(record);
    var roleValues = key && donorIndex && typeof donorIndex.get === 'function' ? donorIndex.get(key) : null;
    var donorsByValue = roleValues && roleValues[role];
    if (donorsByValue && typeof donorsByValue.forEach === 'function') {
      donorsByValue.forEach(function (donors, value) {
        var matchingDonor = Array.isArray(donors) && donors.find(function (donor) {
          return donor !== record && donor && donor.videoId !== (record && record.videoId)
            && reviewDurationMatches(record, donor);
        });
        if (!matchingDonor) return;
        addReviewCandidate(collected, role, {
          value: value,
          role: role,
          source: 'same-song',
          sourceDetail: role + ':' + (matchingDonor.videoId || '?'),
          selected: true,
        }, 'same-song', true);
      });
    }
    return collected;
  }

  function getCreditReviewStates(record, materials) {
    return CREDIT_ROLES.reduce(function (states, role) {
      var existingValue = creditIsBlank(record && record[role]) ? '' : String(record[role]).trim();
      var existingSource = effectiveRoleSource(record, role);
      var candidates = collectReviewCandidates(record, role, materials);

      if (existingValue && existingSource === 'manual') {
        states[role] = { state: 'verified', value: existingValue, candidates: candidates, source: existingSource };
        return states;
      }
      // A non-manual existing value must not be replaced by a candidate, but
      // the current data does not prove that a person confirmed it.
      if (existingValue) {
        states[role] = { state: 'needs_review', value: existingValue, candidates: candidates, source: existingSource };
        return states;
      }
      if (!candidates.length) {
        states[role] = { state: 'unresolved', value: '', candidates: [], source: '' };
        return states;
      }

      var values = Array.from(new Set(candidates.map(function (candidate) { return candidate.value; })));
      if (values.length > 1) {
        states[role] = { state: 'conflict', value: '', candidates: candidates, source: '' };
        return states;
      }
      if (values.length === 1 && candidates.every(function (candidate) { return candidate.selected === true; })) {
        var sources = Array.from(new Set(candidates.map(function (candidate) { return candidate.source; }).filter(Boolean)));
        states[role] = {
          state: 'auto_candidate', value: values[0], candidates: candidates,
          source: sources.length === 1 ? sources[0] : '',
        };
        return states;
      }
      states[role] = { state: 'needs_review', value: values.length === 1 ? values[0] : '', candidates: candidates, source: '' };
      return states;
    }, {});
  }

  // Pure list assembly for the Credit Review Center. Candidates generated by
  // enrich_credits.js carry a videoId; scope them to that video before calling
  // the role classifier so candidates cannot leak between records.
  var CREDIT_REVIEW_STATE_ORDER = ['conflict', 'needs_review', 'auto_candidate', 'unresolved', 'verified'];

  function compareReviewListText(left, right) {
    left = String(left == null ? '' : left);
    right = String(right == null ? '' : right);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function getCreditReviewList(records, materials, limit) {
    records = Array.isArray(records) ? records : [];
    materials = materials || {};
    var suppliedCandidates = Array.isArray(materials.candidates) ? materials.candidates : [];
    var items = [];

    records.forEach(function (record, recordIndex) {
      var recordMaterials = Object.assign({}, materials, {
        candidates: suppliedCandidates.filter(function (candidate) {
          return candidate && candidate.videoId === (record && record.videoId);
        }),
      });
      var roleStates = getCreditReviewStates(record, recordMaterials);
      CREDIT_ROLES.forEach(function (role, roleIndex) {
        var roleState = roleStates[role];
        items.push({
          videoId: record && record.videoId != null ? String(record.videoId) : '',
          title: record && record.title != null ? String(record.title) : '',
          channel: record && record.channel != null ? String(record.channel) : '',
          role: role,
          state: roleState.state,
          value: roleState.value,
          source: roleState.source,
          candidates: roleState.candidates,
          _recordIndex: recordIndex,
          _roleIndex: roleIndex,
        });
      });
    });

    items.sort(function (left, right) {
      var stateDifference = CREDIT_REVIEW_STATE_ORDER.indexOf(left.state)
        - CREDIT_REVIEW_STATE_ORDER.indexOf(right.state);
      if (stateDifference) return stateDifference;
      var videoDifference = compareReviewListText(left.videoId, right.videoId);
      if (videoDifference) return videoDifference;
      if (left._roleIndex !== right._roleIndex) return left._roleIndex - right._roleIndex;
      var titleDifference = compareReviewListText(left.title, right.title);
      if (titleDifference) return titleDifference;
      var channelDifference = compareReviewListText(left.channel, right.channel);
      return channelDifference || left._recordIndex - right._recordIndex;
    });

    var normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : items.length;
    var displayedItems = items.slice(0, normalizedLimit);
    var counts = {};
    CREDIT_REVIEW_STATE_ORDER.forEach(function (state) { counts[state] = 0; });
    items.forEach(function (item) { counts[item.state]++; });

    var groups = CREDIT_REVIEW_STATE_ORDER.map(function (state) {
      var groupItems = displayedItems.filter(function (item) { return item.state === state; }).map(function (item) {
        var publicItem = Object.assign({}, item);
        delete publicItem._recordIndex;
        delete publicItem._roleIndex;
        return publicItem;
      });
      return {
        state: state,
        totalCount: counts[state],
        displayedCount: groupItems.length,
        items: groupItems,
      };
    });

    return {
      stateOrder: CREDIT_REVIEW_STATE_ORDER.slice(),
      counts: counts,
      totalCount: items.length,
      displayedCount: displayedItems.length,
      omittedCount: items.length - displayedItems.length,
      truncated: displayedItems.length < items.length,
      limit: Number.isFinite(limit) ? normalizedLimit : null,
      groups: groups,
    };
  }

  function normalizeSharedText(value) {
    return String(value == null ? '' : value).normalize('NFKC').trim();
  }

  function normalizeMbQueryPart(value) {
    return normalizeSharedText(value).replace(/\s+/gu, ' ').toLowerCase();
  }

  function mbQueryFingerprint(artist, title) {
    return normalizeMbQueryPart(artist) + '\u0000' + normalizeMbQueryPart(title);
  }

  function isValidMbLookup(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (MB_LOOKUP_STATUSES.indexOf(value.status) === -1) return false;
    if (typeof value.checkedAt !== 'number' || !Number.isFinite(value.checkedAt) || value.checkedAt <= 0) return false;
    if (typeof value.nextEligibleAt !== 'number' || !Number.isFinite(value.nextEligibleAt)
      || value.nextEligibleAt < value.checkedAt) return false;
    if (typeof value.queryFingerprint !== 'string' || !Array.isArray(value.missingRoles)) return false;
    if (!Number.isInteger(value.attempts) || value.attempts < 0) return false;
    if (value.status === 'error' ? value.attempts < 1 : value.attempts !== 0) return false;
    var seen = new Set();
    for (var i = 0; i < value.missingRoles.length; i++) {
      var role = value.missingRoles[i];
      if (CREDIT_ROLES.indexOf(role) === -1 || seen.has(role)) return false;
      seen.add(role);
    }
    return true;
  }

  function shouldQueryMb(record, opts) {
    opts = opts || {};
    if (opts.ignoreCooldown === true) return true;
    var lookup = record && record.mbLookup;
    if (!isValidMbLookup(lookup)) return true;
    var now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
    if (now >= lookup.nextEligibleAt) return true;
    if (lookup.queryFingerprint !== mbQueryFingerprint(opts.artist, opts.title)) return true;
    var priorRoles = new Set(lookup.missingRoles);
    var missingRoles = Array.isArray(opts.missingRoles) ? opts.missingRoles : [];
    return missingRoles.some(function (role) {
      return CREDIT_ROLES.indexOf(role) !== -1 && !priorRoles.has(role);
    });
  }

  function computeMbNextEligibleAt(status, attempts, now) {
    if (typeof now !== 'number' || !Number.isFinite(now)) now = Date.now();
    if (status !== 'error') return now + MB_RECHECK_MS;
    var stage = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
    return now + Math.min(MB_ERROR_MAX_MS, MB_ERROR_BASE_MS * Math.pow(2, stage - 1));
  }

  function isTopicChannelName(name) {
    var normalized = normalizeSharedText(name);
    if (!normalized || !TOPIC_SUFFIX_RE.test(normalized)) return false;
    return normalized.replace(TOPIC_SUFFIX_RE, '').trim() !== '';
  }

  function stripTopicChannelSuffix(name) {
    return normalizeSharedText(name).replace(TOPIC_SUFFIX_RE, '').trim();
  }

  function hasBalancedPairs(value, open, close) {
    var depth = 0;
    for (var i = 0; i < value.length; i++) {
      if (value[i] === open) depth++;
      if (value[i] === close && --depth < 0) return false;
    }
    return depth === 0;
  }

  // Conservative save boundary for composer / lyricist / arranger values.
  // Ambiguous evidence stays in creditsRaw instead of becoming a sticky,
  // non-empty role value that normal enrichment can no longer repair.
  function normalizeComparableCreditText(value) {
    return String(value == null ? '' : value).normalize('NFKC').trim().replace(/\s+/gu, ' ');
  }

  function isValidCreditValue(value, videoTitle) {
    if (typeof value !== 'string') return false;
    var raw = value.normalize('NFKC');
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(raw)) return false;
    var normalized = raw.trim();
    if (!normalized || Array.from(normalized).length > 60) return false;
    var comparable = normalizeComparableCreditText(normalized);
    if (NON_PERSON_CREDIT_VALUES.has(comparable.toUpperCase())) return false;
    var comparableTitle = normalizeComparableCreditText(videoTitle);
    if (comparableTitle && comparable === comparableTitle) return false;
    if (/(?:https?:)?\/\//iu.test(normalized) || /(?:^|\s)www\./iu.test(normalized)) return false;
    if (/(?:^|[\s([{'"<>])(?:bit\.ly|t\.co|music\.apple\.com|youtube\.com)(?=$|[\s/\\:?#)\]}'"<>])/iu.test(normalized)) return false;
    if (DOMAIN_LIKE_RE.test(normalized)) return false;
    if (/^@[\p{L}\p{N}_.-]+$/u.test(normalized)) return false;
    if (/copyright\s+control|all\s+rights\s+reserved/iu.test(normalized)) return false;
    if (CREDIT_ROLE_TEXT_RE.test(normalized)) return false;
    if (/^[\p{P}\p{S}\s]+$/u.test(normalized) || /[\p{P}\p{S}]{4,}/u.test(normalized)) return false;
    if ((normalized.match(/"/g) || []).length % 2 !== 0) return false;
    if (!hasBalancedPairs(normalized, '(', ')') || !hasBalancedPairs(normalized, '（', '）')
      || !hasBalancedPairs(normalized, '[', ']') || !hasBalancedPairs(normalized, '【', '】')) return false;
    return true;
  }

  // Plan repairs for sticky, non-empty role values that the current save
  // boundary would reject. The caller decides whether and how to apply them.
  function planCreditRepair(record) {
    return CREDIT_ROLES.reduce(function (repairs, role) {
      var before = record && record[role];
      if (effectiveRoleSource(record, role) !== 'manual'
        && !creditIsBlank(before) && !isValidCreditValue(before, record && record.title)) {
        repairs.push({ role: role, before: before });
      }
      return repairs;
    }, []);
  }

  // True when at least one credit role is still blank (role-unit §3.1).
  function hasMissingCreditRole(record) {
    return getMissingCreditRoles(record).length > 0;
  }

  // How many times a 概要欄 read came back without filling the blanks. A read that
  // leaves a role blank means the description does not carry that role — reading the
  // same description again cannot fill it, so those videos must not return on the
  // short window. Records written before this counter existed are inferred: already
  // checked, still incomplete => at least one fruitless read.
  function creditsLookedEmptyCount(record) {
    var storedCount = record && record.creditsEmptyCount;
    if (typeof storedCount === 'number' && Number.isFinite(storedCount)) return Math.max(0, storedCount);
    var checkedAt = record && record.creditsCheckedAt;
    var wasChecked = typeof checkedAt === 'number' && checkedAt > 0;
    return wasChecked && hasMissingCreditRole(record) ? 1 : 0;
  }

  // Videos read in one batch share a check timestamp, so a single window would put
  // them all back on the queue on the same day — rebuilding the very pile the long
  // window exists to prevent. Spread each video deterministically (same id always
  // lands on the same offset, so the due date never drifts between runs).
  function creditRecheckSpreadMs(record) {
    var id = record && record.videoId;
    if (typeof id !== 'string' || !id) return 0;
    var hash = 0;
    for (var i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return hash % CREDIT_RECHECK_SPREAD_MS;
  }

  function creditRecheckWindowMs(record) {
    var emptyCount = creditsLookedEmptyCount(record);
    if (emptyCount <= 0) return CREDIT_RECHECK_MS;
    var base = emptyCount === 1
      ? CREDIT_RECHECK_EMPTY_MS
      : (emptyCount === 2 ? CREDIT_RECHECK_EMPTY_MS * 2 : CREDIT_RECHECK_EMPTY_MAX_MS);
    return base + creditRecheckSpreadMs(record);
  }

  // True when this video was credit-checked within the cool-down window and so
  // should not be re-fetched yet. `now` and `windowMs` are injectable for tests.
  function recentlyCreditChecked(record, now, windowMs) {
    if (typeof now !== 'number') now = Date.now();
    if (typeof windowMs !== 'number') windowMs = creditRecheckWindowMs(record);
    var at = record && record.creditsCheckedAt;
    return typeof at === 'number' && at > 0 && (now - at) < windowMs;
  }

  // The single decision the history.js batch selector needs.
  //   skipChecked: honor the "チェック済みスキップ" checkbox (skip recently-checked)
  // Returns true when the video should be enqueued for a 概要欄 credit re-fetch.
  function isFixCreditsTarget(record, opts) {
    opts = opts || {};
    var skipChecked = opts.skipChecked !== false; // default true
    if (!hasMissingCreditRole(record)) return false;
    if (skipChecked && recentlyCreditChecked(record, opts.now, opts.windowMs)) return false;
    return true;
  }

  var api = {
    CREDIT_ROLES: CREDIT_ROLES,
    CREDIT_RECHECK_MS: CREDIT_RECHECK_MS,
    CREDIT_RECHECK_EMPTY_MS: CREDIT_RECHECK_EMPTY_MS,
    CREDIT_RECHECK_EMPTY_MAX_MS: CREDIT_RECHECK_EMPTY_MAX_MS,
    CREDIT_RECHECK_SPREAD_MS: CREDIT_RECHECK_SPREAD_MS,
    creditRecheckSpreadMs: creditRecheckSpreadMs,
    MB_RECHECK_MS: MB_RECHECK_MS,
    MB_ERROR_BASE_MS: MB_ERROR_BASE_MS,
    MB_ERROR_MAX_MS: MB_ERROR_MAX_MS,
    creditIsBlank: creditIsBlank,
    getMissingCreditRoles: getMissingCreditRoles,
    effectiveRoleSource: effectiveRoleSource,
    getCreditReviewStates: getCreditReviewStates,
    getCreditReviewList: getCreditReviewList,
    isValidCreditValue: isValidCreditValue,
    planCreditRepair: planCreditRepair,
    isTopicChannelName: isTopicChannelName,
    stripTopicChannelSuffix: stripTopicChannelSuffix,
    hasMissingCreditRole: hasMissingCreditRole,
    creditsLookedEmptyCount: creditsLookedEmptyCount,
    creditRecheckWindowMs: creditRecheckWindowMs,
    recentlyCreditChecked: recentlyCreditChecked,
    isFixCreditsTarget: isFixCreditsTarget,
    mbQueryFingerprint: mbQueryFingerprint,
    shouldQueryMb: shouldQueryMb,
    computeMbNextEligibleAt: computeMbNextEligibleAt,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CreditTarget = api;
})(typeof globalThis !== 'undefined' ? globalThis : null);
