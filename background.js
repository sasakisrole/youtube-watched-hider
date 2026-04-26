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

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'yt-queue',
      title: 'キューに追加',
      contexts: ['link'],
      documentUrlPatterns: ['*://*.youtube.com/*'],
      targetUrlPatterns: ['*://*.youtube.com/watch?*'],
    });
    chrome.contextMenus.create({
      id: 'yt-watch-later',
      title: '後で見る',
      contexts: ['link'],
      documentUrlPatterns: ['*://*.youtube.com/*'],
      targetUrlPatterns: ['*://*.youtube.com/watch?*'],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleDailyBackup();
  createContextMenus();
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

// Generate backup filename with date (e.g. yt-watched-backup-2026-04-03.json)
function getBackupFilename() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `yt-watched-backup-${yyyy}-${mm}-${dd}.json`;
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
            filename: getBackupFilename(),
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

// Context menu click handler
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const videoId = extractVideoId(info.linkUrl);
  if (!videoId) return;

  const type = info.menuItemId === 'yt-queue' ? 'QUEUE_VIDEO' : 'WATCH_LATER_VIDEO';
  chrome.tabs.sendMessage(tab.id, { type, videoId }).catch(() => {});
});

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

  if (message.type === 'MERGE_IMPORT') {
    sendToYouTubeTab({ type: 'MERGE_IMPORT', data: message.data })
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
      hideShorts: false,
      hideMovies: false,
      harvestMode: false,
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

  if (message.type === 'SET_HIDE_MOVIES') {
    chrome.storage.local.set({ hideMovies: message.hideMovies }, () => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'HIDE_MOVIES_CHANGED',
            hideMovies: message.hideMovies
          }).catch(() => {});
        }
      });
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'SET_HARVEST_MODE') {
    chrome.storage.local.set({ harvestMode: message.harvestMode }, () => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'HARVEST_MODE_CHANGED',
            harvestMode: message.harvestMode
          }).catch(() => {});
        }
      });
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'SET_HIDE_SHORTS') {
    chrome.storage.local.set({ hideShorts: message.hideShorts }, () => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'HIDE_SHORTS_CHANGED',
            hideShorts: message.hideShorts
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

  if (message.type === 'FIX_CHANNELS') {
    // message.videoIds: string[]
    // message.force: boolean (overwrite existing non-empty channel/title)
    fixChannelsBatch(message.videoIds || [], !!message.force)
      .then(sendResponse)
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
});

// --- oEmbed-based channel correction ---
// YouTube oEmbed endpoint returns {title, author_name, ...} with no auth.
// We throttle concurrency to avoid rate limiting.
async function fetchOEmbed(videoId) {
  try {
    // IMPORTANT: the `url` query parameter value must itself be URL-encoded,
    // otherwise YouTube oEmbed returns non-200 (typically 401/404).
    const target = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return { videoId, ok: false, status: res.status };
    const json = await res.json();
    return {
      videoId,
      ok: true,
      title: json.title || '',
      channel: json.author_name || ''
    };
  } catch (e) {
    return { videoId, ok: false, error: e.message };
  }
}

// Fallback: fetch the watch page HTML and extract metadata from
// ytInitialPlayerResponse. Works for videos where embedding is disabled
// (oEmbed returns 401/403 for those).
function decodeJsonStringLiteral(s) {
  try { return JSON.parse('"' + s + '"'); } catch { return s; }
}

async function fetchWatchPageMeta(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return { videoId, ok: false, status: res.status };
    const html = await res.text();

    // Try ytInitialPlayerResponse.videoDetails first (most reliable).
    // Look for: "title":"...","...":"...","author":"..."
    // Scoped within a videoDetails block.
    const vdStart = html.indexOf('"videoDetails":{');
    if (vdStart !== -1) {
      const slice = html.slice(vdStart, vdStart + 4000);
      const titleMatch = slice.match(/"title":"((?:\\.|[^"\\])*)"/);
      const authorMatch = slice.match(/"author":"((?:\\.|[^"\\])*)"/);
      const title = titleMatch ? decodeJsonStringLiteral(titleMatch[1]) : '';
      const channel = authorMatch ? decodeJsonStringLiteral(authorMatch[1]) : '';
      if (title || channel) {
        return { videoId, ok: true, title, channel };
      }
    }

    // Fallback: og:title meta tag (title only).
    const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
    if (ogTitle) {
      return { videoId, ok: true, title: ogTitle[1], channel: '' };
    }

    return { videoId, ok: false, status: 'no-metadata' };
  } catch (e) {
    return { videoId, ok: false, error: e.message };
  }
}

