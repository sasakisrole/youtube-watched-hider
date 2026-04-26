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

  if (message.type === 'SYNC_LIKED') {
    syncLikedPlaylist({ confirmAccountChange: !!message.confirmAccountChange })
      .then(sendResponse)
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'GET_LIKED') {
    sendToYouTubeTab({ type: 'GET_LIKED' })
      .then(sendResponse)
      .catch((e) => sendResponse({ success: false, error: e.message, rows: [] }));
    return true;
  }

  if (message.type === 'GET_LIKED_STATS') {
    sendToYouTubeTab({ type: 'GET_LIKED_STATS' })
      .then(sendResponse)
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'CLEAR_LIKED') {
    sendToYouTubeTab({ type: 'CLEAR_LIKED', accountId: message.accountId || '' })
      .then(sendResponse)
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'GET_LIKED_META') {
    chrome.storage.local.get({ likedSyncMeta: null }, (r) => {
      sendResponse({ success: true, meta: r.likedSyncMeta });
    });
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

// --- Liked playlist sync (LL = Liked Videos) ---
// Walks any ytInitialData / continuation response payload and pulls all
// playlistVideoRenderer items + the next continuation token if present.
function extractItemsAndContinuation(data) {
  const items = [];
  let continuation = '';
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }
    if (node.playlistVideoRenderer) {
      const r = node.playlistVideoRenderer;
      const videoId = r.videoId;
      if (videoId) {
        let title = '';
        if (r.title && r.title.runs && r.title.runs[0]) title = r.title.runs[0].text || '';
        else if (r.title && r.title.simpleText) title = r.title.simpleText;
        let channel = '';
        if (r.shortBylineText && r.shortBylineText.runs && r.shortBylineText.runs[0]) {
          channel = r.shortBylineText.runs[0].text || '';
        }
        const indexStr = (r.index && r.index.simpleText) || '';
        const playlistIndex = parseInt(indexStr, 10) || 0;
        items.push({ videoId, title, channel, playlistIndex });
      }
      return;
    }
    if (node.continuationItemRenderer) {
      const t = node.continuationItemRenderer.continuationEndpoint
        && node.continuationItemRenderer.continuationEndpoint.continuationCommand
        && node.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      if (t && !continuation) continuation = t;
      return;
    }
    for (const k in node) walk(node[k]);
  }
  walk(data);
  return { items, continuation };
}

// Extract the full INNERTUBE_CONTEXT object from HTML by balanced-matching braces
// starting at the key. The minimal {client:{clientName,clientVersion}} subset
// is rejected by some browse endpoints, so we forward the complete context.
function extractInnertubeContext(html) {
  const key = '"INNERTUBE_CONTEXT":';
  const i = html.indexOf(key);
  if (i === -1) return null;
  let p = i + key.length;
  while (p < html.length && html[p] !== '{') p++;
  if (html[p] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let j = p; j < html.length; j++) {
    const c = html[j];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === '\\') escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = html.slice(p, j + 1);
        try { return JSON.parse(slice); } catch (_) { return null; }
      }
    }
  }
  return null;
}

function extractYtcfg(html) {
  const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || '';
  const clientName = (html.match(/"INNERTUBE_CLIENT_NAME":"([^"]+)"/) || [])[1] || 'WEB';
  const clientVersion = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || '';
  const context = extractInnertubeContext(html);
  return { apiKey, clientName, clientVersion, context };
}

// Parses ytInitialData from the playlist HTML and extracts video items + owner identity.
function parseLikedPlaylistHtml(html) {
  const items = [];
  let ownerName = '';
  let ownerHandle = '';
  let ownerChannelId = '';
  let continuation = '';

  // Locate ytInitialData JSON (varies between "var ytInitialData = {...};" and "ytInitialData = {...};")
  const m = html.match(/(?:var\s+)?ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!m) return { items, ownerName, ownerHandle, ownerChannelId, continuation, error: 'no-ytInitialData' };

  let data;
  try { data = JSON.parse(m[1]); }
  catch (e) { return { items, ownerName, ownerHandle, ownerChannelId, continuation, error: 'parse-failed' }; }

  // Owner identity (best-effort across UI variants)
  try {
    const header = data.header || {};
    const ph = header.playlistHeaderRenderer || {};
    if (ph.ownerText && ph.ownerText.runs && ph.ownerText.runs[0]) {
      ownerName = ph.ownerText.runs[0].text || '';
      const ne = ph.ownerText.runs[0].navigationEndpoint;
      if (ne && ne.browseEndpoint) {
        ownerChannelId = ne.browseEndpoint.browseId || '';
        const u = ne.browseEndpoint.canonicalBaseUrl || '';
        if (u.startsWith('/@')) ownerHandle = u.slice(1);
      }
    }
    // Newer pageHeaderRenderer variant
    const phNew = (header.pageHeaderRenderer && header.pageHeaderRenderer.content
      && header.pageHeaderRenderer.content.pageHeaderViewModel) || null;
    if (!ownerName && phNew && phNew.metadata && phNew.metadata.contentMetadataViewModel) {
      const rows = phNew.metadata.contentMetadataViewModel.metadataRows || [];
      for (const row of rows) {
        const parts = (row.metadataParts || []);
        for (const p of parts) {
          const t = p.text && p.text.content;
          if (t && t.startsWith('@')) { ownerHandle = t; break; }
        }
      }
    }
  } catch (_) { /* tolerate structure changes */ }

  const ext = extractItemsAndContinuation(data);
  for (const it of ext.items) items.push({ ...it, playlistIndex: it.playlistIndex || items.length + 1 });
  continuation = ext.continuation;

  return { items, ownerName, ownerHandle, ownerChannelId, continuation };
}

