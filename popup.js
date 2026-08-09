// Popup script for YouTube Watched Hider

const countEl = document.getElementById('count');
const dbStatusEl = document.getElementById('dbStatus');
const enableToggle = document.getElementById('enableToggle');
const toggleLabel = document.getElementById('toggleLabel');
const exportBtn = document.getElementById('exportBtn');
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
      ? 'YouTubeタブ未接続。DB件数は表示中、content cacheは次回YouTube表示時に取得します。'
      : `positive ${positive.toLocaleString()} / recent ${recent.toLocaleString()} / pages ${pages.toLocaleString()} / load ${loadMs.toLocaleString()}ms`;
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
    showStatus('DB error: ' + (data.message || 'unknown'), true);
    return null;
  }
  return unwrapWatchedRecords(data) || [];
}

// Format date
function formatDate(timestamp) {
  const d = new Date(timestamp);
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
      countEl.title = 'Service worker error';
      showStatus('SW error: ' + chrome.runtime.lastError.message, true);
      return;
    }
    if (response && typeof response.count === 'number') {
      countEl.textContent = response.count.toLocaleString();
      countEl.title = '';
      const cache = renderCacheStats(response);
      if (response.dbStatus) {
        const statusMap = {
          ready: response.dbOwner === 'offscreen'
            ? `DB ready (offscreen, cache: ${cache.positive.toLocaleString()}, ${cache.mode})`
            : `DB ready (cache: ${cache.positive.toLocaleString()}, ${cache.loadMs}ms)`,
          loading: 'DB loading...',
          error: 'DB error',
        };
        dbStatusEl.textContent = statusMap[response.dbStatus] || response.dbStatus;
        dbStatusEl.className = 'db-status ' + response.dbStatus;
      }
    } else if (retries > 0) {
      countEl.title = 'Connecting... (' + retries + ')';
      setTimeout(() => loadStats(retries - 1), 1000);
    } else {
      countEl.textContent = '--';
      countEl.title = 'No YouTube tab responded';
      showStatus('YouTubeタブを開いてリロードしてください', true);
    }
  });
}

