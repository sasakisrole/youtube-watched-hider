// Analyzer view for YouTube Watched Hider
// Reads from allData (loaded by history.js) and renders music taste analysis.

(function () {
  const STOP = new Set([
    'する','した','して','さん','こと','もの','ため','これ','それ','あれ',
    'です','ます','ない','ある','いる','から','まで','より',
    '公式','Official','Music','Video','Audio','MV','feat','ft',
    'ver','Ver','version','Version','Live','LIVE','Remix','REMIX',
    'Cover','cover','カバー','Topic','topic'
  ]);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function extractKeywords(titles) {
    const cnt = new Map();
    for (const t of titles) {
      const cleaned = String(t)
        .replace(/[【\[（(].*?[】\])）]/g, ' ')
        .replace(/[「」『』"'"'／\/#\-–—|｜]/g, ' ');
      const tokens = cleaned.split(/[\s、。,.!！?？:：;；]+/);
      for (let tok of tokens) {
        tok = tok.trim();
        if (tok.length < 2 || tok.length > 20) continue;
        if (/^\d+$/.test(tok)) continue;
        if (STOP.has(tok)) continue;
        cnt.set(tok, (cnt.get(tok) || 0) + 1);
      }
    }
    return [...cnt.entries()].sort((a, b) => b[1] - a[1]);
  }

  function buildChannelCount(data) {
    const m = new Map();
    for (const d of data) {
      if (!d.channel) continue;
      m.set(d.channel, (m.get(d.channel) || 0) + 1);
    }
    return m;
  }

  function renderArtists(chCount) {
    const tbody = document.querySelector('#azArtistsTable tbody');
    const q = document.getElementById('azArtistFilter').value.trim().toLowerCase();
    const topicOnly = document.getElementById('azTopicOnly').checked;
    let list = [...chCount.entries()];
    if (topicOnly) list = list.filter(([k]) => k.endsWith('- Topic'));
    if (q) list = list.filter(([k]) => k.toLowerCase().includes(q));
    list.sort((a, b) => b[1] - a[1]);

    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    list.slice(0, 300).forEach(([name, cnt], i) => {
      const clean = name.replace(/ - Topic$/, '');
      const qn = encodeURIComponent(clean);
      const qTopic = encodeURIComponent(clean + ' - Topic');
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${i + 1}</td>` +
        `<td>${esc(name)}</td>` +
        `<td>${cnt}</td>` +
        `<td>` +
          `<a href="https://www.youtube.com/results?search_query=${qTopic}&sp=EgIQAQ==" target="_blank">Topic検索</a>` +
          `<a href="https://www.youtube.com/results?search_query=${qn}" target="_blank">YT</a>` +
          `<a href="https://www.google.com/search?q=${qn}+similar+artists" target="_blank">類似</a>` +
        `</td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  function renderChannels(chCount) {
    const tbody = document.querySelector('#azChannelsTable tbody');
    const q = document.getElementById('azChannelFilter').value.trim().toLowerCase();
    let list = [...chCount.entries()];
    if (q) list = list.filter(([k]) => k.toLowerCase().includes(q));
    list.sort((a, b) => b[1] - a[1]);

    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    list.slice(0, 500).forEach(([name, cnt], i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${esc(name)}</td><td>${cnt}</td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  function renderKeywords(data, chCount) {
    const topicSet = new Set([...chCount.keys()].filter(k => k.endsWith('- Topic')));
    const titles = data.filter(d => topicSet.has(d.channel)).map(d => d.title || '');
    const kws = extractKeywords(titles).slice(0, 80);
    const box = document.getElementById('azKwList');
    box.innerHTML = '';
    kws.forEach(([w, c]) => {
      const el = document.createElement('div');
      el.className = 'az-kw';
      el.innerHTML = `<span>${esc(w)}</span><span class="w">${c}</span>`;
      box.appendChild(el);
    });
  }

  function renderPrompt(chCount) {
    const topic = [...chCount.entries()].filter(([k]) => k.endsWith('- Topic')).sort((a, b) => b[1] - a[1]).slice(0, 40);
    const nonTopic = [...chCount.entries()].filter(([k]) => !k.endsWith('- Topic')).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const lines = [];
    lines.push('以下は私のYouTube視聴履歴から抽出した、よく聴く音楽アーティスト（YouTube Topicチャンネル由来）の再生数ランキングです。');
    lines.push('');
    lines.push('## 再生数Top40アーティスト');
    topic.forEach(([k, v], i) => lines.push(`${i + 1}. ${k.replace(/ - Topic$/, '')} (${v}回)`));
    lines.push('');
    lines.push('## 音楽系と思われる一般チャンネル Top15（参考）');
    nonTopic.forEach(([k, v], i) => lines.push(`${i + 1}. ${k} (${v}回)`));
    lines.push('');
    lines.push('この傾向から読み取れる音楽的志向を分析し、私がまだ聴いていない可能性が高い「次に聴くべきアーティスト/作曲家」を10名推薦してください。各推薦には以下を含めてください:');
    lines.push('- アーティスト/作曲家名');
    lines.push('- 代表曲1〜2曲');
    lines.push('- 既存のお気に入りとの関連性（なぜこの人を勧めるか）');
    lines.push('- YouTube検索キーワード');
    document.getElementById('azPromptText').textContent = lines.join('\n');
  }

  function runAnalysis() {
    const data = (typeof allData !== 'undefined' && allData) ? allData : [];
    const chCount = buildChannelCount(data);
    const topicCh = [...chCount.entries()].filter(([k]) => k.endsWith('- Topic'));
    const musicPlays = topicCh.reduce((s, [, v]) => s + v, 0);

    document.getElementById('azTotal').textContent = data.length.toLocaleString();
    document.getElementById('azCh').textContent = chCount.size.toLocaleString();
    document.getElementById('azArtist').textContent = topicCh.length.toLocaleString();
    document.getElementById('azMusic').textContent = musicPlays.toLocaleString();

    renderArtists(chCount);
    renderChannels(chCount);
    renderKeywords(data, chCount);
    renderPrompt(chCount);

    // Re-wire filters to current chCount
    document.getElementById('azArtistFilter').oninput = () => renderArtists(chCount);
    document.getElementById('azTopicOnly').onchange = () => renderArtists(chCount);
    document.getElementById('azChannelFilter').oninput = () => renderChannels(chCount);
  }

  // Tab switching
  document.querySelectorAll('.az-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.az-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const map = { artists: 'azArtistsPanel', channels: 'azChannelsPanel', keywords: 'azKeywordsPanel', prompt: 'azPromptPanel' };
      Object.values(map).forEach(id => { document.getElementById(id).style.display = 'none'; });
      document.getElementById(map[t.dataset.aztab]).style.display = '';
    });
  });

  // Copy prompt button
  document.getElementById('azCopyPrompt').addEventListener('click', async () => {
    const text = document.getElementById('azPromptText').textContent;
    try {
      await navigator.clipboard.writeText(text);
      const msg = document.getElementById('azCopyMsg');
      msg.textContent = 'コピーしました';
      setTimeout(() => { msg.textContent = ''; }, 2000);
    } catch (e) {
      alert('コピー失敗: ' + e.message);
    }
  });

  // Toggle between list view and analyze view
  const btn = document.getElementById('toggleAnalyze');
  const listView = document.getElementById('content');
  const analyzeView = document.getElementById('analyzeView');
  let analyzeMode = false;

  btn.addEventListener('click', () => {
    analyzeMode = !analyzeMode;
    btn.classList.toggle('active', analyzeMode);
    if (analyzeMode) {
      listView.style.display = 'none';
      analyzeView.style.display = '';
      runAnalysis();
    } else {
      listView.style.display = '';
      analyzeView.style.display = 'none';
    }
  });
})();
