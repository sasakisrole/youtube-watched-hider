(() => {
  'use strict';

  const CATEGORY = Object.freeze({
    OFFICIAL: 'official',
    CREDIT_RELATED: 'credit-related',
    OTHER_TOPIC: 'other-topic',
    OTHER: 'other',
    PENDING: 'pending',
  });

  const MODE = Object.freeze({
    OFFICIAL: 'official',
    DISCOVERY: 'discovery',
    ALL: 'all',
  });

  function normalizeText(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeCreditAliases(values) {
    const aliases = [];
    const seen = new Set();

    for (const value of Array.isArray(values) ? values : []) {
      const normalized = normalizeText(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      aliases.push(normalized);
    }

    return aliases;
  }

  function splitCreditValue(value) {
    const normalized = String(value ?? '')
      .split(/[\n,，、;；/／&＆]+/)
      .map(normalizeText)
      .filter(Boolean);
    return [...new Set(normalized)];
  }

  function matchCreditAliases(value, creditAliases) {
    const aliases = new Set(normalizeCreditAliases(creditAliases));
    if (aliases.size === 0) return [];
    return splitCreditValue(value)
      .filter((part) => aliases.has(part));
  }

  function normalizeChannelPath(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';

    let pathname = raw;

    try {
      pathname = new URL(raw, 'https://www.youtube.com').pathname;
    } catch {
      pathname = raw.split(/[?#]/, 1)[0];
    }

    let normalized = pathname
      .normalize('NFKC')
      .trim()
      .replace(/\/+/g, '/');

    if (!normalized.startsWith('/')) {
      normalized = `/${normalized}`;
    }

    if (normalized.length > 1) {
      normalized = normalized.replace(/\/+$/, '');
    }

    return normalized.toLowerCase();
  }

  function isTopicChannel(channelName) {
    const text = String(channelName ?? '')
      .normalize('NFKC')
      .trim();

    return /\s[-–—]\sTopic$/i.test(text);
  }

  function isSameChannel(saved, current) {
    if (!saved || !current) return false;

    const savedId = String(saved.channelId ?? '').trim();
    const currentId = String(current.channelId ?? '').trim();

    // 両方にIDがある場合、IDが最優先。
    // IDが違うのに名前やpathだけで同一扱いしない。
    if (savedId && currentId) {
      return savedId === currentId;
    }

    const savedPath = normalizeChannelPath(saved.canonicalPath);
    const currentPath = normalizeChannelPath(current.canonicalPath);

    return Boolean(
      savedPath &&
      currentPath &&
      savedPath === currentPath
    );
  }

  function getProfiles(settings) {
    return Object.values(settings?.profiles || {})
      .filter((profile) => profile && profile.id);
  }

  function matchProfileForQuery(settings, query) {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) return null;

    const directId =
      settings?.queryBindings?.[normalizedQuery];

    if (directId && settings?.profiles?.[directId]) {
      return settings.profiles[directId];
    }

    const profiles = getProfiles(settings);

    // エイリアス完全一致を優先
    for (const profile of profiles) {
      const aliases = [
        profile.displayName,
        ...(profile.aliases || []),
      ];

      if (
        aliases.some(
          (alias) =>
            normalizeText(alias) === normalizedQuery
        )
      ) {
        return profile;
      }
    }

    // その後、最長エイリアスの部分一致。
    // 短すぎる別名は誤判定しやすいので4文字未満を除外。
    const candidates = [];

    for (const profile of profiles) {
      const aliases = [
        profile.displayName,
        ...(profile.aliases || []),
      ];

      for (const alias of aliases) {
        const normalizedAlias = normalizeText(alias);

        if (normalizedAlias.length < 4) continue;
        if (!normalizedQuery.includes(normalizedAlias)) continue;

        candidates.push({
          profile,
          matchedAlias: normalizedAlias,
        });
      }
    }

    candidates.sort(
      (a, b) =>
        b.matchedAlias.length - a.matchedAlias.length
    );

    return candidates[0]?.profile || null;
  }

  function classifyChannel({
    channel,
    profile,
    hasRelatedCredit = false,
  }) {
    if (!channel) {
      return CATEGORY.PENDING;
    }

    const enabledChannels =
      (profile?.channels || [])
        .filter((item) => item?.enabled !== false);

    const isRegistered =
      enabledChannels.some(
        (saved) => isSameChannel(saved, channel)
      );

    if (isRegistered) {
      return CATEGORY.OFFICIAL;
    }

    if (hasRelatedCredit) {
      return CATEGORY.CREDIT_RELATED;
    }

    if (isTopicChannel(channel.displayName)) {
      return CATEGORY.OTHER_TOPIC;
    }

    return CATEGORY.OTHER;
  }

  function shouldShowCategory(category, mode) {
    if (mode === MODE.ALL) {
      return true;
    }

    if (mode === MODE.DISCOVERY) {
      return (
        category === CATEGORY.OFFICIAL ||
        category === CATEGORY.CREDIT_RELATED ||
        category === CATEGORY.OTHER_TOPIC ||
        category === CATEGORY.PENDING
      );
    }

    return (
      category === CATEGORY.OFFICIAL ||
      category === CATEGORY.CREDIT_RELATED ||
      category === CATEGORY.PENDING
    );
  }

  function candidateChannelKey(channel) {
    const channelId = String(channel?.channelId ?? '').trim();
    if (channelId) return `id:${channelId}`;
    const path = normalizeChannelPath(channel?.canonicalPath);
    return path ? `path:${path}` : '';
  }

  function inferCreditChannelCandidates({
    items,
    creditsByVideoId,
    creditAliases,
  } = {}) {
    const aliases = normalizeCreditAliases(creditAliases);
    if (aliases.length === 0) {
      return { candidates: [], relatedVideoIds: [] };
    }

    const roleLabels = {
      composer: '作曲',
      lyricist: '作詞',
      arranger: '編曲',
    };
    const byChannel = new Map();
    const relatedVideoIds = new Set();

    for (const item of Array.isArray(items) ? items : []) {
      const videoId = String(item?.videoId ?? '').trim();
      if (!videoId) continue;
      const credits = creditsByVideoId?.[videoId];
      if (!credits || typeof credits !== 'object') continue;

      const matches = [];
      for (const role of Object.keys(roleLabels)) {
        const matchedAliases = matchCreditAliases(credits[role], aliases);
        for (const alias of matchedAliases) {
          matches.push({
            role,
            alias,
            creditValue: String(credits[role] ?? '').trim(),
          });
        }
      }
      if (matches.length === 0) continue;
      relatedVideoIds.add(videoId);

      const channel = item.channel;
      const key = candidateChannelKey(channel);
      if (!key) continue;

      let candidate = byChannel.get(key);
      if (!candidate) {
        candidate = {
          channel: {
            ...(String(channel.channelId ?? '').trim()
              ? { channelId: String(channel.channelId).trim() }
              : {}),
            canonicalPath: normalizeChannelPath(channel.canonicalPath),
            displayName: String(channel.displayName ?? '').trim(),
            enabled: true,
          },
          reasons: [],
          matchedVideoIds: [],
        };
        byChannel.set(key, candidate);
      }

      if (!candidate.matchedVideoIds.includes(videoId)) {
        candidate.matchedVideoIds.push(videoId);
      }
      for (const match of matches) {
        const reason =
          `${roleLabels[match.role]}クレジット「${match.creditValue}」が` +
          `別名「${match.alias}」と正規化一致（動画 ${videoId}）`;
        if (!candidate.reasons.includes(reason)) {
          candidate.reasons.push(reason);
        }
      }
    }

    return {
      candidates: [...byChannel.values()],
      relatedVideoIds: [...relatedVideoIds],
    };
  }

  function adoptCreditCandidate({
    candidate,
    userAccepted = false,
    register,
  } = {}) {
    if (
      userAccepted !== true ||
      !candidate?.channel ||
      typeof register !== 'function'
    ) {
      return false;
    }
    register(candidate.channel);
    return true;
  }

  const api = Object.freeze({
    CATEGORY,
    MODE,
    normalizeText,
    normalizeCreditAliases,
    matchCreditAliases,
    normalizeChannelPath,
    isTopicChannel,
    isSameChannel,
    matchProfileForQuery,
    classifyChannel,
    shouldShowCategory,
    inferCreditChannelCandidates,
    adoptCreditCandidate,
  });

  globalThis.YWHOfficialSearchFilterCore = api;

  if (
    typeof module !== 'undefined' &&
    module.exports
  ) {
    module.exports = api;
  }
})();
