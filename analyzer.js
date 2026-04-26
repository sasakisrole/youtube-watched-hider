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
  let currentCreditSource = 'topic';

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

  // Music-likeness of a non-Topic channel: ratio of plays that have credits.
  function buildChannelMusicScore(data) {
    const total = new Map();
    const credited = new Map();
    for (const d of data) {
      if (!d.channel) continue;
      if (/ - Topic$/.test(d.channel)) continue;
      total.set(d.channel, (total.get(d.channel) || 0) + 1);
      if (d.composer || d.lyricist || d.arranger) {
        credited.set(d.channel, (credited.get(d.channel) || 0) + 1);
      }
    }
    return { total, credited };
  }

  // Filter out junk credit names (Twitter URLs, stray parens, etc.) that leak in from upstream extraction.
  function isCleanCreditName(name) {
    if (!name || name.length < 2 || name.length > 60) return false;
    if (/https?:|twitter\.com|x\.com|t\.co\//i.test(name)) return false;
    if (/^[\(\)\[\]【】（）]/.test(name) || /[\(\[【（][^\)\]】）]*$/.test(name)) return false;
    if (/^[\)\]】）]/.test(name)) return false;
    if (/Twitter\s*[:：]/i.test(name)) return false;
    // Unbalanced parens (e.g. "triplebullets)", "mitsukiyo_5)") signal upstream split errors.
    const opens = (name.match(/[\(（\[【]/g) || []).length;
    const closes = (name.match(/[\)）\]】]/g) || []).length;
    if (opens !== closes) return false;
    return true;
  }

  function topCredits(data, field, sourceFilter, limit) {
    const m = buildCreditCount(data, field, sourceFilter);
    return [...m.entries()]
      .filter(([k]) => isCleanCreditName(k))
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit);
  }

  let likedRecords = [];

  function loadLiked() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      // Hard timeout so the analyzer never hangs even if no YouTube tab is open.
      const timer = setTimeout(finish, 3000);
      try {
        chrome.runtime.sendMessage({ type: 'GET_LIKED' }, (resp) => {
          clearTimeout(timer);
          likedRecords = (resp && resp.success && resp.rows) ? resp.rows : [];
          finish();
        });
      } catch (_e) { clearTimeout(timer); finish(); }
    });
  }

  function buildLikedArtistCount() {
    const m = new Map();
    for (const r of likedRecords) {
      if (!r.channel) continue;
      m.set(r.channel, (m.get(r.channel) || 0) + 1);
    }
    return m;
  }

  function renderLikedPanel() {
    const ch = buildLikedArtistCount();
    document.getElementById('azLikedTotal').textContent = likedRecords.length.toLocaleString();
    document.getElementById('azLikedArtists').textContent = ch.size.toLocaleString();

    const tbody = document.querySelector('#azLikedTable tbody');
    tbody.innerHTML = '';
    const list = [...ch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200);
    const frag = document.createDocumentFragment();
    list.forEach(([name, cnt], i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${esc(name)}</td><td>${cnt}</td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);

    // Account meta line
    try {
      chrome.runtime.sendMessage({ type: 'GET_LIKED_META' }, (resp) => {
        const meta = resp && resp.meta;
        const el = document.getElementById('azLikedAccount');
        if (!meta) { el.textContent = '未同期'; return; }
        const when = new Date(meta.lastSyncedAt || 0).toLocaleString();
        const acc = meta.ownerHandle || meta.ownerName || meta.accountId || '(unknown)';
        el.textContent = `アカウント: ${acc} / 最終同期: ${when} / ${(meta.count || 0).toLocaleString()}件`;
      });
    } catch (_) {}
  }

  function topLikedArtists(limit) {
    const m = buildLikedArtistCount();
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  function renderPrompt(data, chCount) {
    const topic = [...chCount.entries()]
      .filter(([k]) => k.endsWith('- Topic'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40);

    // Credit-based music channel filter: >=5 credited plays AND >=40% credit coverage.
    const { total, credited } = buildChannelMusicScore(data);
    const musicGeneral = [...total.entries()]
      .map(([k, n]) => {
        const c = credited.get(k) || 0;
        return { name: k, plays: n, credited: c, rate: n ? c / n : 0 };
      })
      .filter(x => x.credited >= 5 && x.rate >= 0.4)
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 15);

    // Recent trend: use the most recent 1/3 of the watched time span
    // (data may only cover a few weeks, so a fixed N-day window is unreliable).
    const tsList = data.map(d => d.watchedAt || d.firstWatchedAt || 0).filter(t => t > 0);
    let topicRecent = [];
    if (tsList.length) {
      const maxTs = Math.max(...tsList);
      const minTs = Math.min(...tsList);
      const span = maxTs - minTs;
      const cutoff = span > 0 ? maxTs - span / 3 : 0;
      const recentCh = new Map();
      for (const d of data) {
        if (!d.channel || !d.channel.endsWith(' - Topic')) continue;
        const ts = d.watchedAt || d.firstWatchedAt || 0;
        if (ts < cutoff) continue;
        recentCh.set(d.channel, (recentCh.get(d.channel) || 0) + 1);
      }
      topicRecent = [...recentCh.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
    }

    // Composers / arrangers (topic + general combined)
    const composers = topCredits(data, 'composer', 'all', 20);
    const arrangers = topCredits(data, 'arranger', 'all', 10);

    const lines = [];
    lines.push('以下は私のYouTube視聴履歴から抽出した、音楽嗜好データです。');
    lines.push('');
    lines.push('## 再生数Top40アーティスト（YouTube Topicチャンネル由来）');
    topic.forEach(([k, v], i) => lines.push(`${i + 1}. ${k.replace(/ - Topic$/, '')} (${v}回)`));
    lines.push('');
    if (topicRecent.length) {
      lines.push('## 直近の傾向 Top15（視聴期間の後半1/3）');
      topicRecent.forEach(([k, v], i) => lines.push(`${i + 1}. ${k.replace(/ - Topic$/, '')} (${v}回)`));
      lines.push('');
    }
    lines.push('## よく聴いた作曲家 Top20（クレジット集計）');
    composers.forEach(([name, v], i) => {
      const rate = v.count ? Math.round(v.self / v.count * 100) : 0;
      const selfTag = v.self ? `, 自編曲率${rate}%` : '';
      lines.push(`${i + 1}. ${name} (${v.count}回${selfTag})`);
    });
    lines.push('');
    lines.push('## よく聴いた編曲家 Top10');
    arrangers.forEach(([name, v], i) => lines.push(`${i + 1}. ${name} (${v.count}回)`));
    lines.push('');
    const liked = topLikedArtists(30);
    if (liked.length) {
      lines.push('## 高評価Top30アーティスト（YouTubeで高評価した動画のチャンネル別集計）');
      liked.forEach(([k, v], i) => lines.push(`${i + 1}. ${k.replace(/ - Topic$/, '')} (${v}回)`));
      lines.push('');
    }
    if (musicGeneral.length) {
      lines.push('## 音楽系の一般チャンネル Top15（クレジット紐づき率40%以上）');
      musicGeneral.forEach((x, i) => {
        const pct = Math.round(x.rate * 100);
        lines.push(`${i + 1}. ${x.name} (${x.plays}回, クレジット率${pct}%)`);
      });
      lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push('上記の傾向（アーティスト・作曲家・編曲家の偏り、自編曲率、直近トレンド、高評価アーティスト）を分析し、');
    lines.push('「次に聴くべきアーティスト/作曲家」を10名推薦してください。');
    lines.push('');
    lines.push('### 制約');
    lines.push('- 上記リストに既出の人物・チャンネルは推薦から**除外**してください（既に聴いています）');
    lines.push('- 作曲家・編曲家など裏方クレジットの人物も推薦対象に含めてOK');
    lines.push('- 直近6ヶ月のトレンドを優先的に踏まえてください');
    lines.push('');
    lines.push('### 各推薦に含める項目');
    lines.push('- アーティスト/作曲家名');
    lines.push('- 代表曲1〜2曲');
    lines.push('- 既存のお気に入りとの関連性（具体的にどの作家・どのアーティストとの近さか）');
    lines.push('- YouTube検索キーワード');
    document.getElementById('azPromptText').textContent = lines.join('\n');
  }

  async function runAnalysis() {
    const data = (typeof allData !== 'undefined' && allData) ? allData : [];
    const chCount = buildChannelCount(data);
    await loadLiked();
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
    renderLikedPanel();
    renderPrompt(data, chCount);

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
    const includeGenCb = document.getElementById('azIncludeGeneral');
    if (includeGenCb) {
      includeGenCb.checked = (currentCreditSource === 'all');
      includeGenCb.onchange = () => {
        currentCreditSource = includeGenCb.checked ? 'all' : 'topic';
        renderCredits(data);
      };
    }
  }

  // Tab switching
  document.querySelectorAll('.az-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.az-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const map = { artists: 'azArtistsPanel', channels: 'azChannelsPanel', keywords: 'azKeywordsPanel', credits: 'azCreditsPanel', liked: 'azLikedPanel', prompt: 'azPromptPanel' };
      Object.values(map).forEach(id => { document.getElementById(id).style.display = 'none'; });
      document.getElementById(map[t.dataset.aztab]).style.display = '';
    });
  });

  // Sync liked playlist button
  const syncLikedBtn = document.getElementById('azSyncLiked');
  if (syncLikedBtn) {
    syncLikedBtn.addEventListener('click', async () => {
      const msg = document.getElementById('azLikedMsg');
      const doSync = (confirm) => new Promise((res) => {
        chrome.runtime.sendMessage({ type: 'SYNC_LIKED', confirmAccountChange: !!confirm }, res);
      });
      msg.textContent = '同期中...';
      syncLikedBtn.disabled = true;
      try {
        let resp = await doSync(false);
        if (resp && !resp.success && resp.reason === 'account-changed') {
          const prev = (resp.previous && (resp.previous.ownerHandle || resp.previous.ownerName)) || resp.previous?.accountId || '(unknown)';
          const cur = resp.current?.ownerHandle || resp.current?.ownerName || resp.current?.accountId || '(unknown)';
          const ok = window.confirm(`アカウントが変更されています:\n旧: ${prev}\n新: ${cur}\nこのまま新アカウントの高評価を追加しますか？\n（旧アカウントのデータは保持されます。クリアしたい場合は別途「Clear」操作を追加予定）`);
          if (!ok) {
            msg.textContent = 'キャンセルしました';
            return;
          }
          resp = await doSync(true);
        }
        if (!resp || !resp.success) {
          const r = resp && resp.reason ? resp.reason : 'unknown';
          msg.textContent = `同期失敗: ${r}（YouTubeタブを開いて再試行してください）`;
          return;
        }
        msg.textContent = `同期完了: 取得${resp.fetched}件 / 新規${resp.added}件`;
        await loadLiked();
        renderLikedPanel();
        // Re-render prompt so the liked section reflects new data
        const data = (typeof allData !== 'undefined' && allData) ? allData : [];
        renderPrompt(data, buildChannelCount(data));
      } catch (e) {
        msg.textContent = '同期エラー: ' + e.message;
      } finally {
        syncLikedBtn.disabled = false;
      }
    });
  }

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
