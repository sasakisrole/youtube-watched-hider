// Popup script for YouTube Watched Hider

const countEl = document.getElementById('count');
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
const aboutBtn = document.getElementById('aboutBtn');
const aboutPanel = document.getElementById('aboutPanel');

let allHistoryData = [];

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

// Load stats
function loadStats() {
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
    if (response && typeof response.count === 'number') {
      countEl.textContent = response.count.toLocaleString();
    } else {
      countEl.textContent = '0';
    }
  });
}

// Render history list
function renderHistory(filter = '') {
  historyList.innerHTML = '';
  const filtered = filter
    ? allHistoryData.filter(v =>
        (v.title || v.videoId).toLowerCase().includes(filter.toLowerCase()))
    : allHistoryData;

  if (filtered.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No videos found</div>';
    return;
  }

  for (const video of filtered) {
    const a = document.createElement('a');
    a.className = 'history-item';
    a.href = `https://www.youtube.com/watch?v=${video.videoId}`;
    a.target = '_blank';
    a.rel = 'noopener';

    // Source indicator
    if (video.source === 'seekbar') {
      const badge = document.createElement('span');
      badge.className = 'source-badge';
      badge.textContent = 'YT';
      badge.title = 'Detected via YouTube seekbar (may not be self-played)';
      a.appendChild(badge);
    }

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = video.title || video.videoId;

    const meta = document.createElement('span');
    meta.className = 'meta';
    const count = video.playCount || 1;
    meta.textContent = count > 1
      ? `${count}x ${formatDate(video.watchedAt)}`
      : formatDate(video.watchedAt);

    a.appendChild(title);
    a.appendChild(meta);
    historyList.appendChild(a);
  }
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
    autoBackupToggle.checked = response.autoBackup !== false;
    if (response.lastBackup) {
      const d = new Date(response.lastBackup);
      const dateStr = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
      lastBackupInfo.textContent = ` (last: ${dateStr}, ${response.lastBackupCount} records)`;
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

// History search
historySearch.addEventListener('input', () => {
  renderHistory(historySearch.value);
});

// Export
exportBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'EXPORT_DATA' }, (data) => {
    if (!data || data.length === 0) {
      showStatus('No data to export', true);
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const data = JSON.parse(event.target.result);
      if (!Array.isArray(data)) {
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
  chrome.runtime.sendMessage({ type: 'BACKUP_NOW' });
  showStatus('Backup started...');
});

// About toggle
aboutBtn.addEventListener('click', () => {
  const visible = aboutPanel.style.display !== 'none';
  aboutPanel.style.display = visible ? 'none' : 'block';
});

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

// Init
loadStats();
