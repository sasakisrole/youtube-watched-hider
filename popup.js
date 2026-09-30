// Static popup localization: keep the HTML fallback when a key is unavailable.
function applyStaticPopupI18n() {
  if (typeof chrome === 'undefined' || !chrome.i18n?.getMessage) return;
  for (const target of ['', 'placeholder', 'title', 'aria-label']) {
    const attribute = target ? 'data-i18n-' + target : 'data-i18n';
    for (const element of document.querySelectorAll('[' + attribute + ']')) {
      const message = chrome.i18n.getMessage(element.getAttribute(attribute));
      if (!message) continue;
      if (target) element.setAttribute(target, message);
      else element.textContent = element.textContent.replace(/\S(?:[\s\S]*\S)?/, () => message);
    }
  }
}
applyStaticPopupI18n();
// End static popup localization

// Dynamic popup localization: values stay separate from translated grammar.
function popupMessage(key, fallback, substitutions = []) {
  if (typeof chrome === 'undefined' || !chrome.i18n?.getMessage) return fallback;
  return chrome.i18n.getMessage(key, substitutions.map(String)) || fallback;
}

function popupUILanguage() {
  return typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage
    ? chrome.i18n.getUILanguage() : 'ja';
}

function popupBackupDate(timestamp, padHour = false) {
  const locale = popupUILanguage();
  const options = { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const formatter = new Intl.DateTimeFormat(locale, options);
  if (!/^ja(?:-|$)/i.test(locale)) return formatter.format(new Date(timestamp));
  // Preserve the existing Japanese compact layout, including next-backup padding.
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(p => [p.type, p.value]));
  return `${parts.month}/${parts.day} ${padHour ? parts.hour.padStart(2, '0') : parts.hour}:${parts.minute}`;
}

// Popup script for YouTube Watched Hider

const countEl = document.getElementById('count');
const dbStatusEl = document.getElementById('dbStatus');
const enableToggle = document.getElementById('enableToggle');
const toggleLabel = document.getElementById('toggleLabel');
const importBtn = document.getElementById('importBtn');
const clearWatchedBtn = document.getElementById('clearWatchedBtn');
const clearLikedBtn = document.getElementById('clearLikedBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const fileInput = document.getElementById('fileInput');
// u1ps §7.3: import-mode chooser
const importModePanel = document.getElementById('importModePanel');
const importDiffSummary = document.getElementById('importDiffSummary');
const importReplaceBtn = document.getElementById('importReplaceBtn');
const importSafeMergeBtn = document.getElementById('importSafeMergeBtn');
const importBackupMergeBtn = document.getElementById('importBackupMergeBtn');
const importCancelBtn = document.getElementById('importCancelBtn');
let pendingImportData = null;
let pendingImportDiff = null;
let importGeneration = 0; // u1ps §7.3 (Codex B2 minor 1): ignore stale IMPORT_DIFF replies
const statusEl = document.getElementById('status');
const historyBtn = document.getElementById('historyBtn');
const historyPanel = document.getElementById('historyPanel');
const historyList = document.getElementById('historyList');
const historySearch = document.getElementById('historySearch');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const recordWhileOffToggle = document.getElementById('recordWhileOffToggle');
const autoBackupToggle = document.getElementById('autoBackupToggle');
const backupNowBtn = document.getElementById('backupNowBtn');
const lastBackupInfo = document.getElementById('lastBackupInfo');
const viewerBtn = document.getElementById('viewerBtn');
const whatsnewBtn = document.getElementById('whatsnewBtn');
const aboutBtn = document.getElementById('aboutBtn');
const aboutPanel = document.getElementById('aboutPanel');
const nextBackupInfo = document.getElementById('nextBackupInfo');
const hideShortsToggle = document.getElementById('hideShortsToggle');
const hideMoviesToggle = document.getElementById('hideMoviesToggle');
const harvestModeToggle = document.getElementById('harvestModeToggle');
const syncImportBtn = document.getElementById('syncImportBtn');
const syncFileInput = document.getElementById('syncFileInput');
const syncStatus = document.getElementById('syncStatus');
const migrationBanner = document.getElementById('migrationBanner');
const cacheModeBadge = document.getElementById('cacheModeBadge');
const cacheDetail = document.getElementById('cacheDetail');

let allHistoryData = [];
let filteredHistoryData = [];
let historyRenderedCount = 0;
let lastHistoryDateGroup = '';
const HISTORY_PAGE_SIZE = 50;

function showStatus(msg, isError = false, isWarn = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? 'var(--danger)' : (isWarn ? 'var(--warning)' : 'var(--success)');
  // Keep warnings/errors on screen longer so a "N件スキップ" notice is readable.
  setTimeout(() => { statusEl.textContent = ''; }, (isError || isWarn) ? 5000 : 3000);
}

function renderCacheStats(response) {
  const mode = response && response.cacheMode ? response.cacheMode : 'error';
  const positive = response && typeof response.positiveCacheSize === 'number' ? response.positiveCacheSize : 0;
  const recent = response && typeof response.recentCacheSize === 'number' ? response.recentCacheSize : 0;
  const pages = response && typeof response.cacheLoadedPages === 'number' ? response.cacheLoadedPages : 0;
  const loadMs = response && typeof response.cacheLoadTime === 'number' ? response.cacheLoadTime : 0;

  if (cacheModeBadge) {
    cacheModeBadge.textContent = mode;
    cacheModeBadge.className = `cache-mode-badge cache-${mode}`;
  }
  if (cacheDetail) {
    cacheDetail.textContent = response && response.cacheUnavailable
      ? popupMessage('popupDynamicCacheUnavailable', 'YouTubeタブ未接続。DB件数は表示中、content cacheは次回YouTube表示時に取得します。')
      : popupMessage('popupDynamicCacheDetail', `positive ${positive.toLocaleString(popupUILanguage())} / recent ${recent.toLocaleString(popupUILanguage())} / pages ${pages.toLocaleString(popupUILanguage())} / load ${loadMs.toLocaleString(popupUILanguage())}ms`, [positive.toLocaleString(popupUILanguage()), recent.toLocaleString(popupUILanguage()), pages.toLocaleString(popupUILanguage()), loadMs.toLocaleString(popupUILanguage())]);
  }
  return { mode, positive, recent, pages, loadMs };
}

function unwrapWatchedRecords(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && data.schemaVersion === 2 && Array.isArray(data.watchedVideos)) return data.watchedVideos;
  if (data && typeof data === 'object' && Array.isArray(data.records)) return data.records;
  return null;
}

