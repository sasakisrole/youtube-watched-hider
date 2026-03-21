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

// Schedule daily backup at a fixed hour (default: 3:00 AM)
function scheduleDailyBackup() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  // If 3:00 AM already passed today, schedule for tomorrow
  if (next <= now) next.setDate(next.getDate() + 1);
  const delayInMinutes = Math.max(1, Math.round((next - now) / 60000));

  chrome.alarms.create(BACKUP_ALARM, {
    delayInMinutes,
    periodInMinutes: 24 * 60
  });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleDailyBackup();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get(BACKUP_ALARM, (alarm) => {
    if (!alarm) scheduleDailyBackup();
  });
});

// Handle alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) {
    performAutoBackup();
  }
});

// --- Helper: send message to a YouTube tab with retry ---
// Tries each YouTube tab in order until one responds.
// Does NOT re-inject content scripts (const redeclaration would crash).
async function sendToYouTubeTab(message) {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  if (tabs.length === 0) throw new Error('No YouTube tab open');

  for (const tab of tabs) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, message);
      return result;
    } catch (e) {
      // This tab didn't respond, try next
    }
  }

  throw new Error('No YouTube tab responded');
}

// Returns a promise with the backup result for callers that need feedback
function performAutoBackup() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ autoBackup: true }, (settings) => {
      if (!settings.autoBackup) {
        resolve({ success: false, reason: 'disabled' });
        return;
      }

      sendToYouTubeTab({ type: 'EXPORT_DATA' })
        .then((data) => {
          if (!data || data.length === 0) {
            console.warn('[YT-Watched] Backup skipped: no data');
            resolve({ success: false, reason: 'no_data' });
            return;
          }

          const json = JSON.stringify(data, null, 2);
          // Use data URL instead of Blob URL (Blob URL not available in Service Worker)
          const base64 = btoa(unescape(encodeURIComponent(json)));
          const dataUrl = 'data:application/json;base64,' + base64;

          chrome.downloads.download({
            url: dataUrl,
            filename: BACKUP_FILENAME,
            conflictAction: 'overwrite',
            saveAs: false
          }, (downloadId) => {
            if (chrome.runtime.lastError) {
              console.error('[YT-Watched] Backup download failed:', chrome.runtime.lastError.message);
              resolve({ success: false, reason: 'download_error', error: chrome.runtime.lastError.message });
              return;
            }
            if (downloadId) {
              chrome.storage.local.set({
                lastBackup: Date.now(),
                lastBackupCount: data.length
              });
              console.log('[YT-Watched] Backup completed:', data.length, 'records');
              resolve({ success: true, count: data.length });
            }
          });
        })
        .catch((err) => {
          console.warn('[YT-Watched] Backup failed:', err.message);
          resolve({ success: false, reason: 'error', error: err.message });
        });
    });
  });
}

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATS') {
    sendToYouTubeTab({ type: 'GET_STATS' })
      .then(sendResponse)
      .catch(() => sendResponse({ count: 0 }));
    return true;
  }

  if (message.type === 'EXPORT_DATA') {
    sendToYouTubeTab({ type: 'EXPORT_DATA' })
      .then((data) => sendResponse(data || []))
      .catch(() => sendResponse([]));
    return true;
  }

  if (message.type === 'IMPORT_DATA') {
    sendToYouTubeTab({ type: 'IMPORT_DATA', data: message.data })
      .then(sendResponse)
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'DELETE_VIDEO') {
    sendToYouTubeTab({ type: 'DELETE_VIDEO', videoId: message.videoId })
      .then(sendResponse)
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'CLEAR_DATA') {
    sendToYouTubeTab({ type: 'CLEAR_DATA' })
      .then(sendResponse)
      .catch(() => sendResponse({ success: false }));
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
      // Include next backup schedule
      chrome.alarms.get(BACKUP_ALARM, (alarm) => {
        result.nextBackup = alarm ? alarm.scheduledTime : null;
        sendResponse(result);
      });
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
    performAutoBackup().then(sendResponse);
    return true;
  }
});
