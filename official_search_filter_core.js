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


  const PREVIEW_CREDITS_MAX_VIDEOS = 20;
  const PREVIEW_CREDITS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const PREVIEW_CREDITS_STOP_REASONS = Object.freeze([
    'sorry-redirect',
    'consent-redirect',
  ]);

  function sanitizePreviewVideoIds(videoIds) {
    const unique = [];
    const seen = new Set();
    for (const value of Array.isArray(videoIds) ? videoIds : []) {
      const videoId = String(value ?? '').trim();
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      unique.push(videoId);
      if (unique.length >= PREVIEW_CREDITS_MAX_VIDEOS) break;
    }
    return unique;
  }

  function emptyPreviewCredits() {
    return { composer: '', lyricist: '', arranger: '', creditsRaw: '' };
  }

  function normalizePreviewCredits(value) {
    const normalized = emptyPreviewCredits();
    for (const role of Object.keys(normalized)) {
      normalized[role] = String(value?.[role] ?? '').trim();
    }
    return normalized;
  }

  function previewEvidence(source, credits) {
    const labels = {
      composer: 'composer',
      lyricist: 'lyricist',
      arranger: 'arranger',
      creditsRaw: 'unassigned',
    };
    return Object.keys(labels)
      .filter((role) => credits[role])
      .map((role) => ({
        source,
        role,
        value: credits[role],
        rawLine: `${labels[role]}: ${credits[role]}`,
      }));
  }

  function mergePreviewCredits(primary, fallback) {
    const merged = normalizePreviewCredits(primary);
    for (const role of ['composer', 'lyricist', 'arranger']) {
      if (!merged[role]) merged[role] = String(fallback?.[role] ?? '').trim();
    }
    return merged;
  }

  function createPreviewCreditsService({
    fetchYouTubeCredits,
    lookupMusicBrainz,
    readCache = async () => ({}),
    writeCache = async () => {},
    now = () => Date.now(),
    cacheTtlMs = PREVIEW_CREDITS_CACHE_TTL_MS,
  } = {}) {
    if (typeof fetchYouTubeCredits !== 'function') {
      throw new TypeError('fetchYouTubeCredits is required');
    }

    let activeJob = null;

    function cancel() {
      if (!activeJob) return false;
      activeJob.abortSignal.aborted = true;
      return true;
    }

    async function start({
      videoIds,
      options = {},
      explicitUserAction = false,
      onProgress,
    } = {}) {
      if (explicitUserAction !== true) {
        return { ok: false, reason: 'explicit-user-action-required' };
      }
      if (activeJob) return { ok: false, reason: 'already-running' };

      const limitedVideoIds = sanitizePreviewVideoIds(videoIds);
      const abortSignal = { aborted: false };
      const job = { abortSignal };
      activeJob = job;
      const results = {};
      let processed = 0;
      let autoStopped = false;
      let cache = {};

      try {
        const loaded = await readCache();
        cache = loaded && typeof loaded === 'object' && !Array.isArray(loaded)
          ? { ...loaded }
          : {};

        for (const videoId of limitedVideoIds) {
          if (abortSignal.aborted || autoStopped) break;
          const cached = cache[videoId];
          if (
            cached &&
            Number(cached.checkedAt) > 0 &&
            now() - Number(cached.checkedAt) < cacheTtlMs &&
            cached.result
          ) {
            results[videoId] = { ...cached.result, cached: true };
            const cachedErrorKind = String(cached.result?.error?.kind || '');
            if (PREVIEW_CREDITS_STOP_REASONS.includes(cachedErrorKind)) autoStopped = true;
          } else {
            const youtube = await fetchYouTubeCredits(videoId, abortSignal);
            if (youtube?.aborted || abortSignal.aborted) break;

            let result;
            if (!youtube?.ok) {
              const reason = String(youtube?.reason || 'fetch-error');
              result = {
                status: 'error',
                credits: emptyPreviewCredits(),
                evidence: [],
                error: { kind: reason, message: String(youtube?.error || '') },
              };
              if (PREVIEW_CREDITS_STOP_REASONS.includes(reason)) autoStopped = true;
            } else {
              const youtubeCredits = normalizePreviewCredits(youtube.credits);
              let credits = youtubeCredits;
              let evidence = previewEvidence('youtube', youtubeCredits);
              let mbReason = '';
              if (
                Array.isArray(options.sources) &&
                options.sources.includes('musicbrainz') &&
                typeof lookupMusicBrainz === 'function' &&
                youtube.artist && youtube.title &&
                ['composer', 'lyricist', 'arranger'].some((role) => !credits[role])
              ) {
                try {
                  const mb = await lookupMusicBrainz(youtube.artist, youtube.title);
                  if (abortSignal.aborted) break;
                  if (mb?.success && mb.candidate) {
                    const mbCredits = normalizePreviewCredits(mb.candidate);
                    credits = mergePreviewCredits(credits, mbCredits);
                    evidence = evidence.concat(previewEvidence('musicbrainz', mbCredits));
                  } else {
                    mbReason = String(mb?.reason || 'no-result');
                  }
                } catch (_error) {
                  mbReason = 'fetch-error';
                }
              }
              const roleCount = ['composer', 'lyricist', 'arranger']
                .filter((role) => credits[role]).length;
              result = {
                status: roleCount === 3 ? 'complete' : (evidence.length ? 'partial' : 'not-found'),
                credits,
                evidence,
                ...(mbReason ? { error: { kind: mbReason, source: 'musicbrainz' } } : {}),
              };
            }

            results[videoId] = result;
            cache[videoId] = { checkedAt: now(), result };
            await writeCache(cache);
          }

          processed += 1;
          if (typeof onProgress === 'function') {
            onProgress({ videoId, processed, total: limitedVideoIds.length, result: results[videoId] });
          }
        }

        return {
          ok: true,
          results,
          total: limitedVideoIds.length,
          processed,
          aborted: abortSignal.aborted,
          autoStopped,
          persistToHistory: false,
        };
      } finally {
        if (activeJob === job) activeJob = null;
      }
    }

    return Object.freeze({ start, cancel, isRunning: () => Boolean(activeJob) });
  }

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

  function splitJapaneseMiddleDot(value) {
    const normalized = normalizeText(value);
    if (!normalized || !normalized.includes('・')) {
      return normalized ? [normalized] : [];
    }

    const parts = normalized
      .split(/・+/)
      .map(normalizeText)
      .filter(Boolean);
    const shouldSplit = parts.length > 1 && parts.every((part) => {
      const compact = part.replace(/\s+/g, '');
      return (
        [...compact].length >= 2 &&
        !/^[\p{Script=Katakana}\u30FC]+$/u.test(compact)
      );
    });

    return shouldSplit ? parts : [normalized];
  }

  function splitCreditValue(value) {
    const normalized = String(value ?? '')
      .split(/[\n,，、;；/／&＆]+|\s+·\s+/)
      .flatMap(splitJapaneseMiddleDot)
      .filter(Boolean);
    return [...new Set(normalized)];
  }

  function matchCreditAliases(value, creditAliases) {
    const aliases = new Set(normalizeCreditAliases(creditAliases));
    if (aliases.size === 0) return [];
    return splitCreditValue(value)
      .filter((part) => aliases.has(part));
  }

  // 遷移・保存に使う正規化。大文字小文字を保持する。
  // チャンネルID（/channel/UC...）は case-sensitive で、小文字化すると 404 になる（実測）。
  // ハンドル（/@Name）は case-insensitive だが、表示のため原文の字面を保つ。
  function canonicalChannelPath(value) {
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

    return normalized;
  }

  // 突き合わせ専用の正規化。比較キーなので小文字へ畳む。
  // ⚠️ この戻り値を URL やチャンネルIDの実体として使わないこと（用途を取り違えると
  // /channel/UC... が 404 になる。2026-07-30 の実害）。
  function normalizeChannelPath(value) {
    return canonicalChannelPath(value).toLowerCase();
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
      creditsRaw: '未割当',
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
    PREVIEW_CREDITS_MAX_VIDEOS,
    PREVIEW_CREDITS_CACHE_TTL_MS,
    PREVIEW_CREDITS_STOP_REASONS,
    sanitizePreviewVideoIds,
    createPreviewCreditsService,
    normalizeText,
    normalizeCreditAliases,
    matchCreditAliases,
    normalizeChannelPath,
    canonicalChannelPath,
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
