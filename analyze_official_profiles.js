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

  // settings（保存済みプロフィール・除外リスト）で候補を仕分ける。
  // 登録済み・除外済みは一覧から外す＝二重登録とノイズを構造的に防ぐ。
  function partitionCandidates(candidates, settings, storeApi) {
    const list = Array.isArray(candidates) ? candidates : [];
    const exclusions = new Set(
      (settings?.candidateExclusions || []).map((name) => String(name).trim())
    );
    const registeredProfileId = typeof storeApi?.findRegisteredProfileId === 'function'
      ? (candidate) => storeApi.findRegisteredProfileId(settings, candidate)
      : () => null;
    const normalizeText = (value) => String(value ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .trim();
    const profileNeedsRepair = (profileId, candidate) => {
      const profile = settings?.profiles?.[profileId];
      const channels = Array.isArray(profile?.channels) ? profile.channels : [];
      const unresolved = channels.filter((channel) =>
        channel.channelIdMigration === 'unresolved-lowercase'
      );
      if (!unresolved.length) return false;

      const channelKey = normalizeText(candidate?.channelName);
      const sourceMatches = channels.filter((channel) =>
        channelKey && normalizeText(channel.sourceChannelName) === channelKey
      );
      if (sourceMatches.length) {
        return sourceMatches.some((channel) =>
          channel.channelIdMigration === 'unresolved-lowercase'
        );
      }
      const displayMatches = channels.filter((channel) =>
        channelKey && normalizeText(channel.displayName) === channelKey
      );
      if (displayMatches.length) {
        return displayMatches.some((channel) =>
          channel.channelIdMigration === 'unresolved-lowercase'
        );
      }

      // v1.43.7 以前の単一チャンネル profile は sourceChannelName を持たない。
      // profile 表示名による登録済み判定と同じ場合に限り、その1件を対応先とみなす。
      return channels.length === 1 &&
        normalizeText(profile?.displayName) === normalizeText(candidate?.profileName) &&
        unresolved[0] === channels[0];
    };

    const visible = [];
    const registered = [];
    const excluded = [];
    const needsRepair = [];
    for (const candidate of list) {
      if (exclusions.has(String(candidate.channelName).trim())) {
        excluded.push(candidate);
      } else {
        const profileId = registeredProfileId(candidate);
        if (profileId && profileNeedsRepair(profileId, candidate)) {
          needsRepair.push({ ...candidate, needsRepair: true });
        } else if (profileId) {
          registered.push(candidate);
        } else {
          visible.push(candidate);
        }
      }
    }
    return { visible, registered, excluded, needsRepair };
  }

  function renderCandidateRows(container, candidates, handlers, summary) {
    const onReview = typeof handlers === 'function' ? handlers : handlers?.onReview;
    const onExclude = typeof handlers === 'function' ? null : handlers?.onExclude;
    container.textContent = '';
    if (!candidates.length) {
      const hiddenCount =
        (summary?.registeredCount || 0) + (summary?.excludedCount || 0);
      const repairCount = summary?.needsRepairCount || 0;
      appendText(
        container,
        'p',
        'az-official-empty',
        hiddenCount || repairCount
          ? `未登録の候補はありません（要修復 ${repairCount} 件、登録済み ${summary?.registeredCount || 0} 件・除外 ${summary?.excludedCount || 0} 件は非表示）。`
          : '現在の集計には公式プロファイル候補がありません。'
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
      if (candidate.needsRepair === true) {
        appendText(
          summary,
          'span',
          'az-official-badge',
          '要修復: 旧形式のチャンネルIDです'
        );
      }
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

      if (onExclude) {
        const exclude = container.ownerDocument.createElement('button');
        exclude.type = 'button';
        exclude.className = 'sort-btn';
        exclude.textContent = '候補から外す';
        exclude.title = '複数アーティストが混ざるチャンネルなど、候補に出したくないものを隠します（あとで戻せます）';
        exclude.dataset.officialExclude = candidate.channelName;
        exclude.addEventListener('click', () => onExclude(candidate));
        row.appendChild(exclude);
      }

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
    partitionCandidates,
    stripTopicSuffix,
  });

  globalThis.YWHAnalyzeOfficialProfiles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
