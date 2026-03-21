// IndexedDB wrapper for YouTube Watched Hider
// Safe to re-inject: uses var + existence check
if (typeof WatchedDB === 'undefined') {
  var WatchedDB = (() => {
    const DB_NAME = 'YouTubeWatchedDB';
    const DB_VERSION = 2;
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

        tx.oncomplete = () => resolve();
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

    // Update title and channel (without incrementing playCount)
    async function updateTitleAndChannel(videoId, title, channel) {
      if (!title && !channel) return;
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(videoId);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (existing) {
            let updated = false;
            if (title && !existing.title) { existing.title = title; updated = true; }
            if (channel && !existing.channel) { existing.channel = channel; updated = true; }
            if (updated) store.put(existing);
          }
        };
        tx.oncomplete = () => resolve();
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

    async function importData(records) {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const record of records) {
          store.put(record);
        }
        tx.oncomplete = () => resolve(records.length);
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

    return { openDB, addWatched, updateTitle, updateTitleAndChannel, isWatched, checkMultiple, getStats, getAllIds, exportAll, importData, clearAll, deleteOne };
  })();
}
