// Popup script for YouTube Watched Hider

const countEl = document.getElementById('count');
const dbStatusEl = document.getElementById('dbStatus');
const enableToggle = document.getElementById('enableToggle');
const toggleLabel = document.getElementById('toggleLabel');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const clearBtn = document.getElementById('clearBtn');
const fileInput = document.getElementById('fileInput');
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
const aboutBtn = document.getElementById('aboutBtn');
const aboutPanel = document.getElementById('aboutPanel');
const nextBackupInfo = document.getElementById('nextBackupInfo');
const hideShortsToggle = document.getElementById('hideShortsToggle');
const hideMoviesToggle = document.getElementById('hideMoviesToggle');
const syncImportBtn = document.getElementById('syncImportBtn');
const syncFileInput = document.getElementById('syncFileInput');
const syncStatus = document.getElementById('syncStatus');

let allHistoryData = [];
let filteredHistoryData = [];
let historyRenderedCount = 0;
let lastHistoryDateGroup = '';
const HISTORY_PAGE_SIZE = 50;

function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#ff6b6b' : '#4caf50';
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
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
      if (response.dbStatus) {
        const statusMap = {
          ready: `DB ready (cache: ${(response.cacheSize || 0).toLocaleString()}, ${response.cacheLoadTime || 0}ms)`,
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
  a.href = `https://www.youtube.com/watch?v=${video.videoId}`;
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
  historyList.innerHTML = '';
  historyRenderedCount = 0;
  lastHistoryDateGroup = '';

  const lowerFilter = filter.toLowerCase();
  filteredHistoryData = filter
    ? allHistoryData.filter(v =>
        (v.title || v.videoId).toLowerCase().includes(lowerFilter) ||
        (v.channel || '').toLowerCase().includes(lowerFilter))
    : allHistoryData;

  if (filteredHistoryData.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No videos found</div>';
    return;
  }

  renderHistoryBatch();
}

// Load and show history
function loadHistory() {
  chrome.runtime.sendMessage({ type: 'EXPORT_DATA' }, (data) => {
    if (!data || data.length === 0) {
      allHistoryData = [];
    } else {
      // Sort by most recent first
      allHistoryData = data.sort((a, b) => b.watchedAt - a.watchedAt);
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
    autoBackupToggle.checked = response.autoBackup !== false;
    if (response.lastBackup) {
      const d = new Date(response.lastBackup);
      const dateStr = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
      lastBackupInfo.textContent = ` (last: ${dateStr}, ${response.lastBackupCount} records)`;
    }
    if (response.nextBackup) {
      const nd = new Date(response.nextBackup);
      const h = String(nd.getHours()).padStart(2, '0');
      const m = String(nd.getMinutes()).padStart(2, '0');
      const mm = nd.getMonth() + 1;
      const dd = nd.getDate();
      nextBackupInfo.textContent = `Next: ${mm}/${dd} ${h}:${m}`;
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

// Export (versioned envelope format)
exportBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'EXPORT_DATA' }, (data) => {
    if (!data || data.length === 0) {
      showStatus('No data to export', true);
      return;
    }
    const envelope = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: chrome.runtime.getManifest().version,
      count: data.length,
      records: data,
    };
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yt-watched-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus(`Exported ${data.length} records`);
  });
});

// Import
importBtn.addEventListener('click', () => {
  fileInput.click();
});

// Unwrap import data: accept both envelope format and legacy raw array
function unwrapImportData(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) return parsed.records;
  return null;
}

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const parsed = JSON.parse(event.target.result);
      const data = unwrapImportData(parsed);
      if (!data) {
        showStatus('Invalid JSON format', true);
        return;
      }
      chrome.runtime.sendMessage({ type: 'IMPORT_DATA', data }, (response) => {
        if (response && response.success) {
          showStatus(`Imported ${response.count} records`);
          loadStats();
          if (historyPanel.style.display !== 'none') loadHistory();
        } else {
          showStatus('Import failed', true);
        }
      });
    } catch {
      showStatus('Failed to parse JSON', true);
    }
  };
  reader.readAsText(file);
  fileInput.value = '';
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
      showStatus(`Backup OK: ${result.count} records`);
    } else if (result.reason === 'no_data') {
      showStatus('No data to backup (0 records)', true);
    } else if (result.reason === 'disabled') {
      showStatus('Auto backup is disabled', true);
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

// Clear
clearBtn.addEventListener('click', () => {
  if (!confirm('WARNING: All watched history will be permanently deleted.\n\nThis cannot be undone. Continue?')) return;
  if (!confirm('Are you really sure? Export a backup first if needed.')) return;

  chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, (response) => {
    if (response && response.success) {
      showStatus('All data cleared');
      loadStats();
      allHistoryData = [];
      renderHistory();
      settingsPanel.style.display = 'none';
    } else {
      showStatus('Clear failed', true);
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
  syncStatus.style.color = '#ff9800';

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const parsed = JSON.parse(event.target.result);
      const data = unwrapImportData(parsed);
      if (!data) {
        syncStatus.textContent = 'Invalid JSON format';
        syncStatus.style.color = '#ff6b6b';
        return;
      }
      syncStatus.textContent = `Merging ${data.length} records...`;
      chrome.runtime.sendMessage({ type: 'MERGE_IMPORT', data }, (response) => {
        if (response && response.success) {
          syncStatus.textContent = `Done: +${response.added} new, ${response.skipped} existing`;
          syncStatus.style.color = '#4caf50';
          loadStats();
          if (historyPanel.style.display !== 'none') loadHistory();
        } else {
          syncStatus.textContent = 'Merge failed';
          syncStatus.style.color = '#ff6b6b';
        }
      });
    } catch {
      syncStatus.textContent = 'Failed to parse JSON';
      syncStatus.style.color = '#ff6b6b';
    }
  };
  reader.readAsText(file);
  syncFileInput.value = '';
});

// Init
loadStats();
