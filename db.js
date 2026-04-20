// IndexedDB wrapper for YouTube Watched Hider
// Safe to re-inject: uses var + existence check
if (typeof WatchedDB === 'undefined') {
  var WatchedDB = (() => {
    const DB_NAME = 'YouTubeWatchedDB';
    const DB_VERSION = 3;
    const STORE_NAME = 'watchedVideos';

    let dbInstance = null;

    function openDB() {
      if (dbInstance) return Promise.resolve(dbInstance);

      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'videoId' });
            store.createIndex('watchedAt', 'watchedAt', { unique: false });
          }
          // Migration: existing records get playCount=1, source='unknown'
          if (event.oldVersion < 2) {
            const tx = event.target.transaction;
            const store = tx.objectStore(STORE_NAME);
            store.openCursor().onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                const record = cursor.value;
                if (!record.playCount) record.playCount = 1;
                if (!record.source) record.source = 'unknown';
                cursor.update(record);
                cursor.continue();
              }
            };
          }
        };

        request.onsuccess = (event) => {
          dbInstance = event.target.result;
          dbInstance.onclose = () => { dbInstance = null; };
          resolve(dbInstance);
        };

        request.onerror = (event) => {
          reject(event.target.error);
        };
      });
    }

    // source: 'self' (user actually played) or 'seekbar' (detected via YouTube seekbar)
    async function addWatched(videoId, title = '', source = 'self', channel = '') {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        // Check existing record first to preserve title and increment playCount
        const getReq = store.get(videoId);
        let wasNew = false;
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (existing) {
            // Only increment playCount for actual plays (source='self'), not seekbar re-detection
            const shouldIncrement = source === 'self';
            store.put({
              videoId,
              title: title || existing.title || '',
              channel: channel || existing.channel || '',
              watchedAt: shouldIncrement ? Date.now() : existing.watchedAt,
              firstWatchedAt: existing.firstWatchedAt || existing.watchedAt,
              playCount: shouldIncrement ? (existing.playCount || 1) + 1 : (existing.playCount || 1),
              source: existing.source === 'self' ? 'self' : source,
            });
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
            });
          }
        };

        tx.oncomplete = () => resolve({ isNew: wasNew });
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
    async function updateCredits(videoId, credits, force = false) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(videoId);
        let didUpdate = false;
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (!existing) return;
          for (const k of ['composer', 'lyricist', 'arranger']) {
            const v = credits && credits[k];
            if (v && (force || !existing[k])) {
              existing[k] = v;
              didUpdate = true;
            }
          }
          // Always stamp "checked" so we can skip already-scanned videos next run.
          existing.creditsCheckedAt = Date.now();
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
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);

        let pending = videoIds.length;
        if (pending === 0) return resolve(results);

        for (const id of videoIds) {
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

    async function exportAll() {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => reject(event.target.error);
      });
    }

    // Current export schema version
    const SCHEMA_VERSION = 1;

    // Wrap records in versioned envelope for export
    function wrapExport(records) {
      return {
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        appVersion: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
          ? chrome.runtime.getManifest().version : 'unknown',
        count: records.length,
        records,
      };
    }

    // Unwrap import data: accept both envelope format and legacy raw array
    function unwrapImport(data) {
      if (Array.isArray(data)) return data;
      if (data && typeof data === 'object' && Array.isArray(data.records)) return data.records;
      return null;
    }

    // Validate and normalize a record
    function isValidRecord(record) {
      if (!record || typeof record.videoId !== 'string' || record.videoId.length === 0) return false;
      return true;
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
        composer: typeof record.composer === 'string' ? record.composer : '',
        lyricist: typeof record.lyricist === 'string' ? record.lyricist : '',
        arranger: typeof record.arranger === 'string' ? record.arranger : '',
        creditsCheckedAt: typeof record.creditsCheckedAt === 'number' && record.creditsCheckedAt > 0 ? record.creditsCheckedAt : 0,
      };
    }

    async function importData(records) {
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

    return { openDB, addWatched, updateTitle, updateTitleAndChannel, updateCredits, markCreditsChecked, isWatched, checkMultiple, getStats, getAllIds, exportAll, importData, mergeImport, clearAll, deleteOne, wrapExport, unwrapImport };
  })();
}