async function syncLikedPlaylist({ confirmAccountChange, maxPages } = {}) {
  let resp;
  try {
    resp = await sendToYouTubeTab({ type: 'FETCH_PLAYLIST_HTML', listId: 'LL' });
  } catch (e) {
    return { success: false, reason: 'no-youtube-tab' };
  }
  if (!resp || !resp.success) {
    return { success: false, reason: (resp && resp.reason) || 'fetch-failed' };
  }
  const html = resp.html || '';
  const parsed = parseLikedPlaylistHtml(html);
  if (parsed.error) return { success: false, reason: parsed.error };
  if (!parsed.items.length) return { success: false, reason: 'no-items' };

  const ytcfg = extractYtcfg(html);
  const allItems = [...parsed.items];
  let continuation = parsed.continuation;
  const cap = typeof maxPages === 'number' ? maxPages : 50; // 50 pages × ~100 = up to 5000 items
  let page = 1;
  const errors = [];

  // Prefer the full INNERTUBE_CONTEXT extracted from HTML; fall back to a minimal one.
  const baseContext = ytcfg.context
    || { client: { clientName: ytcfg.clientName, clientVersion: ytcfg.clientVersion, hl: 'ja', gl: 'JP' } };

  while (continuation && page < cap) {
    page++;
    let contResp;
    try {
      contResp = await sendToYouTubeTab({
        type: 'FETCH_INNERTUBE_BROWSE',
        apiKey: ytcfg.apiKey,
        body: { context: baseContext, continuation },
      });
    } catch (e) {
      errors.push('page-' + page + ': ' + e.message);
      break;
    }
    if (!contResp || !contResp.success) {
      errors.push('page-' + page + ': ' + ((contResp && contResp.reason) || 'unknown'));
      break;
    }
    const ext = extractItemsAndContinuation(contResp.data);
    if (!ext.items.length) {
      // No items but maybe continuation came back — log and stop to avoid infinite loops.
      errors.push('page-' + page + ': empty-page');
      break;
    }
    for (const it of ext.items) {
      allItems.push({ ...it, playlistIndex: it.playlistIndex || allItems.length + 1 });
    }
    continuation = ext.continuation;
  }

  const accountId = parsed.ownerChannelId || parsed.ownerHandle || parsed.ownerName || 'unknown';

  // Account-change detection
  const meta = await new Promise((r) => chrome.storage.local.get({ likedSyncMeta: null }, (x) => r(x.likedSyncMeta)));
  if (meta && meta.accountId && meta.accountId !== accountId && !confirmAccountChange) {
    return {
      success: false,
      reason: 'account-changed',
      previous: meta,
      current: { accountId, ownerName: parsed.ownerName, ownerHandle: parsed.ownerHandle, ownerChannelId: parsed.ownerChannelId, count: allItems.length },
    };
  }

  // Approximate likedAt: assume newest-first ordering; assign decreasing offsets.
  const now = Date.now();
  const enriched = allItems.map((it, idx) => ({ ...it, likedAt: now - idx * 1000 }));

  const upsertResp = await sendToYouTubeTab({ type: 'UPSERT_LIKED', items: enriched, accountId });
  if (!upsertResp || !upsertResp.success) {
    return { success: false, reason: 'db-upsert-failed', error: upsertResp && upsertResp.error };
  }

  const newMeta = {
    accountId,
    ownerName: parsed.ownerName,
    ownerHandle: parsed.ownerHandle,
    ownerChannelId: parsed.ownerChannelId,
    lastSyncedAt: now,
    count: allItems.length,
  };
  await new Promise((r) => chrome.storage.local.set({ likedSyncMeta: newMeta }, r));

  return {
    success: true,
    fetched: allItems.length,
    added: upsertResp.added || 0,
    pages: page,
    errors,
    diagnostics: {
      initialContinuation: !!parsed.continuation,
      ytcfgApiKey: !!ytcfg.apiKey,
      ytcfgContext: !!ytcfg.context,
      clientVersion: ytcfg.clientVersion,
    },
    accountId,
    ownerName: parsed.ownerName,
    ownerHandle: parsed.ownerHandle,
    ownerChannelId: parsed.ownerChannelId,
  };
}

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
