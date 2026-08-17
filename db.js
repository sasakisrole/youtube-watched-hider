// IndexedDB wrapper for YouTube Watched Hider
// Safe to re-inject: uses var + existence check
if (typeof WatchedDB === 'undefined') {
  var WatchedDB = (() => {
    const DB_NAME = 'YouTubeWatchedDB';
    const DB_VERSION = 5;
    const STORE_NAME = 'watchedVideos';
    const LIKED_STORE = 'likedVideos';
    const CREDIT_ROLES = ['composer', 'lyricist', 'arranger'];
    const CREDITS_RAW_RESPONSE_MAX_LENGTH = 4096;
    const CREDIT_ROLE_SOURCES = new Set(['topic', 'general', 'enrich:rule', 'enrich:mb', 'manual']);

    let dbInstance = null;

    function openDB() {
      if (dbInstance) return Promise.resolve(dbInstance);

      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        let blocked = false;
        // Hard timeout: if open hasn't succeeded in 5s (typically because a
        // stale tab still holds an older DB version), reject so the caller
        // can surface a useful error instead of hanging forever.
        const timer = setTimeout(() => {
          reject(new Error(blocked
            ? 'IndexedDB upgrade blocked by another tab — close all YouTube tabs and reload'
            : 'IndexedDB open timed out'));
        }, 5000);

        request.onupgradeneeded = (event) => {
          // upgrade フェーズに入った時点で「stale tab に blocked されている」
          // ケースは外れたので、5秒 timeout を解除する（H1 fix: review 2026-05-12）。
          // 24,000件級の cursor.update がこの timer に巻き込まれて
          // 「IndexedDB open timed out」で失敗するのを防ぐ。
          // 以降は IndexedDB 側の transaction 完了 (onsuccess) / エラー (onerror) を待つ。
          clearTimeout(timer);
          const db = event.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'videoId' });
            store.createIndex('watchedAt', 'watchedAt', { unique: false });
          }
          if (event.oldVersion < 4 && !db.objectStoreNames.contains(LIKED_STORE)) {
            const lstore = db.createObjectStore(LIKED_STORE, { keyPath: 'videoId' });
            lstore.createIndex('accountId', 'accountId', { unique: false });
            lstore.createIndex('likedAt', 'likedAt', { unique: false });
          }
          // Migration: existing records get playCount/source (v2) and an
          // explicit durationSec null (v5) so duration backfill can target
          // records with durationSec === null.
          if ((event.oldVersion < 2 || event.oldVersion < 5) && db.objectStoreNames.contains(STORE_NAME)) {
            const tx = event.target.transaction;
            const store = tx.objectStore(STORE_NAME);
            store.openCursor().onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                const record = cursor.value;
                let dirty = false;
                if (event.oldVersion < 2) {
                  if (!record.playCount) { record.playCount = 1; dirty = true; }
                  if (!record.source) { record.source = 'unknown'; dirty = true; }
                }
                if (event.oldVersion < 5 && !Object.prototype.hasOwnProperty.call(record, 'durationSec')) {
                  record.durationSec = null;
                  dirty = true;
                }
                if (dirty) cursor.update(record);
                cursor.continue();
              }
            };
          }
        };

        request.onsuccess = (event) => {
          clearTimeout(timer);
          dbInstance = event.target.result;
          dbInstance.onclose = () => { dbInstance = null; };
          dbInstance.onversionchange = () => {
            try { dbInstance.close(); } catch (_) {}
            dbInstance = null;
          };
          resolve(dbInstance);
        };

        request.onerror = (event) => {
          clearTimeout(timer);
          reject(event.target.error);
        };

        request.onblocked = () => {
          blocked = true;
          console.warn('[WatchedDB] open blocked — close other YouTube tabs / extension pages and reload.');
        };
      });
    }

    // source: 'self' (user actually played) or 'seekbar' (detected via YouTube seekbar)
    function normalizeDurationSec(durationSec) {
      if (durationSec === -1) return -1;
      if (durationSec == null || durationSec === '') return null;
      const n = Number(durationSec);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    }

    async function addWatched(videoId, title = '', source = 'self', channel = '', durationSec = null, category = '') {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        // Check existing record first to preserve title and increment playCount
        const getReq = store.get(videoId);
        let wasNew = false;
        getReq.onsuccess = () => {
          const existing = getReq.result;
          const nextDuration = normalizeDurationSec(durationSec);
          if (existing) {
            // Only increment playCount for actual plays (source='self'), not seekbar re-detection
            const shouldIncrement = source === 'self';
            // Use ?? (not ||) so a real playCount of 0 (seekbar-created record,
            // never actually played) is preserved: 0 self-play -> 1, not 0->2.
            // || would coerce 0 to 1 (M1 bug: over-counted engagement).
            const prevPlayCount = existing.playCount ?? 0;
            const nextRecord = {
              ...existing,
              videoId,
              title: title || existing.title || '',
              channel: channel || existing.channel || '',
              watchedAt: shouldIncrement ? Date.now() : existing.watchedAt,
              firstWatchedAt: existing.firstWatchedAt || existing.watchedAt,
              playCount: shouldIncrement ? prevPlayCount + 1 : prevPlayCount,
              source: existing.source === 'self' ? 'self' : source,
              durationSec: nextDuration != null ? nextDuration : (Object.prototype.hasOwnProperty.call(existing, 'durationSec') ? existing.durationSec : null),
              // microformat category (PENDING L98): set when newly captured, else
              // preserve any prior value (never wipe on re-watch/seekbar).
              category: (typeof category === 'string' && category) ? category
                : (typeof existing.category === 'string' ? existing.category : ''),
              // Preserve credit fields — addWatched must not wipe them on re-watch/seekbar
              composer: existing.composer || '',
              lyricist: existing.lyricist || '',
              arranger: existing.arranger || '',
              creditsCheckedAt: existing.creditsCheckedAt || 0,
              creditsSource: existing.creditsSource || '',
              ...(Object.prototype.hasOwnProperty.call(existing, 'mbLookup')
                ? { mbLookup: existing.mbLookup }
                : {}),
            };
            if (nextDuration != null && nextRecord.durationFetchFailed) {
              delete nextRecord.durationFetchFailed;
            }
            store.put(nextRecord);
          } else {
            wasNew = true;
            // New record: seekbar detection = 0 plays (just detected), self = 1 play
            store.put({
              videoId,
              title,
              channel: channel || '',
              watchedAt: Date.now(),
              firstWatchedAt: Date.now(),
              playCount: source === 'self' ? 1 : 0,
              source,
              durationSec: nextDuration,
              category: typeof category === 'string' ? category : '',
            });
          }
        };

        tx.oncomplete = () => resolve({ isNew: wasNew });
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    async function updateDuration(videoId, durationSec) {
      const normalized = normalizeDurationSec(durationSec);
      if (normalized == null) return false;
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(videoId);
        let didUpdate = false;
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (!existing) return;
          if (existing.durationSec !== normalized || existing.durationFetchFailed) {
            existing.durationSec = normalized;
            if (existing.durationFetchFailed) delete existing.durationFetchFailed;
            store.put(existing);
            didUpdate = true;
          }
        };
        tx.oncomplete = () => resolve(didUpdate);
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    async function markDurationLive(videoId) {
      return updateDuration(videoId, -1);
    }

    async function markDurationFailed(videoId, reason) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(videoId);
        let didUpdate = false;
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (!existing) return;
          if (existing.durationSec == null) {
            existing.durationSec = null;
            existing.durationFetchFailed = String(reason || 'unknown');
            store.put(existing);
            didUpdate = true;
          }
        };
        tx.oncomplete = () => resolve(didUpdate);
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    // Update title only (without incrementing playCount)
    async function updateTitle(videoId, title) {
      if (!title) return;
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(videoId);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (existing && !existing.title) {
            existing.title = title;
            store.put(existing);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    // Update credits (composer/lyricist/arranger). Role values are always
    // blank-only; force is retained only for creditsRaw evidence refreshes.
    // source: 'topic' | 'general' — 抽出元を記録（集計で分離するため）
    async function updateCredits(videoId, credits, force = false, source = '') {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(videoId);
        let didUpdate = false;
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (!existing) return;
          const writtenRoles = [];
          for (const k of [...CREDIT_ROLES, 'creditsRaw']) {
            const v = credits && credits[k];
            const valid = k === 'creditsRaw' || globalThis.CreditTarget.isValidCreditValue(v, existing.title);
            const canWrite = k === 'creditsRaw' ? (force || !existing[k]) : !existing[k];
            if (v && valid && canWrite) {
              existing[k] = v;
              if (k !== 'creditsRaw') writtenRoles.push(k);
              didUpdate = true;
            }
          }
          if (writtenRoles.length && CREDIT_ROLE_SOURCES.has(source)) {
            const roleSources = sanitizeCreditRoleSources(existing.creditRoleSources);
            for (const role of writtenRoles) roleSources[role] = source;
            existing.creditRoleSources = roleSources;
          }
          if (didUpdate && source && !existing.creditsSource) {
            existing.creditsSource = source;
          }
          // A read that left a role blank means the description does not carry it;
          // re-reading the same text cannot fill it, so only real progress resets.
          existing.creditsEmptyCount = didUpdate
            ? 0
            : (typeof existing.creditsEmptyCount === 'number' && Number.isFinite(existing.creditsEmptyCount) ? existing.creditsEmptyCount : 0) + 1;
          // Always stamp "checked" so we can skip already-scanned videos next run.
          existing.creditsCheckedAt = Date.now();
          // Clear any prior failure reason — this attempt succeeded.
          if (existing.creditsFetchFailReason) {
            existing.creditsFetchFailReason = '';
          }
          store.put(existing);
        };
        tx.oncomplete = () => resolve(didUpdate);
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    // Read credits for a search-result batch in one IndexedDB transaction.
    // The caller sends the whole videoId group through one extension RPC.
    async function getCreditsForVideoIds(videoIds) {
      const ids = [...new Set(
        (Array.isArray(videoIds) ? videoIds : [])
          .map((videoId) => String(videoId ?? '').trim())
          .filter(Boolean)
      )];
      if (ids.length === 0) return {};

      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const result = {};

        for (const videoId of ids) {
          const request = store.get(videoId);
          request.onsuccess = () => {
            const record = request.result;
            if (!record) return;
            const credits = {};
            for (const field of [...CREDIT_ROLES, 'creditsRaw']) {
              let value = typeof record[field] === 'string'
                ? record[field].trim()
                : '';
              if (field === 'creditsRaw') {
                value = value.slice(0, CREDITS_RAW_RESPONSE_MAX_LENGTH);
              }
              if (value) credits[field] = value;
            }
            if (Object.keys(credits).length > 0) {
              result[videoId] = credits;
            }
          };
        }

        tx.oncomplete = () => resolve(result);
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    async function recordMbLookup(videoId, details = {}) {
      const status = details.status;
      if (!['found', 'not-found', 'no-roles', 'error'].includes(status)) {
        throw new TypeError('Invalid MusicBrainz lookup status');
      }
      if (typeof details.queryFingerprint !== 'string') {
        throw new TypeError('Invalid MusicBrainz query fingerprint');
      }
      const missingRoles = [...new Set(
        (Array.isArray(details.missingRoles) ? details.missingRoles : [])
          .filter((role) => CREDIT_ROLES.includes(role))
      )];
      const now = typeof details.now === 'number' && Number.isFinite(details.now) && details.now > 0
        ? details.now
        : Date.now();
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(videoId);
        let didUpdate = false;
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (!existing) return;
          const prior = sanitizeMbLookup(existing.mbLookup);
          const sameCondition = prior
            && prior.queryFingerprint === details.queryFingerprint
            && missingRoles.every((role) => prior.missingRoles.includes(role));
          const priorAttempts = details.ignoreCooldown === true || !sameCondition
            ? 0
            : (prior && prior.status === 'error' ? prior.attempts : 0);
          const attempts = status === 'error' ? priorAttempts + 1 : 0;
          existing.mbLookup = {
            status,
            checkedAt: now,
            nextEligibleAt: globalThis.CreditTarget.computeMbNextEligibleAt(status, attempts, now),
            queryFingerprint: details.queryFingerprint,
            missingRoles,
            attempts,
          };
          store.put(existing);
          didUpdate = true;
        };
        tx.oncomplete = () => resolve(didUpdate);
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    function normalizeCasBlank(value) {
      return value == null || (typeof value === 'string' && value.trim() === '') ? '' : value;
    }

    async function setManualCreditRole(args = {}) {
      const { videoId, role, value, expectedCurrent, expectedSource, restoreRoleSource } = args;
      const hasRestoreRoleSource = Object.prototype.hasOwnProperty.call(args, 'restoreRoleSource');
      if (!CREDIT_ROLES.includes(role)) return { error: 'bad_role' };
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(videoId);
        let result = { error: 'not_found' };

        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (!existing) return;

          const currentValue = existing[role];
          const currentSource = globalThis.CreditTarget.effectiveRoleSource(existing, role);
          if (normalizeCasBlank(expectedCurrent) !== normalizeCasBlank(currentValue)
            || normalizeCasBlank(expectedSource) !== normalizeCasBlank(currentSource)) {
            result = { conflict: true, current: { value: currentValue, source: currentSource } };
            return;
          }

          const nextIsBlank = normalizeCasBlank(value) === '';
          const currentIsBlank = globalThis.CreditTarget.creditIsBlank(currentValue);
          if (hasRestoreRoleSource && restoreRoleSource !== null && !CREDIT_ROLE_SOURCES.has(restoreRoleSource)) {
            result = { error: 'invalid_value' };
            return;
          }
          if (!nextIsBlank && !globalThis.CreditTarget.isValidCreditValue(value)) {
            result = { error: 'invalid_value' };
            return;
          }
          if ((!currentIsBlank || nextIsBlank) && currentSource !== 'manual') {
            result = { error: 'not_manual' };
            return;
          }
          // Undoing a cancel is the sole restore whose just-written state is
          // blank/non-manual (the cancel removed its manual key). It may only
          // restore a nonblank manual value; every other restore requires manual.
          if (hasRestoreRoleSource && currentSource !== 'manual'
            && !(currentIsBlank && !nextIsBlank && restoreRoleSource === 'manual')) {
            result = { error: 'not_manual' };
            return;
          }

          const priorSources = existing.creditRoleSources;
          const sourcePresent = !!(priorSources && !Array.isArray(priorSources)
            && Object.prototype.hasOwnProperty.call(priorSources, role));
          const previous = { value: currentValue, source: currentSource, sourcePresent };
          const roleSources = sanitizeCreditRoleSources(priorSources);

          existing[role] = nextIsBlank ? '' : value;
          if (hasRestoreRoleSource) {
            if (restoreRoleSource === null) delete roleSources[role];
            else roleSources[role] = restoreRoleSource;
          } else if (nextIsBlank) {
            delete roleSources[role];
          } else {
            roleSources[role] = 'manual';
          }
          if (Object.keys(roleSources).length) existing.creditRoleSources = roleSources;
          else delete existing.creditRoleSources;

          const post = {
            value: existing[role],
            source: globalThis.CreditTarget.effectiveRoleSource(existing, role),
          };
          store.put(existing);
          result = { updated: true, previous, post };
        };

        tx.oncomplete = () => resolve(result);
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    // Mark a video as credit-scanned even if no credits were found.
    // Lets the UI skip it on the next Fix Credits run.
    async function markCreditsChecked(videoId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(videoId);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (!existing) return;
          existing.creditsEmptyCount = (typeof existing.creditsEmptyCount === 'number' && Number.isFinite(existing.creditsEmptyCount) ? existing.creditsEmptyCount : 0) + 1;
          existing.creditsCheckedAt = Date.now();
          if (existing.creditsFetchFailReason) {
            existing.creditsFetchFailReason = '';
          }
          store.put(existing);
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    // Strip URLs / Twitter handles from credit-line text. Mirrors the same
    // function in background.js — credits arrive cleaned from new fetches,
    // but old records may have been saved before this regex was added.
    function _cleanCreditLine(s) {
      if (!s) return '';
      let out = s;
      out = out.replace(/[\(（][^()（）]*(?:https?:\/\/|twitter\.com|x\.com|t\.co\/|Twitter\s*[:：])[^()（）]*[\)）]/gi, '');
      out = out.replace(/https?:\/\/\S+/gi, '');
      out = out.replace(/\s+/g, ' ').replace(/\s*([,、，\/／])\s*/g, '$1').replace(/[,、，\/／]+$/, '').trim();
      out = out.replace(/[\s\-–—·]+$/, '').trim();
      if (out.toUpperCase() === '#N/A' || out.toUpperCase() === '#REF!' || out === '-') return '';
      return out;
    }

    // One-time cleanup: re-apply cleanCreditLine to existing credit fields.
    // Returns { scanned, changed } counts.
    async function cleanAllCredits() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        let scanned = 0;
        let changed = 0;
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          scanned++;
          const r = cursor.value;
          let dirty = false;
          for (const k of ['composer', 'lyricist', 'arranger', 'creditsRaw']) {
            const before = r[k];
            if (typeof before === 'string' && before) {
              const after = _cleanCreditLine(before);
              if (after !== before) { r[k] = after; dirty = true; }
            }
          }
          if (dirty) { cursor.update(r); changed++; }
          cursor.continue();
        };
        tx.oncomplete = () => resolve({ scanned, changed });
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    function isCurrentCreditRepairEntry(entry) {
      return !!entry && entry.reason === 'invalid-credit-value'
        && CREDIT_ROLES.includes(entry.role);
    }

    function fingerprintCreditMutationTargets(targets) {
      const canonical = targets
        .map(([videoId, role]) => [String(videoId), role])
        .sort((a, b) => {
          if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
          if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
          return 0;
        });
      const serialized = JSON.stringify(canonical);
      let hash = 14695981039346656037n;
      const prime = 1099511628211n;
      const mask = 0xffffffffffffffffn;
      for (let index = 0; index < serialized.length; index++) {
        const code = serialized.charCodeAt(index);
        hash = ((hash ^ BigInt(code & 0xff)) * prime) & mask;
        hash = ((hash ^ BigInt(code >>> 8)) * prime) & mask;
      }
      return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
    }

    let creditRepairRunSequence = 0;
    function createCreditRepairRunId() {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return `credit-repair:${globalThis.crypto.randomUUID()}`;
      }
      creditRepairRunSequence++;
      return `credit-repair:${creditRepairRunSequence.toString(36)}:${Math.random().toString(36).slice(2)}`;
    }

    async function runCreditMutation({
      dryRun, expectedValues, expectedFingerprint, inspectRecord, prepareApply, applyRecord,
    }) {
      const previewOnly = dryRun !== false;
      const result = {
        dryRun: previewOnly,
        scanned: 0,
        videos: 0,
        values: 0,
        skipped: 0,
        byRole: { composer: 0, lyricist: 0, arranger: 0 },
      };
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, previewOnly ? 'readonly' : 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const plans = new Map();
        const targets = [];
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) {
            result.fingerprint = fingerprintCreditMutationTargets(targets);
            if (previewOnly) return;

            const expected = expectedValues === undefined ? null : expectedValues;
            const expectedTargetFingerprint = typeof expectedFingerprint === 'string'
              ? expectedFingerprint
              : null;
            if (expectedValues === undefined || expectedValues !== result.values
              || expectedTargetFingerprint === null
              || expectedTargetFingerprint !== result.fingerprint) {
              result.mismatch = true;
              result.reason = 'preview-target-mismatch';
              result.expected = expected;
              result.actual = result.values;
              result.expectedFingerprint = expectedTargetFingerprint;
              result.actualFingerprint = result.fingerprint;
              return;
            }

            if (plans.size === 0) return;
            if (prepareApply) prepareApply(result);
            const applyCursorReq = store.openCursor();
            applyCursorReq.onsuccess = (applyEvent) => {
              const applyCursor = applyEvent.target.result;
              if (!applyCursor) return;
              const applyRecordValue = applyCursor.value;
              const plan = plans.get(applyRecordValue && applyRecordValue.videoId);
              if (plan) {
                applyRecord(applyRecordValue, plan, result);
                applyCursor.update(applyRecordValue);
              }
              applyCursor.continue();
            };
            return;
          }
          result.scanned++;
          const record = cursor.value;
          const plan = inspectRecord(record) || { items: [] };
          const items = Array.isArray(plan.items) ? plan.items : [];
          result.skipped += Number(plan.skipped) || 0;
          if (items.length) {
            result.videos++;
            result.values += items.length;
            for (const item of items) {
              result.byRole[item.role]++;
              targets.push([record.videoId, item.role]);
            }
            plans.set(record.videoId, plan);
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    async function repairInvalidCredits({ dryRun, expectedValues, expectedFingerprint } = {}) {
      return runCreditMutation({
        dryRun,
        expectedValues,
        expectedFingerprint,
        inspectRecord(record) {
          return { items: globalThis.CreditTarget.planCreditRepair(record) };
        },
        prepareApply(result) {
          result.at = Date.now();
          result.runId = createCreditRepairRunId();
        },
        applyRecord(record, plan, result) {
          const repairLog = Array.isArray(record.creditsRepairLog)
            ? record.creditsRepairLog.slice()
            : [];
          for (const repair of plan.items) {
            const roleSources = record.creditRoleSources;
            const hasRoleSource = roleSources && typeof roleSources === 'object'
              && !Array.isArray(roleSources)
              && Object.prototype.hasOwnProperty.call(roleSources, repair.role);
            const sourceBefore = hasRoleSource ? roleSources[repair.role] : null;
            record[repair.role] = '';
            if (hasRoleSource) delete roleSources[repair.role];
            repairLog.push({
              v: 1,
              role: repair.role,
              before: repair.before,
              sourceBefore,
              at: result.at,
              runId: result.runId,
              reason: 'invalid-credit-value',
            });
          }
          if (repairLog.length > 10) repairLog.splice(0, repairLog.length - 10);
          record.creditsRepairLog = repairLog;
        },
      });
    }

    async function restoreRepairedCredits({ dryRun, expectedValues, expectedFingerprint } = {}) {
      return runCreditMutation({
        dryRun,
        expectedValues,
        expectedFingerprint,
        inspectRecord(record) {
          const repairLog = Array.isArray(record.creditsRepairLog) ? record.creditsRepairLog : [];
          const valueOccupiedRoles = new Set(CREDIT_ROLES.filter(
            (role) => !globalThis.CreditTarget.creditIsBlank(record[role])
          ));
          const plannedRoles = new Set();
          const items = [];
          let skipped = 0;
          for (let index = repairLog.length - 1; index >= 0; index--) {
            const entry = repairLog[index];
            if (!isCurrentCreditRepairEntry(entry)) continue;
            if (valueOccupiedRoles.has(entry.role)) {
              skipped++;
              continue;
            }
            if (plannedRoles.has(entry.role)) continue;
            plannedRoles.add(entry.role);
            items.push({ role: entry.role, index, entry });
          }
          return { items, skipped };
        },
        applyRecord(record, plan) {
          const repairLog = Array.isArray(record.creditsRepairLog)
            ? record.creditsRepairLog.slice()
            : [];
          const restoredIndexes = new Set(plan.items.map((item) => item.index));
          for (const item of plan.items) {
            record[item.role] = item.entry.before;
            const sourceBefore = Object.prototype.hasOwnProperty.call(item.entry, 'sourceBefore')
              ? item.entry.sourceBefore
              : null;
            if (sourceBefore === null) {
              if (record.creditRoleSources && typeof record.creditRoleSources === 'object'
                && !Array.isArray(record.creditRoleSources)) {
                delete record.creditRoleSources[item.role];
              }
            } else {
              if (!record.creditRoleSources || typeof record.creditRoleSources !== 'object'
                || Array.isArray(record.creditRoleSources)) {
                record.creditRoleSources = {};
              }
              record.creditRoleSources[item.role] = sourceBefore;
            }
          }
          record.creditsRepairLog = repairLog.filter((_entry, index) => !restoredIndexes.has(index));
        },
      });
    }

    async function verifyCreditRepair({ runId } = {}) {
      const requestedRunId = typeof runId === 'string' && runId ? runId : null;
      const result = {
        runId: requestedRunId,
        remainingInvalid: 0,
        loggedTotal: requestedRunId === null ? null : 0,
        loggedStillValid: requestedRunId === null ? null : 0,
        restorable: requestedRunId === null ? null : 0,
      };
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          const record = cursor.value;
          result.remainingInvalid += globalThis.CreditTarget.planCreditRepair(record).length;
          if (requestedRunId === null) {
            cursor.continue();
            return;
          }
          const repairLog = Array.isArray(record.creditsRepairLog) ? record.creditsRepairLog : [];
          for (const entry of repairLog) {
            if (!isCurrentCreditRepairEntry(entry)) continue;
            if (entry.runId !== requestedRunId) continue;
            result.loggedTotal++;
            if (globalThis.CreditTarget.isValidCreditValue(entry.before, record.title)) {
              result.loggedStillValid++;
            }
            if (globalThis.CreditTarget.creditIsBlank(record[entry.role])) result.restorable++;
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    // Mark a Fix Credits attempt as failed for a specific videoId.
    // Reason is recorded so we can later analyze why retrieval failed.
    // creditsCheckedAt is intentionally NOT stamped — the videoId remains
    // eligible for the next Fix Credits run (per-video issues may resolve
    // when a description is added later, etc.).
    async function markCreditsFailed(videoId, reason) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(videoId);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (!existing) return;
          existing.creditsFetchFailReason = String(reason || 'unknown');
          existing.creditsFetchAttemptedAt = Date.now();
          store.put(existing);
        };
        tx.oncomplete = () => resolve(true);
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    // Update title and channel (without incrementing playCount).
    // By default only fills empty fields. Pass force=true to overwrite
    // existing values (used for oEmbed-based correction).
    async function updateTitleAndChannel(videoId, title, channel, force = false) {
      if (!title && !channel) return false;
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(videoId);
        let didUpdate = false;
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (existing) {
            if (title && (force || !existing.title)) { existing.title = title; didUpdate = true; }
            if (channel && (force || !existing.channel)) { existing.channel = channel; didUpdate = true; }
            if (didUpdate) store.put(existing);
          }
        };
        tx.oncomplete = () => resolve(didUpdate);
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    async function isWatched(videoId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(videoId);
        request.onsuccess = () => resolve(!!request.result);
        request.onerror = (event) => reject(event.target.error);
      });
    }

    async function checkMultiple(videoIds) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const results = {};
        const uniqueIds = [];
        const seen = new Set();
        for (const id of videoIds || []) {
          if (!id || seen.has(id)) continue;
          seen.add(id);
          uniqueIds.push(id);
        }
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);

        let pending = uniqueIds.length;
        if (pending === 0) return resolve(results);

        for (const id of uniqueIds) {
          const request = store.get(id);
          request.onsuccess = () => {
            results[id] = !!request.result;
            if (--pending === 0) resolve(results);
          };
          request.onerror = (event) => reject(event.target.error);
        }
      });
    }

    async function getStats() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.count();
        request.onsuccess = () => resolve({ count: request.result });
        request.onerror = (event) => reject(event.target.error);
      });
    }

    function getAppVersion() {
      return (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
        ? chrome.runtime.getManifest().version : 'unknown';
    }

    function normalizeExportSource(source) {
      // u1ps (Codex B1 VERIFY minor 3): 'pre-reset'/'pre-replace' are the
      // mandatory safety backups taken before a destructive full-reset / replace
      // import, so the export's own audit source records them accurately.
      return ['manual', 'auto', 'backup-now', 'pre-reset', 'pre-replace'].includes(source) ? source : 'manual';
    }

    // u1ps §7.1 (Option A): normalize likedSyncMeta to the RUNTIME FLAT form and
    // preserve it losslessly through export/import.
    //
    // The runtime writer (background.js syncLikedPlaylist) persists a flat object
    // {accountId, ownerName, ..., identityConfidence, partial, ...} to
    // chrome.storage.local, and every reader (the account-change guard at
    // background.js meta.accountId, analyzer.js meta.ownerHandle||meta.ownerName)
    // reads it flat. Prior export/import converted this to an accounts-map
    // ({schemaVersion:2, lastAccountId, accounts:{}}) which DROPPED the
    // identity-confidence / partial fields AND, on restore, left storage in
    // accounts-map form so the flat readers silently broke (meta.accountId
    // undefined => account-change / 誤同期防止 guard disabled after import).
    //
    // This normalizer accepts BOTH shapes so pre-u1ps accounts-map backups still
    // import, but always OUTPUTS the flat runtime shape. Runtime-only fields
    // absent from an old accounts-map backup fall back to defaults.
    function sanitizeLikedSyncMetaFlat(meta) {
      if (!meta || typeof meta !== 'object') return null;

      // Legacy accounts-map backup: derive the flat record from the last-used
      // account (or the first present). Runtime-only fields (identityConfidence,
      // partial, hasMore, degraded, droppedLoose, lastError, unknownConfirmedAt)
      // were never stored in that shape, so they take defaults.
      let src = meta;
      if (meta.accounts && typeof meta.accounts === 'object') {
        const rawAccounts = meta.accounts;
        const keys = Object.keys(rawAccounts);
        if (keys.length === 0) return null;
        const pickId = typeof meta.lastAccountId === 'string' && rawAccounts[meta.lastAccountId]
          ? meta.lastAccountId
          : keys[0];
        const acc = rawAccounts[pickId];
        if (!acc || typeof acc !== 'object') return null;
        src = {
          accountId: typeof acc.accountId === 'string' && acc.accountId ? acc.accountId : String(pickId || ''),
          ownerName: acc.ownerName,
          ownerHandle: acc.ownerHandle,
          ownerChannelId: acc.ownerChannelId,
          lastSyncedAt: acc.lastSyncedAt,
          count: acc.count,
        };
      }

      const str = (v) => (typeof v === 'string' ? v : '');
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const bool = (v) => v === true;

      const accountId = typeof src.accountId === 'string' && src.accountId
        ? src.accountId
        : (typeof src.ownerChannelId === 'string' && src.ownerChannelId
          ? src.ownerChannelId
          : (typeof src.ownerHandle === 'string' && src.ownerHandle ? src.ownerHandle : ''));
      // No usable identity at all => treat as no meta (matches runtime null).
      if (!accountId && !str(src.ownerName) && !str(src.ownerHandle) && !str(src.ownerChannelId)) {
        return null;
      }

      return {
        accountId,
        ownerName: str(src.ownerName),
        ownerHandle: str(src.ownerHandle),
        ownerChannelId: str(src.ownerChannelId),
        identityConfidence: str(src.identityConfidence),
        unknownConfirmedAt: numOrNull(src.unknownConfirmedAt),
        lastSyncedAt: num(src.lastSyncedAt),
        count: num(src.count),
        partial: bool(src.partial),
        hasMore: bool(src.hasMore),
        degraded: bool(src.degraded),
        droppedLoose: num(src.droppedLoose),
        lastError: typeof src.lastError === 'string' ? src.lastError : null,
      };
    }

    async function exportAll(options = {}) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME, LIKED_STORE], 'readonly');
        const watchedReq = tx.objectStore(STORE_NAME).getAll();
        const likedReq = tx.objectStore(LIKED_STORE).getAll();
        let watchedVideos = [];
        let likedVideos = [];
        watchedReq.onsuccess = () => { watchedVideos = watchedReq.result || []; };
        likedReq.onsuccess = () => { likedVideos = likedReq.result || []; };
        tx.oncomplete = () => resolve(wrapExport(watchedVideos, {
          likedVideos,
          likedSyncMeta: options.likedSyncMeta || null,
          source: options.source || 'manual',
          appVersion: options.appVersion,
        }));
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    // Current export schema version
    const SCHEMA_VERSION = 2;

    // Wrap records in versioned envelope for export.
    function wrapExport(records, options = {}) {
      const watchedVideos = Array.isArray(records) ? records : [];
      const likedVideos = Array.isArray(options.likedVideos) ? options.likedVideos : [];
      const appVersion = (typeof options.appVersion === 'string' && options.appVersion)
        ? options.appVersion
        : getAppVersion();
      return {
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        appVersion,
        source: normalizeExportSource(options.source),
        counts: {
          watchedVideos: watchedVideos.length,
          likedVideos: likedVideos.length,
        },
        watchedVideos,
        likedVideos,
        likedSyncMeta: sanitizeLikedSyncMetaFlat(options.likedSyncMeta),
      };
    }

    // Unwrap watched records: accept v2 envelope, v1 envelope, and legacy raw array.
    function unwrapWatchedRecords(data) {
      if (Array.isArray(data)) return data;
      if (data && typeof data === 'object' && data.schemaVersion === 2 && Array.isArray(data.watchedVideos)) return data.watchedVideos;
      if (data && typeof data === 'object' && Array.isArray(data.records)) return data.records;
      return null;
    }

    function unwrapImport(data) {
      return unwrapWatchedRecords(data);
    }

    // Validate and normalize a record
    function isValidRecord(record) {
      return !!record
        && typeof record === 'object'
        && typeof record.videoId === 'string'
        && record.videoId.length > 0;
    }

    function sanitizeCreditRoleSources(value) {
      const sanitized = {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) return sanitized;
      for (const role of CREDIT_ROLES) {
        const source = value[role];
        if (typeof source === 'string' && CREDIT_ROLE_SOURCES.has(source)) {
          sanitized[role] = source;
        }
      }
      return sanitized;
    }

    function sanitizeMbLookup(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      if (!['found', 'not-found', 'no-roles', 'error'].includes(value.status)) return null;
      if (typeof value.checkedAt !== 'number' || !Number.isFinite(value.checkedAt) || value.checkedAt <= 0) return null;
      if (typeof value.nextEligibleAt !== 'number' || !Number.isFinite(value.nextEligibleAt)
        || value.nextEligibleAt < value.checkedAt) return null;
      if (typeof value.queryFingerprint !== 'string' || !Array.isArray(value.missingRoles)) return null;
      if (!Number.isInteger(value.attempts) || value.attempts < 0) return null;
      if (value.status === 'error' ? value.attempts < 1 : value.attempts !== 0) return null;
      if (value.missingRoles.some((role) => !CREDIT_ROLES.includes(role))) return null;
      if (new Set(value.missingRoles).size !== value.missingRoles.length) return null;
      return {
        status: value.status,
        checkedAt: value.checkedAt,
        nextEligibleAt: value.nextEligibleAt,
        queryFingerprint: value.queryFingerprint,
        missingRoles: value.missingRoles.slice(),
        attempts: value.attempts,
      };
    }

    function isValidLikedRecord(record) {
      // videoId is the only required field. Optional-field corruption is repaired
      // by normalizeLikedRecord instead of discarding an otherwise recoverable row.
      return !!record
        && typeof record === 'object'
        && typeof record.videoId === 'string'
        && record.videoId.length > 0;
    }

    // Split records into valid/dropped without throwing, so a backup with a
    // few corrupt entries can still restore the rest (M3: tolerant import).
    function partitionValidRecords(records, isValid) {
      const valid = [];
      let dropped = 0;
      for (const r of records) {
        if (isValid(r)) valid.push(r);
        else dropped++;
      }
      return { valid, dropped };
    }

    function parseImportData(data) {
      const watchedRaw = unwrapWatchedRecords(data);
      // Structural failure (not an array / unrecognized envelope) is
      // unrecoverable and still throws. Per-record corruption is tolerated
      // below so a mostly-good backup restores its valid records (M3).
      if (!Array.isArray(watchedRaw)) {
        throw new Error('Invalid import format: unrecognized structure (expected an array or a versioned envelope)');
      }
      const w = partitionValidRecords(watchedRaw, isValidRecord);

      let likedVideos = [];
      let droppedLiked = 0;
      let likedStructuralError = false;
      let likedMetaStructuralError = false;
      let likedSyncMeta = null;
      if (data && typeof data === 'object' && data.schemaVersion === 2) {
        if (Array.isArray(data.likedVideos)) {
          const l = partitionValidRecords(data.likedVideos, isValidLikedRecord);
          likedVideos = l.valid;
          droppedLiked = l.dropped;
        } else if (data.likedVideos != null) {
          // u1ps (Codex B1 VERIFY minor 2): a present-but-non-array likedVideos
          // is skipped (liked data is re-syncable) rather than aborting the whole
          // restore, but flag it so the UI can warn instead of dropping silently.
          likedStructuralError = true;
        }
        likedSyncMeta = sanitizeLikedSyncMetaFlat(data.likedSyncMeta);
        if (data.likedSyncMeta != null && (typeof data.likedSyncMeta !== 'object' || Array.isArray(data.likedSyncMeta))) {
          likedMetaStructuralError = true;
        }
      }

      return {
        schemaVersion: data && typeof data === 'object' && data.schemaVersion === 2 ? 2 : 1,
        watchedVideos: w.valid,
        likedVideos,
        likedSyncMeta,
        droppedWatched: w.dropped,
        droppedLiked,
        likedStructuralError,
        likedMetaStructuralError,
      };
    }

    // u1ps §7.3: pure, read-only dry-run diff between a parsed import backup and
    // the current DB ids. Powers the "追加 / 更新 / 削除予定 / 無効" preview shown
    // before the user picks an import mode.
    //   add         = ids in backup but not currently present (new records)
    //   overlap     = ids in both (updated/merged/overwritten per mode)
    //   currentOnly = ids present now but absent from backup — REMOVED only by 置換
    //   invalid     = records dropped while parsing the backup
    function diffImport(parsed, currentWatchedIds, currentLikedIds) {
      function counts(backupRecords, currentIds) {
        const cur = new Set(Array.isArray(currentIds) ? currentIds : []);
        const bk = new Set((Array.isArray(backupRecords) ? backupRecords : [])
          .map((r) => r && r.videoId)
          .filter((v) => typeof v === 'string' && v));
        let add = 0;
        let overlap = 0;
        for (const id of bk) { if (cur.has(id)) overlap++; else add++; }
        let currentOnly = 0;
        for (const id of cur) { if (!bk.has(id)) currentOnly++; }
        return { backup: bk.size, current: cur.size, add, overlap, currentOnly };
      }
      const p = parsed || {};
      return {
        watched: counts(p.watchedVideos, currentWatchedIds),
        liked: counts(p.likedVideos, currentLikedIds),
        invalid: {
          watched: p.droppedWatched || 0,
          liked: p.droppedLiked || 0,
          likedStructural: !!p.likedStructuralError,
          likedMetaStructural: !!p.likedMetaStructuralError,
        },
      };
    }

    function normalizeRecord(record) {
      const normalized = {
        videoId: String(record.videoId),
        title: typeof record.title === 'string' ? record.title : '',
        channel: typeof record.channel === 'string' ? record.channel : '',
        watchedAt: typeof record.watchedAt === 'number' && Number.isFinite(record.watchedAt) && record.watchedAt > 0 ? record.watchedAt : Date.now(),
        firstWatchedAt: typeof record.firstWatchedAt === 'number' && Number.isFinite(record.firstWatchedAt) && record.firstWatchedAt > 0
          ? record.firstWatchedAt
          : (typeof record.watchedAt === 'number' && Number.isFinite(record.watchedAt) && record.watchedAt > 0 ? record.watchedAt : Date.now()),
        playCount: typeof record.playCount === 'number' && Number.isFinite(record.playCount) && record.playCount >= 0 ? record.playCount : 0,
        source: typeof record.source === 'string' ? record.source : 'unknown',
        durationSec: typeof record.durationSec === 'number' && Number.isFinite(record.durationSec)
          ? (record.durationSec === -1 || record.durationSec > 0 ? Math.round(record.durationSec) : null)
          : null,
        composer: typeof record.composer === 'string' ? record.composer : '',
        lyricist: typeof record.lyricist === 'string' ? record.lyricist : '',
        arranger: typeof record.arranger === 'string' ? record.arranger : '',
        creditsCheckedAt: typeof record.creditsCheckedAt === 'number' && Number.isFinite(record.creditsCheckedAt) && record.creditsCheckedAt > 0 ? record.creditsCheckedAt : 0,
        creditsSource: typeof record.creditsSource === 'string' ? record.creditsSource : '',
        creditRoleSources: sanitizeCreditRoleSources(record.creditRoleSources),
        creditsRaw: typeof record.creditsRaw === 'string' ? record.creditsRaw : '',
        creditsFetchFailReason: typeof record.creditsFetchFailReason === 'string' ? record.creditsFetchFailReason : '',
        creditsFetchAttemptedAt: typeof record.creditsFetchAttemptedAt === 'number' && Number.isFinite(record.creditsFetchAttemptedAt) && record.creditsFetchAttemptedAt > 0 ? record.creditsFetchAttemptedAt : 0,
        durationFetchFailed: typeof record.durationFetchFailed === 'string' ? record.durationFetchFailed : '',
        category: typeof record.category === 'string' ? record.category : '',
      };
      const mbLookup = sanitizeMbLookup(record.mbLookup);
      if (mbLookup) normalized.mbLookup = mbLookup;
      return normalized;
    }

    async function importData(records) {
      // Tolerant (M3): only a non-array is unrecoverable; individual invalid
      // records are dropped so the rest still import.
      if (!Array.isArray(records)) {
        throw new Error('Invalid import records: expected an array');
      }
      const db = await openDB();
      const normalized = records.filter(isValidRecord).map(normalizeRecord);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const record of normalized) {
          store.put(record);
        }
        tx.oncomplete = () => resolve(normalized.length);
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    async function clearAll() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.clear();
        // Resolve on tx.oncomplete (M2): request.onsuccess fires before the
        // transaction commits, so callers that immediately re-count/export
        // could observe pre-commit state, or treat a later abort as success.
        tx.oncomplete = () => resolve();
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    // Get all video IDs only (lightweight, for cache loading)
    async function getAllIds() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => reject(event.target.error);
      });
    }

    async function getWatchedIdsPage(cursor = null, limit = 8000) {
      const db = await openDB();
      const pageLimit = Math.max(1, Math.min(Number(limit) || 8000, 50000));
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const range = cursor ? IDBKeyRange.lowerBound(String(cursor), true) : null;
        const request = store.openKeyCursor(range);
        const ids = [];
        let lastKey = null;
        let resolved = false;

        function finish(nextCursor) {
          if (resolved) return;
          resolved = true;
          resolve({ ids, nextCursor: nextCursor || null });
        }

        request.onsuccess = (event) => {
          const c = event.target.result;
          if (!c) {
            finish(null);
            return;
          }
          if (ids.length >= pageLimit) {
            finish(lastKey);
            return;
          }
          lastKey = String(c.key);
          ids.push(lastKey);
          c.continue();
        };
        request.onerror = (event) => reject(event.target.error);
      });
    }

    async function deleteOne(videoId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(videoId);
        tx.oncomplete = () => resolve();
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    // Merge import: only add new records, keep existing ones intact
    // Returns { added, skipped, total }
    async function mergeImport(records) {
      // Tolerant (M3): drop individual invalid records instead of rejecting the
      // whole merge; only a non-array is unrecoverable.
      if (!Array.isArray(records)) {
        throw new Error('Invalid import records: expected an array');
      }
      const db = await openDB();
      const validRaw = records.filter(isValidRecord);
      const dropped = records.length - validRaw.length;
      const valid = validRaw.map(normalizeRecord);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        let added = 0;
        let skipped = 0;
        let pending = valid.length;

        // pending === 0 (empty / all-invalid) intentionally falls through: an
        // empty readwrite tx still fires tx.oncomplete, which resolves with the
        // consistent shape { added, skipped, total, dropped } (M2 commit-gating
        // + M3 dropped count on every path).

        for (const record of valid) {
          const getReq = store.get(record.videoId);
          getReq.onsuccess = () => {
            if (!getReq.result) {
              // New record: add it
              store.put(record);
              added++;
            } else {
              // Existing: merge playCount and keep newer watchedAt
              const existing = getReq.result;
              let updated = false;
              if (record.playCount > (existing.playCount || 0)) {
                existing.playCount = record.playCount;
                updated = true;
              }
              if (record.watchedAt > existing.watchedAt) {
                existing.watchedAt = record.watchedAt;
                updated = true;
              }
              if (record.title && !existing.title) {
                existing.title = record.title;
                updated = true;
              }
              if (record.channel && !existing.channel) {
                existing.channel = record.channel;
                updated = true;
              }
              if (record.firstWatchedAt && (!existing.firstWatchedAt || record.firstWatchedAt < existing.firstWatchedAt)) {
                existing.firstWatchedAt = record.firstWatchedAt;
                updated = true;
              }
              if (record.durationSec != null && existing.durationSec == null) {
                existing.durationSec = record.durationSec;
                if (existing.durationFetchFailed) delete existing.durationFetchFailed;
                updated = true;
              }
              if (record.durationFetchFailed && existing.durationSec == null && !existing.durationFetchFailed) {
                existing.durationFetchFailed = record.durationFetchFailed;
                updated = true;
              }
              for (const role of CREDIT_ROLES) {
                const currentSource = globalThis.CreditTarget.effectiveRoleSource(existing, role);
                if (!globalThis.CreditTarget.creditIsBlank(record[role])
                  && globalThis.CreditTarget.creditIsBlank(existing[role])
                  && currentSource !== 'manual') {
                  existing[role] = record[role];
                  const roleSources = sanitizeCreditRoleSources(existing.creditRoleSources);
                  const incomingSource = globalThis.CreditTarget.effectiveRoleSource(record, role);
                  if (CREDIT_ROLE_SOURCES.has(incomingSource)) roleSources[role] = incomingSource;
                  else delete roleSources[role];
                  if (Object.keys(roleSources).length) existing.creditRoleSources = roleSources;
                  else delete existing.creditRoleSources;
                  updated = true;
                }
              }
              if (record.creditsRaw && !existing.creditsRaw) {
                existing.creditsRaw = record.creditsRaw;
                updated = true;
              }
              if (record.creditsCheckedAt > (existing.creditsCheckedAt || 0)) {
                existing.creditsCheckedAt = record.creditsCheckedAt;
                updated = true;
              }
              if (record.mbLookup
                && record.mbLookup.checkedAt > ((sanitizeMbLookup(existing.mbLookup) || {}).checkedAt || 0)) {
                existing.mbLookup = record.mbLookup;
                updated = true;
              }
              if (record.creditsSource && !existing.creditsSource) {
                existing.creditsSource = record.creditsSource;
                updated = true;
              }
              if (record.creditsFetchAttemptedAt > (existing.creditsFetchAttemptedAt || 0)) {
                existing.creditsFetchFailReason = record.creditsFetchFailReason || '';
                existing.creditsFetchAttemptedAt = record.creditsFetchAttemptedAt;
                updated = true;
              }
              // microformat category (PENDING L98 / M3): backfill from an import
              // that captured it when the local record predates the capture
              // change. Forward-only field, so only fill when missing locally.
              if (record.category && !existing.category) {
                existing.category = record.category;
                updated = true;
              }
              if (updated) store.put(existing);
              skipped++;
            }
            if (--pending === 0) {
              // will resolve on tx.oncomplete
            }
          };
        }

        tx.oncomplete = () => resolve({ added, skipped, total: valid.length, dropped });
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    // --- Liked videos store ---
    async function upsertLiked(items, accountId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(LIKED_STORE, 'readwrite');
        const store = tx.objectStore(LIKED_STORE);
        let added = 0;
        let pending = items.length;
        if (!pending) return resolve({ added: 0, total: 0 });
        for (const it of items) {
          const getReq = store.get(it.videoId);
          getReq.onsuccess = () => {
            const existing = getReq.result;
            if (!existing) added++;
            store.put({
              videoId: it.videoId,
              title: it.title || (existing && existing.title) || '',
              channel: it.channel || (existing && existing.channel) || '',
              likedAt: (existing && existing.likedAt) || it.likedAt || Date.now(),
              accountId: accountId || (existing && existing.accountId) || '',
              syncedAt: Date.now(),
              playlistIndex: typeof it.playlistIndex === 'number' ? it.playlistIndex : (existing && existing.playlistIndex) || 0,
            });
            if (--pending === 0) { /* resolved on tx.oncomplete */ }
          };
        }
        tx.oncomplete = () => resolve({ added, total: items.length });
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    async function getAllLiked() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(LIKED_STORE, 'readonly');
        const store = tx.objectStore(LIKED_STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
      });
    }

    function normalizeLikedRecord(record) {
      return {
        videoId: String(record.videoId),
        title: typeof record.title === 'string' ? record.title : '',
        channel: typeof record.channel === 'string' ? record.channel : '',
        likedAt: typeof record.likedAt === 'number' && Number.isFinite(record.likedAt) && record.likedAt > 0 ? record.likedAt : Date.now(),
        accountId: typeof record.accountId === 'string' ? record.accountId : '',
        syncedAt: typeof record.syncedAt === 'number' && Number.isFinite(record.syncedAt) && record.syncedAt > 0 ? record.syncedAt : Date.now(),
        playlistIndex: typeof record.playlistIndex === 'number' && Number.isFinite(record.playlistIndex) ? record.playlistIndex : 0,
      };
    }

    async function importLikedData(records) {
      const db = await openDB();
      // Tolerant (M3): drop invalid liked records instead of rejecting all.
      const list = Array.isArray(records) ? records : [];
      const normalized = list.filter(isValidLikedRecord).map(normalizeLikedRecord);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(LIKED_STORE, 'readwrite');
        const store = tx.objectStore(LIKED_STORE);
        for (const record of normalized) {
          store.put(record);
        }
        tx.oncomplete = () => resolve(normalized.length);
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    // u1ps §7.3 (Codex B2 VERIFY blocker 1): current-priority liked merge for the
    // "安全に統合" mode. Only ADD liked ids not already present; existing liked
    // records are kept untouched (current wins), unlike importLikedData's put
    // (backup wins). Returns { added, skipped, total }.
    async function mergeLikedData(records) {
      const list = Array.isArray(records) ? records : [];
      // Dedupe by videoId (Codex B2 minor 2): duplicate new ids in the backup
      // would otherwise each observe "absent" and over-count `added`.
      const seen = new Set();
      const normalized = [];
      for (const rec of list.filter(isValidLikedRecord).map(normalizeLikedRecord)) {
        if (seen.has(rec.videoId)) continue;
        seen.add(rec.videoId);
        normalized.push(rec);
      }
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(LIKED_STORE, 'readwrite');
        const store = tx.objectStore(LIKED_STORE);
        let added = 0;
        let skipped = 0;
        // Empty list still fires tx.oncomplete and resolves with the consistent shape.
        for (const record of normalized) {
          const getReq = store.get(record.videoId);
          getReq.onsuccess = () => {
            if (getReq.result) { skipped++; } else { store.put(record); added++; }
          };
        }
        tx.oncomplete = () => resolve({ added, skipped, total: normalized.length });
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    async function clearLikedByAccount(accountId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(LIKED_STORE, 'readwrite');
        const store = tx.objectStore(LIKED_STORE);
        if (!accountId) {
          store.clear();
        } else {
          const idx = store.index('accountId');
          const range = IDBKeyRange.only(accountId);
          const req = idx.openCursor(range);
          req.onsuccess = (e) => {
            const c = e.target.result;
            if (c) { c.delete(); c.continue(); }
          };
        }
        // Resolve on tx.oncomplete (M2): unify both branches on transaction
        // commit so the clear-all path no longer resolves before commit.
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
        tx.onabort = (e) => reject(e.target.error);
      });
    }

    // u1ps §7.4 (Codex B1 VERIFY, freeze-free reset): delete a SPECIFIC set of
    // record ids from both watched + liked stores in one transaction. The
    // "全データを初期化" flow passes the exact ids captured in the pre-reset backup
    // snapshot, so any record written AFTER the snapshot is not in these lists and
    // survives — it is never deleted-without-backup, and no lock/freeze is needed
    // to avoid the backup->clear race. Empty lists => no-op. likedSyncMeta lives
    // in chrome.storage.local (not IndexedDB) and is cleared by the caller.
    async function deleteManyRecords(watchedIds, likedIds) {
      const wIds = Array.isArray(watchedIds) ? watchedIds : [];
      const lIds = Array.isArray(likedIds) ? likedIds : [];
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME, LIKED_STORE], 'readwrite');
        const wStore = tx.objectStore(STORE_NAME);
        const lStore = tx.objectStore(LIKED_STORE);
        for (const id of wIds) wStore.delete(id);
        for (const id of lIds) lStore.delete(id);
        // Resolve on commit (M2 pattern): request.onsuccess fires pre-commit.
        tx.oncomplete = () => resolve({ watched: wIds.length, liked: lIds.length });
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    // u1ps §7.3 (Codex B2 VERIFY blocker 3): ATOMIC replace. Deletes the given
    // snapshot-only ids AND puts the new records across BOTH stores in a SINGLE
    // transaction, so a mid-way failure aborts the whole thing (no half-replaced
    // DB left as "deleted but not re-imported"). The caller computes
    // delWatchedIds/delLikedIds = (pre-replace snapshot ids \ new ids), so records
    // written after the snapshot (a new videoId not in the snapshot list) are not
    // deleted and survive. NOTE: this survival guarantee is for NEW post-snapshot
    // ids only — a snapshot id that was re-updated after the snapshot is either
    // deleted (absent from backup) or overwritten by the backup version.
    async function replaceRecords(delWatchedIds, delLikedIds, newWatchedRecords, newLikedRecords) {
      const dW = Array.isArray(delWatchedIds) ? delWatchedIds : [];
      const dL = Array.isArray(delLikedIds) ? delLikedIds : [];
      const nW = (Array.isArray(newWatchedRecords) ? newWatchedRecords : []).filter(isValidRecord).map(normalizeRecord);
      const nL = (Array.isArray(newLikedRecords) ? newLikedRecords : []).filter(isValidLikedRecord).map(normalizeLikedRecord);
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME, LIKED_STORE], 'readwrite');
        const wStore = tx.objectStore(STORE_NAME);
        const lStore = tx.objectStore(LIKED_STORE);
        for (const id of dW) wStore.delete(id);
        for (const id of dL) lStore.delete(id);
        for (const r of nW) wStore.put(r);
        for (const r of nL) lStore.put(r);
        tx.oncomplete = () => resolve({
          deletedWatched: dW.length, deletedLiked: dL.length,
          importedWatched: nW.length, importedLiked: nL.length,
        });
        tx.onerror = (event) => reject(event.target.error);
        tx.onabort = (event) => reject(event.target.error);
      });
    }

    async function getLikedStats() {
      const all = await getAllLiked();
      const accounts = new Map();
      for (const r of all) {
        const k = r.accountId || '(unknown)';
        accounts.set(k, (accounts.get(k) || 0) + 1);
      }
      return { total: all.length, accounts: [...accounts.entries()] };
    }

    return { openDB, addWatched, updateDuration, markDurationFailed, markDurationLive, updateTitle, updateTitleAndChannel, updateCredits, recordMbLookup, getCreditsForVideoIds, setManualCreditRole, markCreditsChecked, markCreditsFailed, cleanAllCredits, repairInvalidCredits, restoreRepairedCredits, verifyCreditRepair, isWatched, checkMultiple, getStats, getAllIds, getWatchedIdsPage, exportAll, importData, mergeImport, clearAll, deleteOne, wrapExport, unwrapImport, unwrapWatchedRecords, parseImportData, diffImport,
      upsertLiked, getAllLiked, importLikedData, mergeLikedData, clearLikedByAccount, deleteManyRecords, replaceRecords, getLikedStats };
  })();
}