function getExportRecords(data) {
  if (data && data.__error) {
    showStatus(popupMessage('popupDynamicDbReadFailed', `DBの読み取りに失敗しました: ${(data.message || popupMessage('popupDynamicUnknownError', '原因不明'))}`, [(data.message || popupMessage('popupDynamicUnknownError', '原因不明'))]), true);
    return null;
  }
  return unwrapWatchedRecords(data) || [];
}

// Format date
function formatDate(timestamp) {
  const d = new Date(timestamp);
  if (!/^ja(?:-|$)/i.test(popupUILanguage())) {
    return new Intl.DateTimeFormat(popupUILanguage(), { month: '2-digit', day: '2-digit' }).format(d);
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}`;
}

// Load stats with retry (content script may not be ready yet)
function loadStats(retries = 3) {
  countEl.textContent = '...';
  countEl.title = '';
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
    if (chrome.runtime.lastError) {
      countEl.textContent = '--';
      countEl.title = popupMessage('popupDynamicWorkerUnavailable', 'サービスワーカーに接続できません');
      showStatus(popupMessage('popupDynamicInternalError', `拡張の内部エラー: ${chrome.runtime.lastError.message}`, [chrome.runtime.lastError.message]), true);
      return;
    }
    if (response && typeof response.count === 'number') {
      countEl.textContent = response.count.toLocaleString(popupUILanguage());
      countEl.title = '';
      const cache = renderCacheStats(response);
      if (response.dbStatus) {
        const statusMap = {
          ready: response.dbOwner === 'offscreen'
            ? popupMessage('popupDynamicDbReadyOffscreen', `DB 正常（offscreen・キャッシュ ${cache.positive.toLocaleString(popupUILanguage())}件・${cache.mode}）`, [cache.positive.toLocaleString(popupUILanguage()), cache.mode])
            : popupMessage('popupDynamicDbReady', `DB 正常（キャッシュ ${cache.positive.toLocaleString(popupUILanguage())}件・${cache.loadMs}ms）`, [cache.positive.toLocaleString(popupUILanguage()), cache.loadMs]),
          loading: popupMessage('popupDynamicDbLoading', 'DB 読み込み中...'),
          error: popupMessage('popupDynamicDbError', 'DB エラー'),
        };
        dbStatusEl.textContent = statusMap[response.dbStatus] || response.dbStatus;
        dbStatusEl.className = 'db-status ' + response.dbStatus;
      }
    } else if (retries > 0) {
      countEl.title = popupMessage('popupDynamicConnecting', `接続中... (${retries})`, [retries]);
      setTimeout(() => loadStats(retries - 1), 1000);
    } else {
      countEl.textContent = '--';
      countEl.title = popupMessage('popupDynamicTabUnavailable', 'YouTubeタブから応答がありません');
      showStatus(popupMessage('popupDynamicReloadTab', 'YouTubeタブを開いてリロードしてください'), true);
    }
  });
}

// Format date for group headers (YYYY/MM/DD with day of week)
function formatDateGroup(timestamp) {
  const d = new Date(timestamp);
  if (!/^ja(?:-|$)/i.test(popupUILanguage())) {
    return new Intl.DateTimeFormat(popupUILanguage(), { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).format(d);
  }
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} (${days[d.getDay()]})`;
}

