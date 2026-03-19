// Service Worker for YouTube Watched Hider
// Handles: tab URL monitoring, message passing, auto-backup

// Extract video ID from YouTube URL
function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com') && u.pathname === '/watch') {
      return u.searchParams.get('v');
    }
  } catch (e) {
    // invalid URL
  }
  return null;
}

// Track which videos have been recorded this session to avoid duplicate writes
const recentlyRecorded = new Set();

// Listen for tab URL changes to detect video plays
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const videoId = extractVideoId(changeInfo.url);
    if (videoId && !recentlyRecorded.has(videoId)) {
      recentlyRecorded.add(videoId);
      chrome.tabs.sendMessage(tabId, {
        type: 'VIDEO_DETECTED',
        videoId
      }).catch(() => {});
    }
  }
});

// Clean up recentlyRecorded periodically to prevent memory growth
setInterval(() => {
  if (recentlyRecorded.size > 10000) {
    recentlyRecorded.clear();
  }
}, 60 * 60 * 1000);

// --- Auto-backup ---

const BACKUP_ALARM = 'auto-backup';
const BACKUP_FILENAME = 'yt-watched-backup.json';

// Re-inject content scripts into existing YouTube tabs on install/update/enable
async function reinjectContentScripts() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    for (const tab of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['db.js', 'content.js']
      }).catch(() => {});
    }
  } catch (e) {
    // scripting API not available or tabs not accessible
  }
}

// Set up daily backup alarm + re-inject content scripts
chrome.runtime.onInstalled.addListener(() => {
  reinjectContentScripts();
  chrome.alarms.create(BACKUP_ALARM, {
    periodInMinutes: 24 * 60 // daily
  });
});

// Also ensure alarm exists on startup + re-inject
chrome.runtime.onStartup.addListener(() => {
  reinjectContentScripts();
  chrome.alarms.get(BACKUP_ALARM, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(BACKUP_ALARM, {
        periodInMinutes: 24 * 60
      });
    }
  });
});

// Handle alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) {
    performAutoBackup();
  }
});

function performAutoBackup() {
  chrome.storage.local.get({ autoBackup: true }, (settings) => {
    if (!settings.autoBackup) return;

    // Get data from a YouTube tab
    chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
      if (tabs.length === 0) return;

      chrome.tabs.sendMessage(tabs[0].id, { type: 'EXPORT_DATA' })
        .then((data) => {
          if (!data || data.length === 0) return;

          const json = JSON.stringify(data, null, 2);
          const blob = new Blob([json], { type: 'application/json' });
          const url = URL.createObjectURL(blob);

          chrome.downloads.download({
            url,
            filename: BACKUP_FILENAME,
            conflictAction: 'overwrite',
            saveAs: false
          }, (downloadId) => {
            if (downloadId) {
              chrome.storage.local.set({
                lastBackup: Date.now(),
                lastBackupCount: data.length
              });
            }
            // Clean up blob URL after a delay
            setTimeout(() => URL.revokeObjectURL(url), 10000);
          });
        })
        .catch(() => {});
    });
  });
}

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // --- DB operations via chrome.scripting.executeScript ---
  // Runs code directly in a YouTube tab's main world to access IndexedDB,
  // bypassing unreliable content script message passing.

  function runInYouTubeTab(scriptFn, args = []) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        if (tabs.length === 0) {
          reject(new Error('No YouTube tab open'));
          return;
        }
        // Try each tab until one succeeds
        function tryTab(i) {
          if (i >= tabs.length) {
            reject(new Error('All YouTube tabs failed'));
            return;
          }
          chrome.scripting.executeScript({
            target: { tabId: tabs[i].id },
            world: 'MAIN',
            func: scriptFn,
            args,
          }).then((results) => {
            resolve(results[0]?.result);
          }).catch(() => tryTab(i + 1));
        }
        tryTab(0);
      });
    });
  }

  // IndexedDB read helper (runs in page context)
  function idbGetAll() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('YouTubeWatchedDB', 2);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('watchedVideos', 'readonly');
        const store = tx.objectStore('watchedVideos');
        const getReq = store.getAll();
        getReq.onsuccess = () => resolve(getReq.result);
        getReq.onerror = () => reject(getReq.error);
      };
    });
  }

  function idbCount() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('YouTubeWatchedDB', 2);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('watchedVideos', 'readonly');
        const store = tx.objectStore('watchedVideos');
        const countReq = store.count();
        countReq.onsuccess = () => resolve(countReq.result);
        countReq.onerror = () => reject(countReq.error);
      };
    });
  }

  function idbClear() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('YouTubeWatchedDB', 2);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('watchedVideos', 'readwrite');
        const store = tx.objectStore('watchedVideos');
        const clearReq = store.clear();
        clearReq.onsuccess = () => resolve();
        clearReq.onerror = () => reject(clearReq.error);
      };
    });
  }

  function idbImport(records) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('YouTubeWatchedDB', 2);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('watchedVideos', 'readwrite');
        const store = tx.objectStore('watchedVideos');
        for (const record of records) {
          store.put(record);
        }
        tx.oncomplete = () => resolve(records.length);
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  if (message.type === 'GET_STATS') {
    runInYouTubeTab(idbCount)
      .then((count) => sendResponse({ count }))
      .catch(() => sendResponse({ count: 0 }));
    return true;
  }

  if (message.type === 'EXPORT_DATA') {
    runInYouTubeTab(idbGetAll)
      .then((data) => sendResponse(data || []))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.type === 'IMPORT_DATA') {
    runInYouTubeTab(idbImport, [message.data])
      .then((count) => sendResponse({ success: true, count }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'CLEAR_DATA') {
    runInYouTubeTab(idbClear)
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'GET_ENABLED') {
    chrome.storage.local.get({
      enabled: true,
      recordWhileOff: false,
      autoBackup: true,
      lastBackup: null,
      lastBackupCount: 0
    }, (result) => {
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'SET_ENABLED') {
    chrome.storage.local.set({ enabled: message.enabled }, () => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'ENABLED_CHANGED',
            enabled: message.enabled
          }).catch(() => {});
        }
      });
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'SET_RECORD_WHILE_OFF') {
    chrome.storage.local.set({ recordWhileOff: message.recordWhileOff }, () => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'RECORD_WHILE_OFF_CHANGED',
            recordWhileOff: message.recordWhileOff
          }).catch(() => {});
        }
      });
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'SET_AUTO_BACKUP') {
    chrome.storage.local.set({ autoBackup: message.autoBackup }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'BACKUP_NOW') {
    performAutoBackup();
    sendResponse({ success: true });
    return true;
  }
});
