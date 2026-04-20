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

  // Split a credit field by common separators ("A, B", "A / B", "A & B", "A・B").
  function splitCreditField(s) {
    if (!s) return [];
    return String(s)
      .split(/[,、，\/／&＆;；]|\s+and\s+|・/i)
      .map(x => x.trim())
      .filter(Boolean);
  }

  // 動画の creditsSource を判定（未記録は channel から後方互換推定）
  function sourceOf(d) {
    if (d.creditsSource === 'topic' || d.creditsSource === 'general') return d.creditsSource;
    if (d.channel && / - Topic$/.test(d.channel)) return 'topic';
    return 'general';
  }

  // Build credit -> {count, selfArrangeCount} filtered by source ('all'|'topic'|'general').
  function buildCreditCount(data, field, sourceFilter) {
    const m = new Map();
    for (const d of data) {
      if (!d.composer && !d.lyricist && !d.arranger) continue;
      if (sourceFilter && sourceFilter !== 'all' && sourceOf(d) !== sourceFilter) continue;
      const names = splitCreditField(d[field]);
      if (!names.length) continue;
      const composers = new Set(splitCreditField(d.composer));
      const arrangers = new Set(splitCreditField(d.arranger));
      const isSelfArrange = composers.size && arrangers.size &&
        [...composers].some(c => arrangers.has(c));
      for (const name of names) {
        const cur = m.get(name) || { count: 0, self: 0 };
        cur.count++;
        if (isSelfArrange) cur.self++;
        m.set(name, cur);
      }
    }
    return m;
  }

  let currentCreditField = 'composer';
  let currentCreditSource = 'all';

  function renderCredits(data) {
    const cm = buildCreditCount(data, currentCreditField, currentCreditSource);
    const q = document.getElementById('azCreditFilter').value.trim().toLowerCase();
    let list = [...cm.entries()];
    if (q) list = list.filter(([k]) => k.toLowerCase().includes(q));
    list.sort((a, b) => b[1].count - a[1].count);

    const totalPeople = cm.size;
    const totalPlays = [...cm.values()].reduce((s, v) => s + v.count, 0);
    document.getElementById('azCreditStats').textContent =
      `${totalPeople.toLocaleString()}人 / ${totalPlays.toLocaleString()}再生`;

    const tbody = document.querySelector('#azCreditsTable tbody');
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();
    list.slice(0, 500).forEach(([name, v], i) => {
      const tr = document.createElement('tr');
      const rate = v.count ? Math.round(v.self / v.count * 100) : 0;
      const selfCell = v.self ? `${v.self} (${rate}%)` : '-';
      tr.innerHTML =
        `<td>${i + 1}</td>` +
        `<td>${esc(name)}</td>` +
        `<td>${v.count}</td>` +
        `<td style="color:#888;">${selfCell}</td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
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
    renderCredits(data);
    renderPrompt(chCount);

    // Re-wire filters to current chCount
    document.getElementById('azArtistFilter').oninput = () => renderArtists(chCount);
    document.getElementById('azTopicOnly').onchange = () => renderArtists(chCount);
    document.getElementById('azChannelFilter').oninput = () => renderChannels(chCount);
    document.getElementById('azCreditFilter').oninput = () => renderCredits(data);
    document.querySelectorAll('.az-credit-tab').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('.az-credit-tab').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        currentCreditField = b.dataset.credit;
        renderCredits(data);
      };
    });
    document.querySelectorAll('.az-credit-source').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('.az-credit-source').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        currentCreditSource = b.dataset.source;
        renderCredits(data);
      };
    });
  }

  // Tab switching
  document.querySelectorAll('.az-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.az-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const map = { artists: 'azArtistsPanel', channels: 'azChannelsPanel', keywords: 'azKeywordsPanel', credits: 'azCreditsPanel', prompt: 'azPromptPanel' };
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