// Unified fetch: try oEmbed, fall back to watch page HTML on failure.
async function fetchVideoMeta(videoId) {
  const oe = await fetchOEmbed(videoId);
  if (oe.ok && (oe.title || oe.channel)) return oe;
  const wp = await fetchWatchPageMeta(videoId);
  if (wp.ok) return wp;
  console.warn('[YT-Watched] metadata fetch failed:', videoId,
    'oEmbed=', oe.status || oe.error, 'watchPage=', wp.status || wp.error);
  return { videoId, ok: false };
}

async function fixChannelsBatch(videoIds, force, onProgress) {
  if (!videoIds.length) return { success: true, updated: 0, failed: 0, total: 0 };

  const CONCURRENCY = 5;
  let updated = 0;
  let failed = 0;
  let processed = 0;
  let idx = 0;

  async function worker() {
    while (idx < videoIds.length) {
      const vid = videoIds[idx++];
      const result = await fetchVideoMeta(vid);
      let wasUpdated = false;
      if (!result.ok || (!result.title && !result.channel)) {
        failed++;
      } else {
        try {
          const resp = await sendToYouTubeTab({
            type: 'UPDATE_TITLE_CHANNEL',
            videoId: vid,
            title: result.title,
            channel: result.channel,
            force: force
          });
          if (resp && resp.success && resp.updated) {
            updated++;
            wasUpdated = true;
          }
        } catch (_e) {
          failed++;
        }
      }
      processed++;
      if (onProgress) {
        try {
          onProgress({
            videoId: vid,
            processed,
            updated,
            failed,
            total: videoIds.length,
            channel: result.channel || '',
            title: result.title || '',
            wasUpdated
          });
        } catch (_e) { /* ignore */ }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, videoIds.length); i++) workers.push(worker());
  await Promise.all(workers);

  return { success: true, updated, failed, total: videoIds.length };
}

// --- Topic credits (composer/lyricist/arranger) extraction ---
// Reads ytInitialPlayerResponse.videoDetails.shortDescription from the
// watch page HTML and parses the auto-generated Topic credit lines.
function cleanCreditLine(s) {
  if (!s) return '';
  let out = s;
  // Strip parenthesized URLs / Twitter handles: "(Twitter: https://...)", "(https://t.co/...)", "(twitter.com/...)"
  out = out.replace(/[\(（][^()（）]*(?:https?:\/\/|twitter\.com|x\.com|t\.co\/|Twitter\s*[:：])[^()（）]*[\)）]/gi, '');
  // Strip bare URLs that may remain
  out = out.replace(/https?:\/\/\S+/gi, '');
  // Collapse whitespace and trailing separator junk
  out = out.replace(/\s+/g, ' ').replace(/\s*([,、，\/／])\s*/g, '$1').replace(/[,、，\/／]+$/, '').trim();
  return out;
}

function parseCreditsFromDescription(desc) {
  if (!desc) return { composer: '', lyricist: '', arranger: '' };
  const pick = (labels) => {
    for (const label of labels) {
      const re = new RegExp('(?:^|\\n)\\s*' + label + '\\s*[:：]\\s*([^\\n]+)', 'i');
      const m = desc.match(re);
      if (m) return cleanCreditLine(m[1]);
    }
    return '';
  };
  return {
    composer: pick(['Composer', 'Composers', 'Composed by', 'Composition', 'Music', 'Music by', '作曲', '作曲者']),
    lyricist: pick(['Lyricist', 'Lyricists', 'Written by', 'Lyrics', 'Lyrics by', '作詞', '作詞者']),
    arranger: pick(['Arranger', 'Arrangers', 'Arranged by', 'Arrangement', '編曲', '編曲者']),
  };
}

async function fetchCreditsFromWatch(videoId) {
  try {
    // Route through a YouTube tab so the request carries user cookies and
    // avoids the google.com/sorry bot challenge.
    let resp;
    try {
      resp = await sendToYouTubeTab({ type: 'FETCH_WATCH_HTML', videoId });
    } catch (e) {
      return { videoId, ok: false, reason: 'no-youtube-tab' };
    }
    if (!resp || !resp.success) {
      return { videoId, ok: false, reason: (resp && resp.reason) || 'proxy-failed' };
    }
    const html = resp.html || '';

    // Consent/redirect pages lack ytInitialPlayerResponse entirely.
    if (html.indexOf('ytInitialPlayerResponse') === -1) {
      return { videoId, ok: false, reason: 'no-playerResponse' };
    }

    const vdStart = html.indexOf('"videoDetails":{');
    if (vdStart === -1) return { videoId, ok: false, reason: 'no-videoDetails' };
    const slice = html.slice(vdStart, vdStart + 100000);
    const descMatch = slice.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
    if (!descMatch) return { videoId, ok: false, reason: 'no-description' };
    const desc = decodeJsonStringLiteral(descMatch[1]);
    const credits = parseCreditsFromDescription(desc);
    const hasAny = credits.composer || credits.lyricist || credits.arranger;
    if (!hasAny) return { videoId, ok: true, credits, hasAny: false, reason: 'no-credits' };
    return { videoId, ok: true, credits, hasAny: true };
  } catch (e) {
    return { videoId, ok: false, reason: 'fetch-error', error: e.message };
  }
}

async function fixCreditsBatch(videoIds, sources, force, onProgress, abortSignal) {
  if (!videoIds.length) return { success: true, updated: 0, noCredits: 0, fetchFailed: 0, total: 0 };

  const CONCURRENCY = 3;
  let updated = 0;
  let noCredits = 0;
  let fetchFailed = 0;
  const failReasons = {};
  let processed = 0;
  let idx = 0;
  let autoStopped = false;

  async function worker() {
    while (idx < videoIds.length) {
      if (abortSignal && abortSignal.aborted) return;
      if (autoStopped) return;
      const vid = videoIds[idx++];
      const result = await fetchCreditsFromWatch(vid);
      let wasUpdated = false;
      if (!result.ok) {
        fetchFailed++;
        const r = result.reason || 'unknown';
        failReasons[r] = (failReasons[r] || 0) + 1;
        // Bot-challenge detected: stop the whole batch immediately to avoid
        // digging the rate-limit hole deeper.
        if (r === 'sorry-redirect') {
          autoStopped = true;
        }
      } else if (!result.hasAny) {
        noCredits++;
        // Stamp DB so next run can skip this videoId.
        try {
          await sendToYouTubeTab({ type: 'MARK_CREDITS_CHECKED', videoId: vid });
        } catch (_e) { /* ignore */ }
      } else {
        try {
          const resp = await sendToYouTubeTab({
            type: 'UPDATE_CREDITS',
            videoId: vid,
            credits: result.credits,
            creditsSource: (sources && sources[vid]) || '',
            force: force
          });
          if (resp && resp.success && resp.updated) {
            updated++;
            wasUpdated = true;
          }
        } catch (_e) {
          fetchFailed++;
          failReasons['db-error'] = (failReasons['db-error'] || 0) + 1;
        }
      }
      processed++;
      if (onProgress) {
        try {
          onProgress({
            videoId: vid,
            processed,
            updated,
            noCredits,
            fetchFailed,
            failReasons,
            total: videoIds.length,
            credits: result.credits || null,
            wasUpdated
          });
        } catch (_e) { /* ignore */ }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, videoIds.length); i++) workers.push(worker());
  await Promise.all(workers);

  const aborted = !!(abortSignal && abortSignal.aborted);
  return { success: true, updated, noCredits, fetchFailed, failReasons, total: videoIds.length, processed, aborted, autoStopped };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fix-credits') return;

  const abortSignal = { aborted: false };
  port.onDisconnect.addListener(() => { abortSignal.aborted = true; });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'ABORT') {
      abortSignal.aborted = true;
      return;
    }
    if (msg.type !== 'START') return;
    const videoIds = msg.videoIds || [];
    const sources = msg.sources || {};
    const force = !!msg.force;
    try {
      const result = await fixCreditsBatch(videoIds, sources, force, (progress) => {
        try { port.postMessage({ type: 'PROGRESS', ...progress }); } catch (_e) {}
      }, abortSignal);
      try { port.postMessage({ type: 'DONE', ...result }); } catch (_e) {}
    } catch (e) {
      try { port.postMessage({ type: 'ERROR', error: e.message }); } catch (_e) {}
    }
    try { port.disconnect(); } catch (_e) {}
  });
});

// Streaming variant via chrome.runtime.Port — emits progress events.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fix-channels') return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== 'START') return;
    const videoIds = msg.videoIds || [];
    const force = !!msg.force;

    try {
      const result = await fixChannelsBatch(videoIds, force, (progress) => {
        try { port.postMessage({ type: 'PROGRESS', ...progress }); } catch (_e) {}
      });
      try { port.postMessage({ type: 'DONE', ...result }); } catch (_e) {}
    } catch (e) {
      try { port.postMessage({ type: 'ERROR', error: e.message }); } catch (_e) {}
    }
    try { port.disconnect(); } catch (_e) {}
  });
});