// Format time (HH:MM)
function formatTime(timestamp) {
  const d = new Date(timestamp);
  if (!/^ja(?:-|$)/i.test(popupUILanguage())) {
    return new Intl.DateTimeFormat(popupUILanguage(), { hour: '2-digit', minute: '2-digit' }).format(d);
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Delete a video from history
function deleteHistoryVideo(videoId, rowEl) {
  chrome.runtime.sendMessage({ type: 'DELETE_VIDEO', videoId }, (res) => {
    if (res && res.success) {
      allHistoryData = allHistoryData.filter(v => v.videoId !== videoId);
      filteredHistoryData = filteredHistoryData.filter(v => v.videoId !== videoId);
      rowEl.style.transition = 'opacity 0.2s';
      rowEl.style.opacity = '0';
      setTimeout(() => rowEl.remove(), 200);
      loadStats();
    }
  });
}

// Build a single history item element
function buildHistoryItem(video) {
  const row = document.createElement('div');
  row.className = 'history-item';

  const a = document.createElement('a');
  a.className = 'history-link';
  a.href = `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
  a.target = '_blank';
  a.rel = 'noopener';

  if (video.source === 'seekbar' || video.source === 'history') {
    const badge = document.createElement('span');
    badge.className = 'source-badge';
    badge.textContent = 'YT';
    badge.title = video.source === 'seekbar'
      ? popupMessage('popupDynamicSourceSeekbar', 'YouTubeのシークバーから検出')
      : popupMessage('popupDynamicSourceHistory', 'YouTubeの履歴ページから取り込み');
    a.appendChild(badge);
  }

  const count = video.playCount || 1;
  if (count > 1) {
    const countBadge = document.createElement('span');
    countBadge.className = 'play-count-badge';
    countBadge.textContent = `${count}x`;
    countBadge.title = popupMessage('popupDynamicPlayCount', `${count}回再生`, [count]);
    a.appendChild(countBadge);
  }

  const textWrap = document.createElement('div');
  textWrap.className = 'history-text';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = video.title || video.videoId;
  textWrap.appendChild(title);

  if (video.channel) {
    const channel = document.createElement('span');
    channel.className = 'channel';
    channel.textContent = video.channel;
    textWrap.appendChild(channel);
  }

  a.appendChild(textWrap);

  const time = document.createElement('span');
  time.className = 'meta';
  time.textContent = formatTime(video.watchedAt);
  a.appendChild(time);

  row.appendChild(a);

  const delBtn = document.createElement('button');
  delBtn.className = 'history-delete-btn';
  delBtn.textContent = '\u00d7';
  delBtn.title = popupMessage('popupDynamicDeleteVideo', 'この動画を履歴から削除');
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteHistoryVideo(video.videoId, row);
  });
  row.appendChild(delBtn);

  return row;
}

// Render next batch of history items (incremental)
function renderHistoryBatch() {
  if (historyRenderedCount >= filteredHistoryData.length) return;

  const end = Math.min(historyRenderedCount + HISTORY_PAGE_SIZE, filteredHistoryData.length);
  const fragment = document.createDocumentFragment();

  for (let i = historyRenderedCount; i < end; i++) {
    const video = filteredHistoryData[i];
    const dateGroup = formatDateGroup(video.watchedAt);
    if (dateGroup !== lastHistoryDateGroup) {
      lastHistoryDateGroup = dateGroup;
      const header = document.createElement('div');
      header.className = 'history-date-header';
      header.textContent = dateGroup;
      fragment.appendChild(header);
    }
    fragment.appendChild(buildHistoryItem(video));
  }

  historyList.appendChild(fragment);
  historyRenderedCount = end;
}

// Render history list (reset + first batch)
function renderHistory(filter = '') {
  historyList.textContent = '';
  historyRenderedCount = 0;
  lastHistoryDateGroup = '';

  const lowerFilter = filter.toLowerCase();
  filteredHistoryData = filter
    ? allHistoryData.filter(v =>
        (v.title || v.videoId).toLowerCase().includes(lowerFilter) ||
        (v.channel || '').toLowerCase().includes(lowerFilter))
    : allHistoryData;

  if (filteredHistoryData.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = filter
      ? popupMessage('popupDynamicNoMatches', '該当する動画はありません。検索語を短くしてみてください。')
      : popupMessage('popupDynamicNoHistory', 'まだ記録がありません。YouTubeで動画を再生すると記録されます。');
    historyList.appendChild(empty);
    return;
  }

  renderHistoryBatch();
}

// Load and show history
function loadHistory() {
  chrome.runtime.sendMessage({ type: 'EXPORT_DATA' }, (data) => {
    const records = getExportRecords(data);
    if (!records) {
      allHistoryData = [];
    } else if (records.length === 0) {
      allHistoryData = [];
    } else {
      // Sort by most recent first
      allHistoryData = records.sort((a, b) => b.watchedAt - a.watchedAt);
    }
    renderHistory(historySearch.value);
  });
}

// Watched display settings use the same local storage and tab message pattern.
const watchedThresholdInput = document.getElementById('watchedThreshold');
const watchedDisplayDefaults = {
  playlistCardMode: 'never',
  playlistCardPlaces: null,
  watchedThreshold: 95, dimWatched: false, hideOnHome: true, hideOnSubscriptions: true, hideOnChannel: true, hideOnPlaylist: true,
  hideOnSearch: true, hideOnRelated: true, showSearchFilter: true,
};
const pageToggleKeys = ['hideOnHome', 'hideOnSubscriptions', 'hideOnChannel', 'hideOnPlaylist', 'hideOnSearch', 'hideOnRelated', 'showSearchFilter'];
function normalizePlaylistCardMode(value) {
  return ['hide', 'search_related', 'everywhere'].includes(value) ? 'hide' : 'never';
}
const playlistCardPlaceDefaults = { home: true, search: true, related: true, subscriptions: false, channel: false, playlists: false };
let playlistCardPlaces = { ...playlistCardPlaceDefaults };
function normalizePlaylistCardPlaces(settings) {
  const places = settings.playlistCardPlaces;
  const valid = places && typeof places === 'object' && !Array.isArray(places) &&
    Object.keys(playlistCardPlaceDefaults).every(key => typeof places[key] === 'boolean');
  return Object.fromEntries(Object.entries(playlistCardPlaceDefaults).map(([key, value]) =>
    [key, valid ? places[key] : settings.playlistCardMode === 'everywhere' || value]));
}
function normalizeWatchedThreshold(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100 ? value : 95;
}
chrome.storage.local.get(watchedDisplayDefaults, (settings) => {
  watchedThresholdInput.value = normalizeWatchedThreshold(settings.watchedThreshold);
  document.getElementById('dimWatched').checked = settings.dimWatched === true;
  const mode = normalizePlaylistCardMode(settings.playlistCardMode);
  document.getElementById('playlistCardMode').value = mode;
  document.getElementById('playlistCardPlaces').hidden = mode !== 'hide';
  playlistCardPlaces = normalizePlaylistCardPlaces(settings);
  for (const key of Object.keys(playlistCardPlaceDefaults)) {
    document.getElementById(`playlistCardPlace_${key}`).checked = playlistCardPlaces[key];
  }
  for (const key of pageToggleKeys) document.getElementById(key).checked = settings[key] !== false;
});
function saveWatchedDisplaySetting(key, value, extra = {}) {
  chrome.storage.local.set({ ...extra, [key]: value }, () => {
    if (chrome.runtime.lastError) {
      showStatus(popupMessage('popupDynamicSettingsFailed', '設定を保存できませんでした'), true);
      return;
    }
    // Read the latest complete snapshot to avoid overwriting another popup's settings.
    chrome.storage.local.get(watchedDisplayDefaults, (settings) => {
      chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'WATCHED_DISPLAY_SETTINGS_CHANGED', settings }).catch(() => {});
        }
      });
    });
  });
}
watchedThresholdInput.addEventListener('change', () => {
  const value = normalizeWatchedThreshold(watchedThresholdInput.valueAsNumber);
  watchedThresholdInput.value = value;
  saveWatchedDisplaySetting('watchedThreshold', value);
});
document.getElementById('dimWatched').addEventListener('change', (event) => {
  saveWatchedDisplaySetting('dimWatched', event.target.checked);
});
document.getElementById('playlistCardMode').addEventListener('change', (event) => {
  const value = normalizePlaylistCardMode(event.target.value);
  event.target.value = value;
  document.getElementById('playlistCardPlaces').hidden = value !== 'hide';
  // Save the migrated places before replacing a legacy mode that supplies their defaults.
  saveWatchedDisplaySetting('playlistCardMode', value, { playlistCardPlaces: { ...playlistCardPlaces } });
});
for (const key of Object.keys(playlistCardPlaceDefaults)) {
  document.getElementById(`playlistCardPlace_${key}`).addEventListener('change', (event) => {
    playlistCardPlaces = { ...playlistCardPlaces, [key]: event.target.checked };
    saveWatchedDisplaySetting('playlistCardPlaces', playlistCardPlaces);
  });
}
for (const key of pageToggleKeys) {
  document.getElementById(key).addEventListener('change', (event) => {
    saveWatchedDisplaySetting(key, event.target.checked);
  });
}

// Load settings
chrome.runtime.sendMessage({ type: 'GET_ENABLED' }, (response) => {
  if (response) {
    enableToggle.checked = response.enabled;
    toggleLabel.textContent = response.enabled ? 'ON' : 'OFF';
    recordWhileOffToggle.checked = response.recordWhileOff || false;
    hideShortsToggle.checked = response.hideShorts || false;
    hideMoviesToggle.checked = response.hideMovies || false;
    harvestModeToggle.checked = response.harvestMode || false;
    autoBackupToggle.checked = response.autoBackup !== false;
    lastBackupInfo.className = 'backup-status';
    if (response.lastBackup) {
      const dateStr = popupBackupDate(response.lastBackup);
      lastBackupInfo.textContent = popupMessage('popupDynamicLastBackup', `（最終 ${dateStr}・${response.lastBackupCount}件）`, [dateStr, response.lastBackupCount]);
    } else {
      lastBackupInfo.textContent = '';
    }
    if (response.lastBackupError) {
      const prefix = lastBackupInfo.textContent ? `${lastBackupInfo.textContent} ` : ' ';
      lastBackupInfo.className = 'backup-status backup-error';
      lastBackupInfo.textContent = popupMessage('popupDynamicLastBackupError', `${prefix}前回のエラー: ${response.lastBackupError}`, [prefix, response.lastBackupError]);
    }
    if (response.nextBackup) {
      nextBackupInfo.textContent = popupMessage('popupDynamicNextBackup', `次回 ${popupBackupDate(response.nextBackup, true)}`, [popupBackupDate(response.nextBackup, true)]);
    }
    if (migrationBanner) {
      migrationBanner.style.display = response.migrationV135Done === false ? 'block' : 'none';
    }
  }
});

// Toggle
enableToggle.addEventListener('change', () => {
  const enabled = enableToggle.checked;
  toggleLabel.textContent = enabled ? 'ON' : 'OFF';
  chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled });
});

// History toggle
historyBtn.addEventListener('click', () => {
  const visible = historyPanel.style.display !== 'none';
  if (visible) {
    historyPanel.style.display = 'none';
  } else {
    historyPanel.style.display = 'block';
    loadHistory();
  }
  historyBtn.setAttribute('aria-expanded', String(!visible));
});

// History scroll: load more when near bottom
historyList.addEventListener('scroll', () => {
  if (historyRenderedCount >= filteredHistoryData.length) return;
  if (historyList.scrollTop + historyList.clientHeight >= historyList.scrollHeight - 100) {
    renderHistoryBatch();
  }
});

// History search (debounced)
let historySearchTimer;
historySearch.addEventListener('input', () => {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => renderHistory(historySearch.value), 250);
});

// Open viewer in new tab
viewerBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
});

// Open the usage guide + release notes page
whatsnewBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('whatsnew.html') });
});

// Import
importBtn.addEventListener('click', () => {
  fileInput.click();
});

// Unwrap import data: accept v2 envelope, v1 envelope, and legacy raw array.
function unwrapImportData(parsed) {
  return unwrapWatchedRecords(parsed);
}

// u1ps §7.3: after a file is picked, compute a read-only diff and let the user
// explicitly choose replace vs merge (instead of the old implicit put-overwrite).
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // Claim a generation at SELECTION time so the last-picked file wins even if an
  // earlier file's read/diff completes later (Codex B2 minor 1).
  const myGen = ++importGeneration;
  const reader = new FileReader();
  reader.onload = (event) => {
    if (myGen !== importGeneration) return; // a newer file was picked while reading
    let parsed;
    try {
      parsed = JSON.parse(event.target.result);
    } catch {
      showStatus(popupMessage('popupDynamicJsonRetry', 'JSONを読み取れませんでした。バックアップファイルを選び直してください'), true);
      return;
    }
    if (!unwrapImportData(parsed)) {
      showStatus(popupMessage('popupDynamicInvalidBackup', 'このファイルはバックアップの形式ではありません'), true);
      return;
    }
    pendingImportData = parsed;
    pendingImportDiff = null;
    showStatus(popupMessage('popupDynamicDiffLoading', '差分を計算中...'));
    chrome.runtime.sendMessage({ type: 'IMPORT_DIFF', data: parsed }, (response) => {
      if (myGen !== importGeneration) return; // a newer file was picked; ignore stale reply
      if (response && response.success && response.diff) {
        pendingImportDiff = response.diff;
        importDiffSummary.textContent = renderImportDiff(response.diff);
        importModePanel.style.display = 'block';
        statusEl.textContent = '';
      } else {
        pendingImportData = null;
        showStatus(popupMessage('popupDynamicDiffFailed', `差分の計算に失敗しました: ${((response && response.error) || 'unknown')}`, [((response && response.error) || 'unknown')]), true);
      }
    });
  };
  reader.readAsText(file);
  fileInput.value = '';
});

function renderImportDiff(diff) {
  // These pure formatters also support standalone use without the popup runtime.
  const message = typeof popupMessage === 'function' ? popupMessage : (_key, fallback) => fallback;
  const w = diff.watched || {};
  const l = diff.liked || {};
  const inv = diff.invalid || {};
  const invN = (inv.watched || 0) + (inv.liked || 0);
  const lines = [
    message('popupDynamicDiffWatched', `視聴履歴: 追加 ${w.add || 0} / 更新 ${w.overlap || 0}（置換すると ${w.currentOnly || 0} 件削除）`, [w.add || 0, w.overlap || 0, w.currentOnly || 0]),
    message('popupDynamicDiffLiked', `高評価: 追加 ${l.add || 0} / 更新 ${l.overlap || 0}（置換すると ${l.currentOnly || 0} 件削除）`, [l.add || 0, l.overlap || 0, l.currentOnly || 0]),
  ];
  if (invN) lines.push(message('popupDynamicInvalidSkipped', `無効データ: ${invN} 件スキップ`, [invN]));
  if (inv.likedStructural) lines.push(message('popupDynamicLikedStructureWarning', '※ 高評価データの形式が不正なためスキップされます'));
  if (inv.likedMetaStructural) lines.push(message('popupDynamicLikedMetaWarning', '※ 高評価の同期アカウント情報の形式が不正なためスキップされます（再同期で復元できます）'));
  return lines.join('\n');
}

function formatImportResult(response, label) {
  // These pure formatters also support standalone use without the popup runtime.
  const message = typeof popupMessage === 'function' ? popupMessage : (_key, fallback) => fallback;
  const likedFailed = !!(response.liked && response.liked.failed);
  const liked = likedFailed
    ? message('popupDynamicLikedRestoreFailed', ' / 高評価の復元に失敗')
    : (response.liked && typeof response.liked.imported === 'number' ? message('popupDynamicLikedImported', ` / ${response.liked.imported} liked`, [response.liked.imported]) : '');
  const droppedN = response.dropped ? ((response.dropped.watched || 0) + (response.dropped.liked || 0)) : 0;
  const structural = !!(response.dropped && response.dropped.likedStructural);
  const metaStructural = !!(response.dropped && response.dropped.likedMetaStructural);
  const removed = response.removed ? message('popupDynamicRemoved', `, ${(response.removed.watched || 0) + (response.removed.liked || 0)}件削除`, [(response.removed.watched || 0) + (response.removed.liked || 0)]) : '';
  const notes = [];
  if (droppedN) notes.push(message('popupDynamicSkipped', `${droppedN}件スキップ`, [droppedN]));
  if (structural) notes.push(message('popupDynamicLikedInvalid', '高評価データ形式不正'));
  if (metaStructural) notes.push(message('popupDynamicLikedAccountInvalid', '高評価アカウント情報の形式不正'));
  const note = notes.length ? message('popupDynamicNotes', `（${notes.join(' / ')}）`, [notes.join(' / ')]) : '';
  const resultLabel = likedFailed ? message('popupDynamicPartial', `${label}（一部成功）`, [label]) : label;
  return {
    text: message('popupDynamicImportResult', `${resultLabel}: ${response.count}件${liked}${removed}${note}`, [resultLabel, response.count, liked, removed, note]),
    warning: likedFailed || droppedN > 0 || structural || metaStructural,
  };
}

function formatMergeImportStatus(response) {
  // These pure formatters also support standalone use without the popup runtime.
  const message = typeof popupMessage === 'function' ? popupMessage : (_key, fallback) => fallback;
  const likedFailed = !!(response.liked && response.liked.failed);
  const liked = likedFailed
    ? message('popupDynamicMergeLikedFailed', ', 高評価の復元に失敗')
    : (response.liked && typeof response.liked.imported === 'number' ? message('popupDynamicMergeLikedImported', `, ${response.liked.imported} liked`, [response.liked.imported]) : '');
  const droppedN = response.dropped ? ((response.dropped.watched || 0) + (response.dropped.liked || 0)) : 0;
  const structural = !!(response.dropped && response.dropped.likedStructural);
  const metaStructural = !!(response.dropped && response.dropped.likedMetaStructural);
  const droppedNotes = [];
  if (droppedN) droppedNotes.push(message('popupDynamicSkipped', `${droppedN}件スキップ`, [droppedN]));
  if (structural) droppedNotes.push(message('popupDynamicMergeLikedInvalid', '高評価データの形式が不正'));
  if (metaStructural) droppedNotes.push(message('popupDynamicMergeLikedAccountInvalid', '高評価アカウント情報の形式が不正'));
  const droppedNote = droppedNotes.length ? message('popupDynamicNotes', `（${droppedNotes.join(' / ')}）`, [droppedNotes.join(' / ')]) : '';
  const prefix = likedFailed ? message('popupDynamicMergePartial', '一部成功: 視聴履歴') : message('popupDynamicMergeDone', '統合しました:');
  return {
    text: message('popupDynamicMergeResult', `${prefix} 新規 ${response.added}件 / 既存 ${response.skipped}件${liked}${droppedNote}`, [prefix, response.added, response.skipped, liked, droppedNote]),
    warning: likedFailed || droppedN > 0 || structural || metaStructural,
  };
}

function handleImportResponse(response, label) {
  if (response && response.success) {
    const result = formatImportResult(response, label);
    showStatus(result.text, false, result.warning);
    loadStats();
    if (historyPanel.style.display !== 'none') loadHistory();
  } else if (response && response.reason === 'backup_failed') {
    // Data-safety gate: nothing was changed because the pre-replace backup failed.
    showStatus(popupMessage('popupDynamicBackupAbortImport', 'バックアップに失敗したため中止しました（データは変更していません）'), true);
  } else {
    showStatus(popupMessage('popupDynamicImportFailed', `${label}に失敗しました: ${((response && response.error) || popupMessage('popupDynamicUnknownError', '原因不明'))}`, [label, ((response && response.error) || popupMessage('popupDynamicUnknownError', '原因不明'))]), true);
  }
}

function closeImportPanel() {
  importModePanel.style.display = 'none';
  importGeneration++; // invalidate any in-flight IMPORT_DIFF reply
  const data = pendingImportData;
  pendingImportData = null;
  pendingImportDiff = null;
  return data;
}

importSafeMergeBtn.addEventListener('click', () => {
  const data = closeImportPanel();
  if (!data) return;
  showStatus(popupMessage('popupDynamicMerging', '統合中...'));
  chrome.runtime.sendMessage({ type: 'MERGE_IMPORT', data }, (r) => handleImportResponse(r, popupMessage('popupDynamicSafeMerge', '安全に統合')));
});

importBackupMergeBtn.addEventListener('click', () => {
  const data = closeImportPanel();
  if (!data) return;
  showStatus(popupMessage('popupDynamicMerging', '統合中...'));
  chrome.runtime.sendMessage({ type: 'IMPORT_DATA', data }, (r) => handleImportResponse(r, popupMessage('popupDynamicBackupMerge', 'バックアップ優先で統合')));
});

importReplaceBtn.addEventListener('click', () => {
  const diff = pendingImportDiff;
  const delW = diff && diff.watched ? diff.watched.currentOnly : 0;
  const delL = diff && diff.liked ? diff.liked.currentOnly : 0;
  if (!confirm(popupMessage('popupDynamicConfirmReplace', `置換します。現在のデータを自動バックアップ（1件ダウンロード）してから、このファイルの内容に置き換えます。\n\nこのファイルに無い 視聴履歴 ${delW} 件・高評価 ${delL} 件が削除されます。続けますか？`, [delW, delL]))) return;
  const data = closeImportPanel();
  if (!data) return;
  const btns = [importReplaceBtn, importSafeMergeBtn, importBackupMergeBtn, importBtn];
  btns.forEach((b) => { b.disabled = true; });
  showStatus(popupMessage('popupDynamicBackingUp', 'バックアップ中...'));
  chrome.runtime.sendMessage({ type: 'REPLACE_IMPORT', data }, (r) => {
    btns.forEach((b) => { b.disabled = false; });
    handleImportResponse(r, popupMessage('popupDynamicReplace', '置換'));
  });
});

importCancelBtn.addEventListener('click', () => {
  closeImportPanel();
  showStatus(popupMessage('popupDynamicRestoreCancelled', '復元をキャンセルしました'));
});

// Settings toggle
settingsBtn.addEventListener('click', () => {
  const visible = settingsPanel.style.display !== 'none';
  settingsPanel.style.display = visible ? 'none' : 'flex';
  settingsBtn.setAttribute('aria-expanded', String(!visible));
});

// Hide Shorts toggle
hideShortsToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({
    type: 'SET_HIDE_SHORTS',
    hideShorts: hideShortsToggle.checked
  });
});

// Hide Movies toggle
hideMoviesToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({
    type: 'SET_HIDE_MOVIES',
    hideMovies: hideMoviesToggle.checked
  });
});

// Harvest Mode toggle
harvestModeToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({
    type: 'SET_HARVEST_MODE',
    harvestMode: harvestModeToggle.checked
  });
});

// Record while OFF toggle
recordWhileOffToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({
    type: 'SET_RECORD_WHILE_OFF',
    recordWhileOff: recordWhileOffToggle.checked
  });
});

// Auto backup toggle
autoBackupToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({
    type: 'SET_AUTO_BACKUP',
    autoBackup: autoBackupToggle.checked
  });
});

// Backup now
backupNowBtn.addEventListener('click', () => {
  showStatus(popupMessage('popupDynamicBackingUp', 'バックアップ中...'));
  chrome.runtime.sendMessage({ type: 'BACKUP_NOW' }, (result) => {
    if (!result) {
      showStatus(popupMessage('popupDynamicExtensionUnavailable', '拡張から応答がありません。YouTubeタブを開いて再試行してください'), true);
    } else if (result.success) {
      const watched = result.counts ? result.counts.watchedVideos : result.count;
      const liked = result.counts ? result.counts.likedVideos : 0;
      showStatus(popupMessage('popupDynamicBackupDone', `バックアップしました（視聴 ${watched}件 / 高評価 ${liked}件）`, [watched, liked]));
    } else if (result.reason === 'no_data') {
      showStatus(popupMessage('popupDynamicBackupEmpty', 'バックアップするデータがありません（0件）'), true);
    } else {
      showStatus(popupMessage('popupDynamicBackupFailed', `バックアップに失敗しました: ${(result.error || result.reason)}`, [(result.error || result.reason)]), true);
    }
  });
});

// About toggle
aboutBtn.addEventListener('click', () => {
  const visible = aboutPanel.style.display !== 'none';
  aboutPanel.style.display = visible ? 'none' : 'block';
  aboutBtn.setAttribute('aria-expanded', String(!visible));
});

// Set version from manifest
document.getElementById('aboutVersion').textContent = 'v' + chrome.runtime.getManifest().version;

// Clear: 視聴履歴だけ削除 (watched store only) — u1ps §7.4
clearWatchedBtn.addEventListener('click', () => {
  if (!confirm(popupMessage('popupDynamicConfirmClearWatched', '視聴履歴（watched）を全て削除します。\n\n元に戻せません。続けますか？'))) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, (response) => {
    if (response && response.success) {
      showStatus(popupMessage('popupDynamicWatchedCleared', '視聴履歴を削除しました'));
      loadStats();
      allHistoryData = [];
      renderHistory();
    } else {
      showStatus(popupMessage('popupDynamicDeleteFailed', `削除に失敗しました: ${((response && response.error) || 'unknown')}`, [((response && response.error) || 'unknown')]), true);
    }
  });
});

// Clear: 高評価データだけ削除 (liked store + sync meta) — u1ps §7.4
clearLikedBtn.addEventListener('click', () => {
  if (!confirm(popupMessage('popupDynamicConfirmClearLiked', '高評価データ（liked）を全て削除します。\n\n高評価はYouTubeから再同期できます。続けますか？'))) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_LIKED_ALL' }, (response) => {
    if (response && response.success) {
      showStatus(popupMessage('popupDynamicLikedCleared', '高評価データを削除しました'));
      loadStats();
    } else {
      showStatus(popupMessage('popupDynamicDeleteFailed', `削除に失敗しました: ${((response && response.error) || 'unknown')}`, [((response && response.error) || 'unknown')]), true);
    }
  });
});

// Clear: 全データを初期化 (both stores + meta, auto-backup first) — u1ps §7.4
clearAllBtn.addEventListener('click', () => {
  if (!confirm(popupMessage('popupDynamicConfirmClearAll', '全データ（視聴履歴＋高評価）を初期化します。\n\n実行前に自動でバックアップを1件ダウンロードし、その後すべて削除します。続けますか？'))) return;
  if (!confirm(popupMessage('popupDynamicConfirmResetAgain', '本当に初期化しますか？（この操作は元に戻せません）'))) return;
  // Disable all destructive buttons during the backup->delete window so a second
  // click can't launch a concurrent reset — u1ps (Codex B1 VERIFY).
  const clearBtns = [clearWatchedBtn, clearLikedBtn, clearAllBtn];
  clearBtns.forEach((b) => { b.disabled = true; });
  showStatus(popupMessage('popupDynamicBackingUp', 'バックアップ中...'));
  chrome.runtime.sendMessage({ type: 'CLEAR_ALL' }, (response) => {
    clearBtns.forEach((b) => { b.disabled = false; });
    if (response && response.success) {
      const b = response.backup;
      const backedUp = b && b.success
        ? popupMessage('popupDynamicBackupSaved', `（バックアップ ${b.counts ? b.counts.watchedVideos : b.count} 件保存済）`, [b.counts ? b.counts.watchedVideos : b.count])
        : (b && b.reason === 'no_data' ? popupMessage('popupDynamicNoData', '（データなし）') : '');
      showStatus(popupMessage('popupDynamicResetDone', `全データを初期化しました ${backedUp}`, [backedUp]));
      loadStats();
      allHistoryData = [];
      renderHistory();
      settingsPanel.style.display = 'none';
      settingsBtn.setAttribute('aria-expanded', 'false');
    } else if (response && response.reason === 'backup_failed') {
      // Data-safety gate: nothing was deleted because the backup failed.
      showStatus(popupMessage('popupDynamicBackupAbortReset', 'バックアップに失敗したため中止しました（データは削除していません）'), true);
    } else {
      showStatus(popupMessage('popupDynamicResetFailed', `初期化に失敗しました: ${((response && response.error) || 'unknown')}`, [((response && response.error) || 'unknown')]), true);
    }
  });
});

// Sync: Import & Merge from file
syncImportBtn.addEventListener('click', () => {
  syncFileInput.click();
});

syncFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  syncStatus.textContent = popupMessage('popupDynamicReadingFile', 'ファイルを読み込み中...');
  syncStatus.style.color = 'var(--warning)';

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const parsed = JSON.parse(event.target.result);
      const data = unwrapImportData(parsed);
      if (!data) {
        syncStatus.textContent = popupMessage('popupDynamicInvalidBackup', 'このファイルはバックアップの形式ではありません');
        syncStatus.style.color = 'var(--danger)';
        return;
      }
      syncStatus.textContent = popupMessage('popupDynamicMergingCount', `${data.length}件を統合中...`, [data.length]);
      chrome.runtime.sendMessage({ type: 'MERGE_IMPORT', data: parsed }, (response) => {
        if (response && response.success) {
          const result = formatMergeImportStatus(response);
          syncStatus.textContent = result.text;
          syncStatus.style.color = result.warning ? 'var(--warning)' : 'var(--success)';
          loadStats();
          if (historyPanel.style.display !== 'none') loadHistory();
        } else {
          syncStatus.textContent = popupMessage('popupDynamicMergeFailed', '統合に失敗しました');
          syncStatus.style.color = 'var(--danger)';
        }
      });
    } catch {
      syncStatus.textContent = popupMessage('popupDynamicJsonFailed', 'JSONを読み取れませんでした');
      syncStatus.style.color = 'var(--danger)';
    }
  };
  reader.readAsText(file);
  syncFileInput.value = '';
});

// Init
loadStats();
