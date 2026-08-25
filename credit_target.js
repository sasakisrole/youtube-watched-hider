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

  function normalizeSharedText(value) {
    return String(value == null ? '' : value).normalize('NFKC').trim();
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
    creditIsBlank: creditIsBlank,
    getMissingCreditRoles: getMissingCreditRoles,
    effectiveRoleSource: effectiveRoleSource,
    isValidCreditValue: isValidCreditValue,
    planCreditRepair: planCreditRepair,
    isTopicChannelName: isTopicChannelName,
    stripTopicChannelSuffix: stripTopicChannelSuffix,
    hasMissingCreditRole: hasMissingCreditRole,
    creditsLookedEmptyCount: creditsLookedEmptyCount,
    creditRecheckWindowMs: creditRecheckWindowMs,
    recentlyCreditChecked: recentlyCreditChecked,
    isFixCreditsTarget: isFixCreditsTarget,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CreditTarget = api;
})(typeof globalThis !== 'undefined' ? globalThis : null);
