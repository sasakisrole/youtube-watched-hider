(() => {
  'use strict';

  const core = globalThis.YWHOfficialSearchFilterCore ||
    (typeof require === 'function'
      ? require('./official_search_filter_core.js')
      : null);

  if (!core || typeof core.isTopicChannel !== 'function') return;

  const OFFICIAL_MIN_CREDITED = 5;
  const OFFICIAL_MIN_CREDIT_RATE = 0.4;

  function stripTopicSuffix(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .replace(/\s[-–—]\sTopic$/i, '')
      .trim();
  }

  function hasCredits(record) {
    return Boolean(
      record?.composer ||
      record?.lyricist ||
      record?.arranger
    );
  }

  function buildCandidates(records) {
    const grouped = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      const channelName = String(record?.channel ?? '').trim();
      if (!channelName) continue;
      const current = grouped.get(channelName) || {
        channelName,
        plays: 0,
        credited: 0,
        sampleVideoId: '',
      };
      current.plays += 1;
      if (hasCredits(record)) current.credited += 1;
      if (!current.sampleVideoId && record.videoId) {
        current.sampleVideoId = String(record.videoId);
      }
      grouped.set(channelName, current);
    }

    const candidates = [];
    for (const aggregate of grouped.values()) {
      const topic = core.isTopicChannel(aggregate.channelName);
      const creditRate = aggregate.plays
        ? aggregate.credited / aggregate.plays
        : 0;
      const officialCandidate = !topic &&
        aggregate.credited >= OFFICIAL_MIN_CREDITED &&
        creditRate >= OFFICIAL_MIN_CREDIT_RATE;
      if (!topic && !officialCandidate) continue;

      candidates.push({
        ...aggregate,
        kind: topic ? 'topic' : 'official-candidate',
        profileName: topic
          ? stripTopicSuffix(aggregate.channelName)
          : aggregate.channelName,
        creditRate,
        evidence: topic
          ? 'YouTube の「- Topic」チャンネル名'
          : `クレジット付き ${aggregate.credited}/${aggregate.plays} 件`,
      });
    }

    return candidates.sort((a, b) =>
      b.plays - a.plays ||
      a.channelName.localeCompare(b.channelName, 'ja')
    );
  }

  function isSupportedChannelPath(path) {
    return /^\/(?:channel\/[^/]+|@[^/]+|c\/[^/]+|user\/[^/]+)$/i.test(path);
  }

  function channelFromInput(value, displayName) {
    const raw = String(value ?? '').trim();
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
      try {
        const hostname = new URL(raw).hostname.toLowerCase();
        if (hostname !== 'youtube.com' && !hostname.endsWith('.youtube.com')) {
          return null;
        }
      } catch {
        return null;
      }
    }
    // ⚠️ 比較用の normalizeChannelPath（小文字化）を使わない。ここで作る値は
    // 「リンク先URL」と「保存するチャンネルID」の実体になるので、字面を保つ必要がある
    // （/channel/UC... を小文字化すると YouTube が 404 を返しトップへ戻る・2026-07-30 実測）。
    const canonicalPath = typeof core.canonicalChannelPath === 'function'
      ? core.canonicalChannelPath(raw)
      : core.normalizeChannelPath(raw);
    if (!isSupportedChannelPath(canonicalPath)) return null;
    const idMatch = canonicalPath.match(/^\/channel\/([^/]+)$/i);
    return {
      ...(idMatch ? { channelId: idMatch[1] } : {}),
      canonicalPath,
      displayName: String(displayName ?? '').trim(),
      enabled: true,
    };
  }

  async function resolveCandidateChannel(candidate, fetchImpl = globalThis.fetch) {
    if (!candidate?.sampleVideoId || typeof fetchImpl !== 'function') {
      return null;
    }
    const videoUrl = 'https://www.youtube.com/watch?v=' +
      encodeURIComponent(candidate.sampleVideoId);
    const endpoint = 'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent(videoUrl);
    const response = await fetchImpl(endpoint);
    if (!response?.ok) throw new Error(`oEmbed HTTP ${response?.status || 0}`);
    const payload = await response.json();
    return channelFromInput(
      payload?.author_url,
      payload?.author_name || candidate.channelName
    );
  }

  function appendText(parent, tagName, className, text) {
    const element = parent.ownerDocument.createElement(tagName);
    element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function renderCandidateRows(container, candidates, onReview) {
    container.textContent = '';
    if (!candidates.length) {
      appendText(
        container,
        'p',
        'az-official-empty',
        '現在の集計には公式プロファイル候補がありません。'
      );
      return 0;
    }

    for (const candidate of candidates) {
      const row = container.ownerDocument.createElement('div');
      row.className = 'az-official-candidate';
      row.dataset.candidateKind = candidate.kind;
      const summary = container.ownerDocument.createElement('div');
      appendText(summary, 'strong', '', candidate.profileName);
      appendText(
        summary,
        'span',
        'az-official-badge',
        candidate.kind === 'topic' ? 'Topic候補' : '公式候補'
      );
      appendText(
        summary,
        'span',
        'az-official-evidence',
        `${candidate.evidence}・再生 ${candidate.plays} 件`
      );
      row.appendChild(summary);

      const button = container.ownerDocument.createElement('button');
      button.type = 'button';
      button.className = 'sort-btn';
      button.textContent = '登録内容を確認';
      button.dataset.officialReview = candidate.channelName;
      button.addEventListener('click', () => onReview?.(candidate));
      row.appendChild(button);
      container.appendChild(row);
    }
    return candidates.length;
  }

  const api = Object.freeze({
    OFFICIAL_MIN_CREDITED,
    OFFICIAL_MIN_CREDIT_RATE,
    buildCandidates,
    channelFromInput,
    resolveCandidateChannel,
    renderCandidateRows,
    stripTopicSuffix,
  });

  globalThis.YWHAnalyzeOfficialProfiles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