// Format date for group headers (YYYY/MM/DD with day of week)
function formatDateGroup(timestamp) {
  const d = new Date(timestamp);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} (${days[d.getDay()]})`;
}

// Format time (HH:MM)
function formatTime(timestamp) {
  const d = new Date(timestamp);
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
      ? 'Detected via YouTube seekbar'
      : 'Imported from YouTube history';
    a.appendChild(badge);
  }

  const count = video.playCount || 1;
  if (count > 1) {
    const countBadge = document.createElement('span');
    countBadge.className = 'play-count-badge';
    countBadge.textContent = `${count}x`;
    countBadge.title = `Played ${count} times`;
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
  delBtn.title = 'Remove';
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
    empty.textContent = 'No videos found';
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
      const d = new Date(response.lastBackup);
      const dateStr = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
      lastBackupInfo.textContent = ` (last: ${dateStr}, ${response.lastBackupCount} records)`;
    } else {
      lastBackupInfo.textContent = '';
    }
    if (response.lastBackupError) {
      const prefix = lastBackupInfo.textContent ? `${lastBackupInfo.textContent} ` : ' ';
      lastBackupInfo.className = 'backup-status backup-error';
      lastBackupInfo.textContent = `${prefix}last error: ${response.lastBackupError}`;
    }
    if (response.nextBackup) {
      const nd = new Date(response.nextBackup);
      const h = String(nd.getHours()).padStart(2, '0');
      const m = String(nd.getMinutes()).padStart(2, '0');
      const mm = nd.getMonth() + 1;
      const dd = nd.getDate();
      nextBackupInfo.textContent = `Next: ${mm}/${dd} ${h}:${m}`;
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

// Export (versioned envelope format)
exportBtn.addEventListener('click', () => {
  showStatus('Export started...');
  chrome.runtime.sendMessage({ type: 'EXPORT_DOWNLOAD', source: 'manual' }, (result) => {
    if (!result) {
      showStatus('Export failed: no response', true);
      return;
    }
    if (result.success) {
      const watched = result.counts ? result.counts.watchedVideos : result.count;
      const liked = result.counts ? result.counts.likedVideos : 0;
      showStatus(`Exported ${watched} watched / ${liked} liked`);
    } else if (result.reason === 'no_data') {
      showStatus('No data to export', true);
    } else {
      showStatus('Export failed: ' + (result.error || result.reason), true);
    }
  });
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
      showStatus('Failed to parse JSON', true);
      return;
    }
    if (!unwrapImportData(parsed)) {
      showStatus('Invalid JSON format', true);
      return;
    }
    pendingImportData = parsed;
    pendingImportDiff = null;
    showStatus('差分を計算中...');
    chrome.runtime.sendMessage({ type: 'IMPORT_DIFF', data: parsed }, (response) => {
      if (myGen !== importGeneration) return; // a newer file was picked; ignore stale reply
      if (response && response.success && response.diff) {
        pendingImportDiff = response.diff;
        importDiffSummary.textContent = renderImportDiff(response.diff);
        importModePanel.style.display = 'block';
        statusEl.textContent = '';
      } else {
        pendingImportData = null;
        showStatus('差分の計算に失敗しました: ' + ((response && response.error) || 'unknown'), true);
      }
    });
  };
  reader.readAsText(file);
  fileInput.value = '';
});

function renderImportDiff(diff) {
  const w = diff.watched || {};
  const l = diff.liked || {};
  const inv = diff.invalid || {};
  const invN = (inv.watched || 0) + (inv.liked || 0);
  const lines = [
    `視聴履歴: 追加 ${w.add || 0} / 更新 ${w.overlap || 0}（置換すると ${w.currentOnly || 0} 件削除）`,
    `高評価: 追加 ${l.add || 0} / 更新 ${l.overlap || 0}（置換すると ${l.currentOnly || 0} 件削除）`,
  ];
  if (invN) lines.push(`無効データ: ${invN} 件スキップ`);
  if (inv.likedStructural) lines.push('※ 高評価データの形式が不正なためスキップされます');
  if (inv.likedMetaStructural) lines.push('※ 高評価の同期アカウント情報の形式が不正なためスキップされます（再同期で復元できます）');
  return lines.join('\n');
}

function formatImportResult(response, label) {
  const likedFailed = !!(response.liked && response.liked.failed);
  const liked = likedFailed
    ? ' / 高評価の復元に失敗'
    : (response.liked && typeof response.liked.imported === 'number' ? ` / ${response.liked.imported} liked` : '');
  const droppedN = response.dropped ? ((response.dropped.watched || 0) + (response.dropped.liked || 0)) : 0;
  const structural = !!(response.dropped && response.dropped.likedStructural);
  const metaStructural = !!(response.dropped && response.dropped.likedMetaStructural);
  const removed = response.removed ? `, ${(response.removed.watched || 0) + (response.removed.liked || 0)}件削除` : '';
  const notes = [];
  if (droppedN) notes.push(`${droppedN}件スキップ`);
  if (structural) notes.push('高評価データ形式不正');
  if (metaStructural) notes.push('高評価アカウント情報の形式不正');
  const note = notes.length ? `（${notes.join(' / ')}）` : '';
  const resultLabel = likedFailed ? `${label}（一部成功）` : label;
  return {
    text: `${resultLabel}: ${response.count} records${liked}${removed}${note}`,
    warning: likedFailed || droppedN > 0 || structural || metaStructural,
  };
}

function formatMergeImportStatus(response) {
  const likedFailed = !!(response.liked && response.liked.failed);
  const liked = likedFailed
    ? ', 高評価の復元に失敗'
    : (response.liked && typeof response.liked.imported === 'number' ? `, ${response.liked.imported} liked` : '');
  const droppedN = response.dropped ? ((response.dropped.watched || 0) + (response.dropped.liked || 0)) : 0;
  const structural = !!(response.dropped && response.dropped.likedStructural);
  const metaStructural = !!(response.dropped && response.dropped.likedMetaStructural);
  const droppedNotes = [];
  if (droppedN) droppedNotes.push(`${droppedN}件スキップ`);
  if (structural) droppedNotes.push('高評価データの形式が不正');
  if (metaStructural) droppedNotes.push('高評価アカウント情報の形式が不正');
  const droppedNote = droppedNotes.length ? `（${droppedNotes.join(' / ')}）` : '';
  const prefix = likedFailed ? '一部成功: 視聴履歴' : 'Done:';
  return {
    text: `${prefix} +${response.added} new, ${response.skipped} existing${liked}${droppedNote}`,
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
    showStatus('バックアップに失敗したため中止しました（データは変更していません）', true);
  } else {
    showStatus(`${label} failed: ` + ((response && response.error) || 'unknown'), true);
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
  showStatus('統合中...');
  chrome.runtime.sendMessage({ type: 'MERGE_IMPORT', data }, (r) => handleImportResponse(r, '安全に統合'));
});

importBackupMergeBtn.addEventListener('click', () => {
  const data = closeImportPanel();
  if (!data) return;
  showStatus('統合中...');
  chrome.runtime.sendMessage({ type: 'IMPORT_DATA', data }, (r) => handleImportResponse(r, 'バックアップ優先で統合'));
});

importReplaceBtn.addEventListener('click', () => {
  const diff = pendingImportDiff;
  const delW = diff && diff.watched ? diff.watched.currentOnly : 0;
  const delL = diff && diff.liked ? diff.liked.currentOnly : 0;
  if (!confirm(`置換します。現在のデータを自動バックアップ（1件ダウンロード）してから、このファイルの内容に置き換えます。\n\nこのファイルに無い 視聴履歴 ${delW} 件・高評価 ${delL} 件が削除されます。続けますか？`)) return;
  const data = closeImportPanel();
  if (!data) return;
  const btns = [importReplaceBtn, importSafeMergeBtn, importBackupMergeBtn, importBtn];
  btns.forEach((b) => { b.disabled = true; });
  showStatus('バックアップ中...');
  chrome.runtime.sendMessage({ type: 'REPLACE_IMPORT', data }, (r) => {
    btns.forEach((b) => { b.disabled = false; });
    handleImportResponse(r, '置換');
  });
});

importCancelBtn.addEventListener('click', () => {
  closeImportPanel();
  showStatus('インポートをキャンセルしました');
});

// Settings toggle
settingsBtn.addEventListener('click', () => {
  const visible = settingsPanel.style.display !== 'none';
  settingsPanel.style.display = visible ? 'none' : 'flex';
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
  showStatus('Backup started...');
  chrome.runtime.sendMessage({ type: 'BACKUP_NOW' }, (result) => {
    if (!result) {
      showStatus('No response from SW', true);
    } else if (result.success) {
      const watched = result.counts ? result.counts.watchedVideos : result.count;
      const liked = result.counts ? result.counts.likedVideos : 0;
      showStatus(`Backup OK: ${watched} watched / ${liked} liked`);
    } else if (result.reason === 'no_data') {
      showStatus('No data to backup (0 records)', true);
    } else {
      showStatus('Backup failed: ' + (result.error || result.reason), true);
    }
  });
});

// About toggle
aboutBtn.addEventListener('click', () => {
  const visible = aboutPanel.style.display !== 'none';
  aboutPanel.style.display = visible ? 'none' : 'block';
});

// Set version from manifest
document.getElementById('aboutVersion').textContent = 'v' + chrome.runtime.getManifest().version;

// Clear: 視聴履歴だけ削除 (watched store only) — u1ps §7.4
clearWatchedBtn.addEventListener('click', () => {
  if (!confirm('視聴履歴（watched）を全て削除します。\n\n元に戻せません。続けますか？')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, (response) => {
    if (response && response.success) {
      showStatus('視聴履歴を削除しました');
      loadStats();
      allHistoryData = [];
      renderHistory();
    } else {
      showStatus('削除に失敗しました: ' + ((response && response.error) || 'unknown'), true);
    }
  });
});

// Clear: 高評価データだけ削除 (liked store + sync meta) — u1ps §7.4
clearLikedBtn.addEventListener('click', () => {
  if (!confirm('高評価データ（liked）を全て削除します。\n\n高評価はYouTubeから再同期できます。続けますか？')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_LIKED_ALL' }, (response) => {
    if (response && response.success) {
      showStatus('高評価データを削除しました');
      loadStats();
    } else {
      showStatus('削除に失敗しました: ' + ((response && response.error) || 'unknown'), true);
    }
  });
});

// Clear: 全データを初期化 (both stores + meta, auto-backup first) — u1ps §7.4
clearAllBtn.addEventListener('click', () => {
  if (!confirm('全データ（視聴履歴＋高評価）を初期化します。\n\n実行前に自動でバックアップを1件ダウンロードし、その後すべて削除します。続けますか？')) return;
  if (!confirm('本当に初期化しますか？（この操作は元に戻せません）')) return;
  // Disable all destructive buttons during the backup->delete window so a second
  // click can't launch a concurrent reset — u1ps (Codex B1 VERIFY).
  const clearBtns = [clearWatchedBtn, clearLikedBtn, clearAllBtn];
  clearBtns.forEach((b) => { b.disabled = true; });
  showStatus('バックアップ中...');
  chrome.runtime.sendMessage({ type: 'CLEAR_ALL' }, (response) => {
    clearBtns.forEach((b) => { b.disabled = false; });
    if (response && response.success) {
      const b = response.backup;
      const backedUp = b && b.success
        ? `（バックアップ ${b.counts ? b.counts.watchedVideos : b.count} 件保存済）`
        : (b && b.reason === 'no_data' ? '（データなし）' : '');
      showStatus(`全データを初期化しました ${backedUp}`);
      loadStats();
      allHistoryData = [];
      renderHistory();
      settingsPanel.style.display = 'none';
    } else if (response && response.reason === 'backup_failed') {
      // Data-safety gate: nothing was deleted because the backup failed.
      showStatus('バックアップに失敗したため中止しました（データは削除していません）', true);
    } else {
      showStatus('初期化に失敗しました: ' + ((response && response.error) || 'unknown'), true);
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

  syncStatus.textContent = 'Reading file...';
  syncStatus.style.color = 'var(--warning)';

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const parsed = JSON.parse(event.target.result);
      const data = unwrapImportData(parsed);
      if (!data) {
        syncStatus.textContent = 'Invalid JSON format';
        syncStatus.style.color = 'var(--danger)';
        return;
      }
      syncStatus.textContent = `Merging ${data.length} records...`;
      chrome.runtime.sendMessage({ type: 'MERGE_IMPORT', data: parsed }, (response) => {
        if (response && response.success) {
          const result = formatMergeImportStatus(response);
          syncStatus.textContent = result.text;
          syncStatus.style.color = result.warning ? 'var(--warning)' : 'var(--success)';
          loadStats();
          if (historyPanel.style.display !== 'none') loadHistory();
        } else {
          syncStatus.textContent = 'Merge failed';
          syncStatus.style.color = 'var(--danger)';
        }
      });
    } catch {
      syncStatus.textContent = 'Failed to parse JSON';
      syncStatus.style.color = 'var(--danger)';
    }
  };
  reader.readAsText(file);
  syncFileInput.value = '';
});

// Init
loadStats();
