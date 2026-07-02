// IndexedDB wrapper for YouTube Watched Hider
// Safe to re-inject: uses var + existence check
if (typeof WatchedDB === 'undefined') {
  var WatchedDB = (() => {
    const DB_NAME = 'YouTubeWatchedDB';
    const DB_VERSION = 5;
    const STORE_NAME = 'watchedVideos';
    const LIKED_STORE = 'likedVideos';

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

    // Update credits (composer/lyricist/arranger). Force overwrites non-empty.
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
          for (const k of ['composer', 'lyricist', 'arranger', 'creditsRaw']) {
            const v = credits && credits[k];
            if (v && (force || !existing[k])) {
              existing[k] = v;
              didUpdate = true;
            }
          }
          if (source && (force || !existing.creditsSource)) {
            existing.creditsSource = source;
          }
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
      return ['manual', 'auto', 'backup-now'].includes(source) ? source : 'manual';
    }

    function emptyLikedSyncMeta() {
      return {
        schemaVersion: 2,
        lastAccountId: '',
        accounts: {},
      };
    }

    function sanitizeLikedSyncMeta(meta, useEmptyFallback = false) {
      if (!meta || typeof meta !== 'object') return useEmptyFallback ? emptyLikedSyncMeta() : null;
      const rawAccounts = meta.accounts && typeof meta.accounts === 'object' ? meta.accounts : null;
      const accounts = {};
      if (rawAccounts) {
        for (const [rawId, rawAccount] of Object.entries(rawAccounts)) {
          if (!rawAccount || typeof rawAccount !== 'object') continue;
          const accountId = typeof rawAccount.accountId === 'string' && rawAccount.accountId
            ? rawAccount.accountId
            : String(rawId || '');
          if (!accountId) continue;
          accounts[accountId] = {
            accountId,
            ownerName: typeof rawAccount.ownerName === 'string' ? rawAccount.ownerName : '',
            ownerHandle: typeof rawAccount.ownerHandle === 'string' ? rawAccount.ownerHandle : '',
            ownerChannelId: typeof rawAccount.ownerChannelId === 'string' ? rawAccount.ownerChannelId : '',
            lastSyncedAt: typeof rawAccount.lastSyncedAt === 'number' ? rawAccount.lastSyncedAt : 0,
            count: typeof rawAccount.count === 'number' ? rawAccount.count : 0,
            accountSource: typeof rawAccount.accountSource === 'string' ? rawAccount.accountSource : '',
          };
        }
      } else {
        const accountId = typeof meta.accountId === 'string' && meta.accountId
          ? meta.accountId
          : (typeof meta.ownerChannelId === 'string' && meta.ownerChannelId
            ? meta.ownerChannelId
            : (typeof meta.ownerHandle === 'string' && meta.ownerHandle ? meta.ownerHandle : ''));
        if (accountId) {
          accounts[accountId] = {
            accountId,
            ownerName: typeof meta.ownerName === 'string' ? meta.ownerName : '',
            ownerHandle: typeof meta.ownerHandle === 'string' ? meta.ownerHandle : '',
            ownerChannelId: typeof meta.ownerChannelId === 'string' ? meta.ownerChannelId : '',
            lastSyncedAt: typeof meta.lastSyncedAt === 'number' ? meta.lastSyncedAt : 0,
            count: typeof meta.count === 'number' ? meta.count : 0,
            accountSource: typeof meta.accountSource === 'string' ? meta.accountSource : '',
          };
        }
      }

      const lastAccountId = typeof meta.lastAccountId === 'string' && meta.lastAccountId
        ? meta.lastAccountId
        : Object.keys(accounts)[0] || '';

      return {
        schemaVersion: 2,
        lastAccountId,
        accounts,
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
        likedSyncMeta: sanitizeLikedSyncMeta(options.likedSyncMeta, true),
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
      if (!record || typeof record !== 'object' || typeof record.videoId !== 'string' || record.videoId.length === 0) return false;
      const stringFields = ['title', 'channel', 'source', 'composer', 'lyricist', 'arranger', 'creditsSource', 'creditsRaw', 'creditsFetchFailReason', 'durationFetchFailed', 'category'];
      const numberFields = ['watchedAt', 'firstWatchedAt', 'playCount', 'durationSec', 'creditsCheckedAt', 'creditsFetchAttemptedAt'];
      for (const field of stringFields) {
        if (record[field] != null && typeof record[field] !== 'string') return false;
      }
      for (const field of numberFields) {
        if (record[field] != null && (typeof record[field] !== 'number' || !Number.isFinite(record[field]))) return false;
      }
      return true;
    }

    function validateWatchedRecords(records) {
      return Array.isArray(records) && records.every(isValidRecord);
    }

    function isValidLikedRecord(record) {
      if (!record || typeof record !== 'object' || typeof record.videoId !== 'string' || record.videoId.length === 0) return false;
      const stringFields = ['title', 'channel', 'accountId'];
      const numberFields = ['likedAt', 'syncedAt', 'playlistIndex'];
      for (const field of stringFields) {
        if (record[field] != null && typeof record[field] !== 'string') return false;
      }
      for (const field of numberFields) {
        if (record[field] != null && (typeof record[field] !== 'number' || !Number.isFinite(record[field]))) return false;
      }
      return true;
    }

    function validateLikedRecords(records) {
      return Array.isArray(records) && records.every(isValidLikedRecord);
    }

    function parseImportData(data) {
      const watchedVideos = unwrapWatchedRecords(data);
      if (!validateWatchedRecords(watchedVideos)) {
        throw new Error('Invalid import format: watched records must be an array of valid records');
      }

      let likedVideos = [];
      let likedSyncMeta = null;
      if (data && typeof data === 'object' && data.schemaVersion === 2) {
        if (data.likedVideos != null) {
          if (!validateLikedRecords(data.likedVideos)) {
            throw new Error('Invalid import format: likedVideos must be an array of valid records');
          }
          likedVideos = data.likedVideos;
        }
        likedSyncMeta = data.likedSyncMeta != null ? sanitizeLikedSyncMeta(data.likedSyncMeta) : null;
      }

      return {
        schemaVersion: data && typeof data === 'object' && data.schemaVersion === 2 ? 2 : 1,
        watchedVideos,
        likedVideos,
        likedSyncMeta,
      };
    }

    function normalizeRecord(record) {
      return {
        videoId: String(record.videoId),
        title: typeof record.title === 'string' ? record.title : '',
        channel: typeof record.channel === 'string' ? record.channel : '',
        watchedAt: typeof record.watchedAt === 'number' && record.watchedAt > 0 ? record.watchedAt : Date.now(),
        firstWatchedAt: typeof record.firstWatchedAt === 'number' && record.firstWatchedAt > 0 ? record.firstWatchedAt : (typeof record.watchedAt === 'number' ? record.watchedAt : Date.now()),
        playCount: typeof record.playCount === 'number' && record.playCount >= 0 ? record.playCount : 0,
        source: typeof record.source === 'string' ? record.source : 'unknown',
        durationSec: typeof record.durationSec === 'number' && Number.isFinite(record.durationSec)
          ? (record.durationSec === -1 || record.durationSec > 0 ? Math.round(record.durationSec) : null)
          : null,
        composer: typeof record.composer === 'string' ? record.composer : '',
        lyricist: typeof record.lyricist === 'string' ? record.lyricist : '',
        arranger: typeof record.arranger === 'string' ? record.arranger : '',
        creditsCheckedAt: typeof record.creditsCheckedAt === 'number' && record.creditsCheckedAt > 0 ? record.creditsCheckedAt : 0,
        creditsSource: typeof record.creditsSource === 'string' ? record.creditsSource : '',
        creditsRaw: typeof record.creditsRaw === 'string' ? record.creditsRaw : '',
        creditsFetchFailReason: typeof record.creditsFetchFailReason === 'string' ? record.creditsFetchFailReason : '',
        creditsFetchAttemptedAt: typeof record.creditsFetchAttemptedAt === 'number' && record.creditsFetchAttemptedAt > 0 ? record.creditsFetchAttemptedAt : 0,
        durationFetchFailed: typeof record.durationFetchFailed === 'string' ? record.durationFetchFailed : '',
        category: typeof record.category === 'string' ? record.category : '',
      };
    }

    async function importData(records) {
      if (!validateWatchedRecords(records)) {
        throw new Error('Invalid import records');
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
      });
    }

    async function clearAll() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
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
      if (!validateWatchedRecords(records)) {
        throw new Error('Invalid import records');
      }
      const db = await openDB();
      const valid = records.filter(isValidRecord).map(normalizeRecord);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        let added = 0;
        let skipped = 0;
        let pending = valid.length;

        if (pending === 0) return resolve({ added: 0, skipped: 0, total: 0 });

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
              for (const field of ['composer', 'lyricist', 'arranger', 'creditsRaw']) {
                if (record[field] && !existing[field]) {
                  existing[field] = record[field];
                  updated = true;
                }
              }
              if (record.creditsCheckedAt > (existing.creditsCheckedAt || 0)) {
                existing.creditsCheckedAt = record.creditsCheckedAt;
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

        tx.oncomplete = () => resolve({ added, skipped, total: valid.length });
        tx.onerror = (event) => reject(event.target.error);
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
        likedAt: typeof record.likedAt === 'number' && record.likedAt > 0 ? record.likedAt : Date.now(),
        accountId: typeof record.accountId === 'string' ? record.accountId : '',
        syncedAt: typeof record.syncedAt === 'number' && record.syncedAt > 0 ? record.syncedAt : Date.now(),
        playlistIndex: typeof record.playlistIndex === 'number' ? record.playlistIndex : 0,
      };
    }

    async function importLikedData(records) {
      const db = await openDB();
      if (!validateLikedRecords(records || [])) {
        throw new Error('Invalid liked import records');
      }
      const normalized = (records || []).map(normalizeLikedRecord);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(LIKED_STORE, 'readwrite');
        const store = tx.objectStore(LIKED_STORE);
        for (const record of normalized) {
          store.put(record);
        }
        tx.oncomplete = () => resolve(normalized.length);
        tx.onerror = (event) => reject(event.target.error);
      });
    }

    async function clearLikedByAccount(accountId) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(LIKED_STORE, 'readwrite');
        const store = tx.objectStore(LIKED_STORE);
        if (!accountId) {
          const req = store.clear();
          req.onsuccess = () => resolve();
          req.onerror = (e) => reject(e.target.error);
          return;
        }
        const idx = store.index('accountId');
        const range = IDBKeyRange.only(accountId);
        const req = idx.openCursor(range);
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (c) { c.delete(); c.continue(); }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
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

    return { openDB, addWatched, updateDuration, markDurationFailed, markDurationLive, updateTitle, updateTitleAndChannel, updateCredits, markCreditsChecked, markCreditsFailed, cleanAllCredits, isWatched, checkMultiple, getStats, getAllIds, getWatchedIdsPage, exportAll, importData, mergeImport, clearAll, deleteOne, wrapExport, unwrapImport, unwrapWatchedRecords, parseImportData,
      upsertLiked, getAllLiked, importLikedData, clearLikedByAccount, getLikedStats };
  })();
}
