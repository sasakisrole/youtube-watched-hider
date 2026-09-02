(() => {
  'use strict';

  const core = globalThis.YWHOfficialSearchFilterCore;
  const profileStore = globalThis.YWHOfficialProfileStore || null;

  if (
    !core ||
    typeof core.classifyChannel !== 'function' ||
    typeof core.shouldShowCategory !== 'function' ||
    typeof core.normalizeChannelPath !== 'function' ||
    typeof core.normalizeText !== 'function' ||
    typeof core.normalizeCreditAliases !== 'function' ||
    typeof core.inferCreditChannelCandidates !== 'function' ||
    typeof core.adoptCreditCandidate !== 'function'
  ) {
    return;
  }

  const {
    CATEGORY,
    MODE,
    adoptCreditCandidate,
    classifyChannel,
    inferCreditChannelCandidates,
    normalizeChannelPath,
    normalizeCreditAliases,
    normalizeText,
    shouldShowCategory,
  } = core;

  const PANEL_ID = 'ywh-osf-panel';
  const HIDDEN_CLASS = 'ywh-osf-hidden';
  const STORAGE_KEY = 'officialSearchFilter';
  const SETTINGS_SCHEMA_VERSION = 1;
  const CARD_SELECTOR =
    'ytd-video-renderer, yt-lockup-view-model';
  const CHANNEL_SELECTOR = [
    'ytd-channel-name a[href]',
    '#channel-name a[href]',
    '.yt-lockup-metadata-view-model__metadata a[href]',
    'a[href^="/channel/"]',
    'a[href^="/@"]',
    'a[href^="/c/"]',
    'a[href^="/user/"]',
  ].join(', ');

  const countLabels = Object.freeze({
    [CATEGORY.OFFICIAL]: '登録済み公式ソース',
    [CATEGORY.CREDIT_RELATED]: 'クレジット関連',
    [CATEGORY.OTHER_TOPIC]: '未登録Topic',
    [CATEGORY.OTHER]: 'その他',
    [CATEGORY.PENDING]: '判定待ち',
  });

  if (globalThis._ywhOfficialSearchFilter) {
    try {
      globalThis._ywhOfficialSearchFilter.cleanup();
    } catch {
      // A stale instance must not prevent a safe re-injection.
    }
  }

  const state = {
    mode: MODE.ALL,
    settings: createDefaultSettings(),
    persistedMode: MODE.ALL,
    loadPromise: null,
    storageChangeGeneration: 0,
    saveQueue: Promise.resolve(),
    observer: null,
    scanTimer: null,
    disposed: false,
    counts: createEmptyCounts(),
    visibleCount: 0,
    pendingChannel: null,
    creditCandidates: [],
    creditRelatedVideoIds: new Set(),
    creditLookupKey: '',
    creditLookupGeneration: 0,
    creditLookupError: '',
    previewVideoIds: [],
    previewCreditsByVideoId: {},
    previewResults: {},
    previewRunning: false,
    previewCancelling: false,
    previewProcessed: 0,
    previewTotal: 0,
    previewMessage: '',
    effectiveProfileId: null,
    currentNormalizedQuery: '',
    temporaryRevealActive: false,
    panelExpanded: false,
  };

  function createDefaultSettings() {
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      activeProfileId: null,
      globalMode: MODE.ALL,
      hideOtherGlobal: false,
      profiles: {},
      queryBindings: {},
    };
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null) return true;
    const constructor = Object.prototype.hasOwnProperty.call(
      prototype,
      'constructor'
    )
      ? prototype.constructor
      : null;
    return (
      typeof constructor === 'function' &&
      constructor.name === 'Object'
    );
  }

  function isValidMode(mode) {
    return mode === MODE.ALL || mode === MODE.OFFICIAL || mode === MODE.DISCOVERY;
  }

  function sanitizeChannel(value) {
    if (!isPlainObject(value)) return null;

    const channelId = String(value.channelId ?? '').trim();
    const canonicalPath = normalizeChannelPath(value.canonicalPath);
    const displayName = String(value.displayName ?? '').trim();
    if (!channelId && !canonicalPath) return null;

    return {
      ...(channelId ? { channelId } : {}),
      ...(canonicalPath ? { canonicalPath } : {}),
      displayName,
      enabled: value.enabled !== false,
    };
  }

  function sanitizeProfiles(value) {
    if (!isPlainObject(value)) return {};

    const profiles = {};
    for (const profileValue of Object.values(value)) {
      if (!isPlainObject(profileValue)) continue;
      const id = String(profileValue.id ?? '').trim();
      if (!id || ['__proto__', 'constructor', 'prototype'].includes(id)) {
        continue;
      }
      const aliases = Array.isArray(profileValue.aliases)
        ? profileValue.aliases
          .filter((alias) => typeof alias === 'string')
          .map((alias) => alias.trim())
          .filter(Boolean)
        : [];
      const channels = [];
      const channelValues = Array.isArray(profileValue.channels)
        ? profileValue.channels.map(sanitizeChannel).filter(Boolean)
        : [];
      for (const channel of channelValues) {
        const duplicateIndex = duplicateChannelIndex(channels, channel);
        if (duplicateIndex >= 0) {
          channels[duplicateIndex] = {
            ...channels[duplicateIndex],
            ...channel,
          };
        } else {
          channels.push(channel);
        }
      }
      profiles[id] = {
        id,
        displayName: String(profileValue.displayName ?? '').trim(),
        aliases,
        channels,
        mode: isValidMode(profileValue.mode)
          ? profileValue.mode
          : MODE.ALL,
      };
    }
    return profiles;
  }

  function sanitizeQueryBindings(value, profiles) {
    if (!isPlainObject(value)) return {};

    const bindings = {};
    const conflicts = new Set();
    for (const [query, profileIdValue] of Object.entries(value)) {
      const normalizedQuery = normalizeText(query);
      const profileId = String(profileIdValue ?? '').trim();
      if (!normalizedQuery || !profiles[profileId]) continue;
      if (
        Object.prototype.hasOwnProperty.call(bindings, normalizedQuery) &&
        bindings[normalizedQuery] !== profileId
      ) {
        delete bindings[normalizedQuery];
        conflicts.add(normalizedQuery);
        continue;
      }
      if (!conflicts.has(normalizedQuery)) {
        bindings[normalizedQuery] = profileId;
      }
    }
    return bindings;
  }

  function sanitizeSettings(value) {
    if (profileStore) return profileStore.sanitizeSettings(value);
    if (
      !isPlainObject(value) ||
      value.schemaVersion !== SETTINGS_SCHEMA_VERSION
    ) {
      return createDefaultSettings();
    }
    const profiles = sanitizeProfiles(value.profiles);
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      activeProfileId:
        value.activeProfileId === null ||
        typeof value.activeProfileId === 'string'
          ? value.activeProfileId
          : null,
      globalMode: isValidMode(value.globalMode)
        ? value.globalMode
        : MODE.ALL,
      hideOtherGlobal:
        typeof value.hideOtherGlobal === 'boolean'
          ? value.hideOtherGlobal
          : false,
      profiles,
      queryBindings: sanitizeQueryBindings(
        value.queryBindings,
        profiles
      ),
    };
  }

  function hasStorageLocal() {
    return Boolean(
      globalThis.chrome?.storage?.local &&
      typeof globalThis.chrome.storage.local.get === 'function' &&
      typeof globalThis.chrome.storage.local.set === 'function'
    );
  }

  function getRuntimeLastError() {
    try {
      return globalThis.chrome?.runtime?.lastError || null;
    } catch {
      return null;
    }
  }

  function storageLocalGet() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        const lastError = getRuntimeLastError();
        if (lastError) reject(new Error(lastError.message || 'Storage read failed'));
        else resolve(result || {});
      };
      try {
        const pending = globalThis.chrome.storage.local.get(STORAGE_KEY, finish);
        if (pending?.then) {
          pending.then(finish, (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
        }
      } catch (error) {
        settled = true;
        reject(error);
      }
    });
  }

  function storageLocalSet(settings) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const lastError = getRuntimeLastError();
        if (lastError) reject(new Error(lastError.message || 'Storage write failed'));
        else resolve();
      };
      try {
        const pending = globalThis.chrome.storage.local.set(
          { [STORAGE_KEY]: settings },
          finish
        );
        if (pending?.then) {
          pending.then(finish, (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
        }
      } catch (error) {
        settled = true;
        reject(error);
      }
    });
  }

  function createEmptyCounts() {
    return {
      [CATEGORY.OFFICIAL]: 0,
      [CATEGORY.CREDIT_RELATED]: 0,
      [CATEGORY.OTHER_TOPIC]: 0,
      [CATEGORY.OTHER]: 0,
      [CATEGORY.PENDING]: 0,
    };
  }

  function isSearchPage() {
    return location.pathname === '/results';
  }

  function getSearchVideoCards() {
    if (!document?.querySelectorAll) return [];

    const candidates = [...document.querySelectorAll(CARD_SELECTOR)];
    const cards = [];

    for (const card of candidates) {
      if (card.querySelector?.('a[href*="/watch?v="]')) {
        cards.push(card);
      } else {
        // A reused/partially rendered non-video card must not stay hidden.
        card.classList.remove(HIDDEN_CLASS);
      }
    }

    return cards;
  }

  function getChannelIdentityFromCard(card) {
    const links = card.querySelectorAll?.(CHANNEL_SELECTOR) || [];

    for (const link of links) {
      const rawHref =
        link.getAttribute?.('href') ||
        link.href ||
        '';
      let url;

      try {
        url = new URL(rawHref, location.origin);
      } catch {
        continue;
      }

      const path = url.pathname.replace(/\/+$/, '');
      const isChannelPath =
        /^\/channel\/[^/]+$/i.test(path) ||
        /^\/@[^/]+$/i.test(path) ||
        /^\/c\/[^/]+$/i.test(path) ||
        /^\/user\/[^/]+$/i.test(path);

      if (!isChannelPath) continue;

      const idMatch = path.match(/^\/channel\/(UC[\w-]+)$/i);
      const displayName = String(
        link.textContent ||
        link.getAttribute?.('aria-label') ||
        link.getAttribute?.('title') ||
        ''
      ).trim();

      return {
        channelId: idMatch?.[1] || '',
        canonicalPath: path,
        displayName,
      };
    }

    return null;
  }

  function getVideoIdFromCard(card) {
    const links = card.querySelectorAll?.('a[href*="/watch?v="]') || [];
    for (const link of links) {
      const rawHref = link.getAttribute?.('href') || link.href || '';
      try {
        const videoId = new URL(rawHref, location.origin)
          .searchParams.get('v');
        if (videoId) return videoId;
      } catch {
        // Ignore malformed result links.
      }
    }
    return '';
  }

  function dbRpc(op, payload = {}) {
    return new Promise((resolve, reject) => {
      const sendMessage = globalThis.chrome?.runtime?.sendMessage;
      if (typeof sendMessage !== 'function') {
        reject(new Error('DB RPC unavailable'));
        return;
      }
      try {
        sendMessage.call(
          globalThis.chrome.runtime,
          { type: 'DB_RPC', op, ...payload },
          (response) => {
            const lastError = globalThis.chrome?.runtime?.lastError;
            if (lastError) {
              reject(new Error(lastError.message));
              return;
            }
            if (!response?.success) {
              reject(new Error(response?.error || 'DB RPC failed'));
              return;
            }
            resolve(response.result);
          }
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      const sendMessage = globalThis.chrome?.runtime?.sendMessage;
      if (typeof sendMessage !== 'function') {
        reject(new Error('runtime messaging unavailable'));
        return;
      }
      try {
        sendMessage.call(globalThis.chrome.runtime, message, (response) => {
          const lastError = globalThis.chrome?.runtime?.lastError;
          if (lastError) reject(new Error(lastError.message));
          else resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function startPreviewCredits() {
    if (state.previewRunning) return;
    const videoIds = state.previewVideoIds.slice(0, core.PREVIEW_CREDITS_MAX_VIDEOS || 20);
    if (videoIds.length === 0) return;
    state.previewRunning = true;
    state.previewCancelling = false;
    state.previewProcessed = 0;
    state.previewTotal = videoIds.length;
    state.previewMessage = 'クレジットを確認しています。';
    renderPanelState();
    try {
      const response = await runtimeMessage({
        type: 'PREVIEW_VIDEO_CREDITS',
        videoIds,
        options: {
          sources: ['youtube', 'musicbrainz'],
          persistToHistory: false,
          userInitiated: true,
        },
      });
      if (!response?.ok) {
        state.previewMessage = response?.reason === 'already-running'
          ? '別のクレジット確認が実行中です。'
          : `確認できませんでした: ${response?.reason || 'unknown'}`;
        return;
      }
      state.previewResults = response.results || {};
      for (const [videoId, result] of Object.entries(state.previewResults)) {
        if (result?.credits) state.previewCreditsByVideoId[videoId] = result.credits;
      }
      state.previewProcessed = Number(response.processed) || 0;
      state.previewTotal = Number(response.total) || videoIds.length;
      state.previewMessage = response.autoStopped
        ? 'YouTubeの異常応答を検出したため停止しました。'
        : response.aborted
          ? 'クレジット確認を中止しました。'
          : 'クレジット確認が完了しました。';
      state.creditLookupKey = '';
      scanSearchResults();
    } catch (error) {
      state.previewMessage = `確認できませんでした: ${error.message}`;
    } finally {
      state.previewRunning = false;
      state.previewCancelling = false;
      renderPanelState();
    }
  }

  async function cancelPreviewCredits() {
    if (!state.previewRunning || state.previewCancelling) return;
    state.previewCancelling = true;
    state.previewMessage = '中止を要求しています。';
    renderPanelState();
    try {
      await runtimeMessage({ type: 'CANCEL_PREVIEW_VIDEO_CREDITS' });
    } catch (_error) {
      state.previewMessage = '中止要求を送信できませんでした。';
      state.previewCancelling = false;
      renderPanelState();
    }
  }

  function refreshCreditCandidates(cards, candidateProfile, relatedProfile) {
    const candidateAliases = normalizeCreditAliases([
      candidateProfile?.displayName,
      ...(candidateProfile?.aliases || []),
    ]);
    const relatedAliases = normalizeCreditAliases([
      relatedProfile?.displayName,
      ...(relatedProfile?.aliases || []),
    ]);
    const items = cards.map((card) => ({
      videoId: getVideoIdFromCard(card),
      channel: getChannelIdentityFromCard(card),
    })).filter((item) => item.videoId);
    const videoIds = [...new Set(items.map((item) => item.videoId))].sort();
    const itemSignatures = items.map((item) => [
      item.videoId,
      item.channel?.channelId || '',
      item.channel?.canonicalPath || '',
      item.channel?.displayName || '',
    ]).sort();
    const canInferCandidates = Boolean(
      candidateProfile?.id && candidateAliases.length > 0
    );
    const canInferRelated = Boolean(
      relatedProfile?.id && relatedAliases.length > 0
    );
    const canLookup = Boolean(
      (canInferCandidates || canInferRelated) &&
      videoIds.length > 0 &&
      typeof globalThis.chrome?.runtime?.sendMessage === 'function'
    );
    const lookupKey = canLookup
      ? JSON.stringify([
        candidateProfile?.id || '',
        candidateAliases,
        relatedProfile?.id || '',
        relatedAliases,
        itemSignatures,
      ])
      : '';

    if (lookupKey === state.creditLookupKey) return;

    state.creditLookupKey = lookupKey;
    const generation = ++state.creditLookupGeneration;
    state.creditCandidates = [];
    state.creditRelatedVideoIds = new Set();
    const previousLookupError = state.creditLookupError;
    state.creditLookupError = '';
    renderManagementState();
    if (previousLookupError) setManagementStatus('');
    if (!canLookup) return;

    void dbRpc('GET_CREDITS_FOR_VIDEO_IDS', { videoIds })
      .then((creditsByVideoId) => {
        if (
          state.disposed ||
          generation !== state.creditLookupGeneration ||
          lookupKey !== state.creditLookupKey
        ) {
          return;
        }
        const combinedCreditsByVideoId = {
          ...(creditsByVideoId || {}),
          ...state.previewCreditsByVideoId,
        };
        const candidateInference = canInferCandidates
          ? inferCreditChannelCandidates({
            items,
            creditsByVideoId: combinedCreditsByVideoId,
            creditAliases: candidateAliases,
          })
          : { candidates: [], relatedVideoIds: [] };
        const relatedInference = canInferRelated
          ? (
            canInferCandidates && candidateProfile.id === relatedProfile.id
              ? candidateInference
              : inferCreditChannelCandidates({
                items,
                creditsByVideoId: combinedCreditsByVideoId,
                creditAliases: relatedAliases,
              })
          )
          : { candidates: [], relatedVideoIds: [] };
        state.creditCandidates = candidateInference.candidates.map((candidate) => ({
          ...candidate,
          profileId: candidateProfile.id,
          profileName: candidateProfile.displayName || candidateProfile.id,
        }));
        state.creditRelatedVideoIds = new Set(relatedInference.relatedVideoIds);
        state.creditLookupError = '';
        scanSearchResults();
        renderManagementState();
      })
      .catch((error) => {
        if (
          !state.disposed &&
          generation === state.creditLookupGeneration &&
          lookupKey === state.creditLookupKey
        ) {
          // Fail open. A later real page mutation may retry the local DB read.
          state.creditLookupKey = '';
          state.creditLookupError = error?.message || 'DB RPC failed';
          renderManagementState();
          setManagementStatus(
            `クレジットDBから公式ソース候補を照会できませんでした: ${state.creditLookupError}`,
            true
          );
        }
      });
  }

  function getCurrentSearchQuery() {
    try {
      return new URL(location.href).searchParams.get('search_query') || '';
    } catch {
      return '';
    }
  }

  function resolveProfileForQuery(settings, query) {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) return null;

    const boundProfileId = settings.queryBindings[normalizedQuery];
    if (boundProfileId) {
      return settings.profiles[boundProfileId] || null;
    }

    const matches = Object.values(settings.profiles).filter((profile) =>
      [profile.displayName, ...profile.aliases].some(
        (alias) => normalizeText(alias) === normalizedQuery
      )
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function resolveEffectiveState() {
    const query = getCurrentSearchQuery();
    const normalizedQuery = normalizeText(query);
    const queryChanged = normalizedQuery !== state.currentNormalizedQuery;
    const profile = resolveProfileForQuery(state.settings, query);
    const nextProfileId = profile?.id || null;
    const nextMode = profile?.mode || (
      state.settings.hideOtherGlobal
        ? MODE.DISCOVERY
        : MODE.ALL
    );
    const profileChanged = nextProfileId !== state.effectiveProfileId;
    const modeChanged = nextMode !== state.mode;
    if (queryChanged || profileChanged || modeChanged) {
      state.temporaryRevealActive = false;
    }
    state.currentNormalizedQuery = normalizedQuery;
    state.effectiveProfileId = nextProfileId;
    state.mode = nextMode;
    if (queryChanged) renderManagementState();
    return profile;
  }

  function getActiveProfile() {
    const id = state.settings.activeProfileId;
    return typeof id === 'string'
      ? state.settings.profiles[id] || null
      : null;
  }

  function getEffectiveProfile() {
    const id = state.effectiveProfileId;
    return typeof id === 'string'
      ? state.settings.profiles[id] || null
      : null;
  }

  function renderPanelState() {
    const panel = document.getElementById?.(PANEL_ID);
    if (!panel) return;

    for (const [category, count] of Object.entries(state.counts)) {
      const target = panel.querySelector?.(
        `[data-count="${category}"]`
      );
      if (target) target.textContent = String(count);
    }

    const visible = panel.querySelector?.('[data-count-visible]');
    const total = panel.querySelector?.('[data-count-total]');
    const effective = panel.querySelector?.('[data-effective-profile]');
    const unboundHint = panel.querySelector?.('[data-unbound-hint]');
    const globalHideButton = panel.querySelector?.('[data-global-hide]');
    const temporaryRevealButton = panel.querySelector?.(
      '[data-temporary-reveal]'
    );
    const temporaryRevealStatus = panel.querySelector?.(
      '[data-temporary-reveal-status]'
    );
    const hasEffectiveProfile = Boolean(getEffectiveProfile());
    if (visible) visible.textContent = String(state.visibleCount);
    if (total) {
      total.textContent = String(
        Object.values(state.counts)
          .reduce((sum, count) => sum + count, 0)
      );
    }
    if (effective) {
      const profile = getEffectiveProfile();
      effective.textContent = profile
        ? `適用中: ${profile.displayName || profile.id} / ${state.mode}`
        : state.settings.hideOtherGlobal
          ? '未登録の検索語: その他チャンネルを非表示'
          : '未登録の検索語: すべて表示';
    }
    if (unboundHint) {
      unboundHint.hidden = hasEffectiveProfile;
    }
    if (globalHideButton) {
      globalHideButton.setAttribute(
        'aria-checked',
        String(state.settings.hideOtherGlobal)
      );
    }

    for (const button of panel.querySelectorAll?.('[data-mode]') || []) {
      const requiresProfile =
        button.dataset.mode === MODE.OFFICIAL ||
        button.dataset.mode === MODE.DISCOVERY;
      const disabled = requiresProfile && !hasEffectiveProfile;
      button.disabled = disabled;
      button.setAttribute('aria-disabled', String(disabled));
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.mode === state.mode)
      );
    }
    if (temporaryRevealButton) {
      const disabled = state.mode === MODE.ALL;
      temporaryRevealButton.disabled = disabled;
      temporaryRevealButton.setAttribute(
        'aria-disabled',
        String(disabled)
      );
      temporaryRevealButton.setAttribute(
        'aria-pressed',
        String(state.temporaryRevealActive)
      );
      temporaryRevealButton.textContent = state.temporaryRevealActive
        ? '一時表示を解除'
        : '一時的にすべて表示';
      temporaryRevealButton.setAttribute(
        'aria-label',
        state.temporaryRevealActive
          ? '一時的な全件表示を解除'
          : 'フィルターで隠した動画を一時的にすべて表示'
      );
    }
    if (temporaryRevealStatus) {
      temporaryRevealStatus.hidden = !state.temporaryRevealActive;
      temporaryRevealStatus.textContent = state.temporaryRevealActive
        ? '一時表示: 有効'
        : '';
    }
    const previewStart = panel.querySelector?.('[data-preview-credits-start]');
    const previewCancel = panel.querySelector?.('[data-preview-credits-cancel]');
    const previewStatus = panel.querySelector?.('[data-preview-credits-status]');
    const previewResults = panel.querySelector?.('[data-preview-credits-results]');
    const previewCount = Math.min(
      state.previewVideoIds.length,
      core.PREVIEW_CREDITS_MAX_VIDEOS || 20
    );
    if (previewStart) {
      previewStart.textContent = `他Topic ${previewCount}件をクレジット確認`;
      previewStart.disabled = state.previewRunning || previewCount === 0;
      previewStart.setAttribute('aria-disabled', String(previewStart.disabled));
    }
    if (previewCancel) {
      previewCancel.hidden = !state.previewRunning;
      previewCancel.disabled = !state.previewRunning || state.previewCancelling;
    }
    if (previewStatus) {
      previewStatus.textContent = state.previewRunning
        ? `${state.previewMessage} ${state.previewProcessed}/${state.previewTotal}`
        : state.previewMessage;
    }
    if (previewResults) {
      previewResults.textContent = '';
      for (const [videoId, result] of Object.entries(state.previewResults)) {
        const values = ['composer', 'lyricist', 'arranger']
          .filter((role) => result?.credits?.[role])
          .map((role) => `${role}: ${result.credits[role]}`);
        const error = result?.error?.kind ? ` / error: ${result.error.kind}` : '';
        appendText(
          previewResults,
          'li',
          result?.status === 'error' ? 'ywh-osf-preview-result--error' : '',
          `${videoId}: ${result?.status || 'unknown'}${values.length ? ` / ${values.join(' / ')}` : ''}${error}`
        );
      }
    }
  }

  function scanSearchResults() {
    if (state.disposed || !isSearchPage()) return;

    const profile = resolveEffectiveState();
    const cards = getSearchVideoCards();
    refreshCreditCandidates(cards, getActiveProfile(), profile);
    const counts = createEmptyCounts();
    const previewVideoIds = [];
    let visibleCount = 0;

    for (const card of cards) {
      const category = classifyChannel({
        channel: getChannelIdentityFromCard(card),
        profile,
        hasRelatedCredit: state.creditRelatedVideoIds.has(
          getVideoIdFromCard(card)
        ),
      });
      const shouldShow = shouldShowCategory(category, state.mode);

      counts[category] = (counts[category] || 0) + 1;
      if (category === CATEGORY.OTHER_TOPIC) {
        const videoId = getVideoIdFromCard(card);
        if (videoId && !previewVideoIds.includes(videoId)) previewVideoIds.push(videoId);
      }
      if (shouldShow) visibleCount += 1;
      if (state.temporaryRevealActive) {
        card.classList.remove(HIDDEN_CLASS);
      } else {
        card.classList.toggle(HIDDEN_CLASS, !shouldShow);
      }
    }

    state.counts = counts;
    state.previewVideoIds = previewVideoIds;
    state.visibleCount = visibleCount;
    renderPanelState();
  }

  function applySettings(settings) {
    state.settings = settings;
    state.persistedMode = settings.globalMode;
    initializePage();
    renderManagementState();
  }

  async function loadSettings() {
    const changeGeneration = state.storageChangeGeneration;
    let settings = createDefaultSettings();
    if (hasStorageLocal()) {
      try {
        const stored = await storageLocalGet();
        settings = sanitizeSettings(stored[STORAGE_KEY]);
      } catch {
        settings = createDefaultSettings();
      }
    }
    if (
      !state.disposed &&
      changeGeneration === state.storageChangeGeneration
    ) {
      applySettings(settings);
    }
  }

  async function saveMode(mode, query) {
    if (state.disposed || !isValidMode(mode)) return;

    const settings = sanitizeSettings(state.settings);
    const profile = resolveProfileForQuery(settings, query);
    if (!profile) return;
    profile.mode = mode;

    if (!hasStorageLocal()) {
      applySettings(settings);
      return;
    }

    try {
      await storageLocalSet(settings);
      if (state.disposed) return;
      applySettings(settings);
    } catch {
      if (state.disposed) return;
      initializePage();
      renderManagementState();
    }
  }

  function requestModeChange(mode) {
    const query = getCurrentSearchQuery();
    if (
      !isValidMode(mode) ||
      !resolveProfileForQuery(state.settings, query)
    ) {
      return;
    }
    state.temporaryRevealActive = false;
    scanSearchResults();
    if (!hasStorageLocal()) {
      void saveMode(mode, query);
      return;
    }
    const saveAfterLoad = async () => {
      await state.loadPromise;
      return saveMode(mode, query);
    };
    state.saveQueue = state.saveQueue.then(
      saveAfterLoad,
      saveAfterLoad
    );
  }

  function requestGlobalHideChange(enabled) {
    if (typeof enabled !== 'boolean') return;
    requestSettingsChange((settings) => {
      settings.hideOtherGlobal = enabled;
      return true;
    }, enabled
      ? 'その他チャンネルを非表示にしました。'
      : 'その他チャンネルを表示します。');
  }

  function setManagementStatus(
    message,
    isError = false,
    isPending = false
  ) {
    const status = document.getElementById?.('ywh-osf-management-status');
    if (!status) return;
    status.textContent = message;
    status.dataset.status = isError
      ? 'error'
      : isPending
        ? 'pending'
        : 'success';
  }

  function generateProfileId(displayName, profiles) {
    if (profileStore) {
      return profileStore.generateProfileId(displayName, profiles);
    }
    const base = String(displayName)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'profile';
    if (!profiles[base]) return base;

    let suffix = 2;
    while (profiles[base + '-' + suffix]) suffix += 1;
    return base + '-' + suffix;
  }

  function duplicateChannelIndex(channels, target) {
    if (profileStore) {
      return profileStore.duplicateChannelIndex(channels, target);
    }
    const targetId = String(target.channelId ?? '').trim();
    const targetPath = normalizeChannelPath(target.canonicalPath);

    return channels.findIndex((channel) => {
      const channelId = String(channel.channelId ?? '').trim();
      if (targetId && channelId) return targetId === channelId;
      const channelPath = normalizeChannelPath(channel.canonicalPath);
      return Boolean(
        targetPath &&
        channelPath &&
        targetPath === channelPath
      );
    });
  }

  function requestSettingsChange(change, successMessage, onSuccess) {
    const saveAfterLoad = async () => {
      await state.loadPromise;
      if (state.disposed) return;

      const candidate = sanitizeSettings(state.settings);
      if (change(candidate) === false) {
        renderManagementState();
        setManagementStatus('変更対象が見つかりません。', true);
        return;
      }
      const nextSettings = sanitizeSettings(candidate);
      setManagementStatus('保存中です。', false, true);

      if (!hasStorageLocal()) {
        applySettings(nextSettings);
        onSuccess?.();
        setManagementStatus(successMessage);
        return;
      }

      try {
        await storageLocalSet(nextSettings);
        if (state.disposed) return;
        applySettings(nextSettings);
        onSuccess?.();
        setManagementStatus(successMessage);
      } catch {
        if (state.disposed) return;
        renderManagementState();
        setManagementStatus(
          '保存できませんでした。変更は反映されていません。',
          true
        );
      }
    };

    state.saveQueue = state.saveQueue.then(
      saveAfterLoad,
      saveAfterLoad
    );
  }

  function requestProfileSelection(profileId) {
    state.temporaryRevealActive = false;
    scanSearchResults();
    requestSettingsChange((settings) => {
      if (!settings.profiles[profileId]) return false;
      settings.activeProfileId = profileId;
      return true;
    }, '使用するプロフィールを変更しました。');
  }

  function requestProfileCreate(displayName, input) {
    const name = String(displayName ?? '').trim();
    if (!name) {
      setManagementStatus('プロフィール名を入力してください。', true);
      return;
    }

    requestSettingsChange((settings) => {
      if (profileStore) {
        const result = profileStore.createProfile(settings, name);
        if (!result.changed) return false;
        Object.assign(settings, result.settings);
        return true;
      }
      const id = generateProfileId(name, settings.profiles);
      settings.profiles[id] = {
        id,
        displayName: name,
        aliases: [],
        channels: [],
        mode: MODE.ALL,
      };
      settings.activeProfileId = id;
      return true;
    }, 'プロフィールを作成しました。', () => {
      input.value = '';
    });
  }

  function requestProfileRename(displayName, input) {
    const name = String(displayName ?? '').trim();
    if (!name) {
      setManagementStatus('新しいプロフィール名を入力してください。', true);
      return;
    }
    const profileId = state.settings.activeProfileId;

    requestSettingsChange((settings) => {
      const profile = settings.profiles[profileId];
      if (!profile) return false;
      profile.displayName = name;
      return true;
    }, 'プロフィール名を変更しました。', () => {
      input.value = name;
    });
  }

  function requestProfileModeChange(profileId, mode) {
    if (!isValidMode(mode)) {
      setManagementStatus('有効な表示モードを選択してください。', true);
      return;
    }
    state.temporaryRevealActive = false;
    scanSearchResults();
    requestSettingsChange((settings) => {
      const profile = settings.profiles[profileId];
      if (!profile) return false;
      profile.mode = mode;
      return true;
    }, 'プロフィールの表示モードを変更しました。');
  }

  function requestQueryBinding(profileId) {
    const normalizedQuery = normalizeText(getCurrentSearchQuery());
    if (!normalizedQuery) {
      setManagementStatus('検索語が空のため関連付けできません。', true);
      return;
    }
    requestSettingsChange((settings) => {
      if (!settings.profiles[profileId]) return false;
      settings.queryBindings[normalizedQuery] = profileId;
      return true;
    }, '現在の検索語をプロフィールに関連付けました。');
  }

  function requestQueryBindingRemove() {
    const normalizedQuery = normalizeText(getCurrentSearchQuery());
    requestSettingsChange((settings) => {
      if (
        !normalizedQuery ||
        !Object.prototype.hasOwnProperty.call(
          settings.queryBindings,
          normalizedQuery
        )
      ) {
        return false;
      }
      delete settings.queryBindings[normalizedQuery];
      return true;
    }, '現在の検索語の関連付けを解除しました。');
  }

  function requestProfileDelete() {
    const profileId = state.settings.activeProfileId;
    requestSettingsChange((settings) => {
      if (!profileId || !settings.profiles[profileId]) return false;
      delete settings.profiles[profileId];
      for (const [query, boundProfileId] of Object.entries(
        settings.queryBindings
      )) {
        if (boundProfileId === profileId) {
          delete settings.queryBindings[query];
        }
      }
      settings.activeProfileId =
        Object.keys(settings.profiles)[0] || null;
      return true;
    }, 'プロフィールを削除しました。', () => {
      clearPendingChannel();
    });
  }

  function requestChannelAdd(profileId, target) {
    const channel = sanitizeChannel(target);
    if (!profileId || !channel || !channel.canonicalPath) {
      setManagementStatus('登録対象をもう一度確認してください。', true);
      return;
    }

    requestSettingsChange((settings) => {
      if (profileStore) {
        const result = profileStore.addChannel(
          settings,
          profileId,
          channel,
          { confirmed: true }
        );
        if (!result.changed) return false;
        Object.assign(settings, result.settings);
        return true;
      }
      const profile = settings.profiles[profileId];
      if (!profile) return false;
      const duplicateIndex = duplicateChannelIndex(
        profile.channels,
        channel
      );
      if (duplicateIndex >= 0) {
        profile.channels[duplicateIndex] = {
          ...profile.channels[duplicateIndex],
          ...channel,
          enabled: true,
        };
      } else {
        profile.channels.push({ ...channel, enabled: true });
      }
      return true;
    }, 'チャンネルを登録しました。', () => {
      clearPendingChannel(true);
    });
  }

  function requestChannelRemove(profileId, target) {
    requestSettingsChange((settings) => {
      const profile = settings.profiles[profileId];
      if (!profile) return false;
      const channelIndex = duplicateChannelIndex(
        profile.channels,
        target
      );
      if (channelIndex < 0) return false;
      profile.channels.splice(channelIndex, 1);
      return true;
    }, 'チャンネル登録を解除しました。');
  }

  function onStorageChanged(changes, areaName) {
    if (
      state.disposed ||
      areaName !== 'local' ||
      !changes ||
      !Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)
    ) return;
    state.storageChangeGeneration += 1;
    applySettings(sanitizeSettings(changes[STORAGE_KEY]?.newValue));
  }

  function scheduleScan(delayMs = 50) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      scanSearchResults();
    }, delayMs);
  }

  function clearHiddenClasses() {
    for (
      const element of
      document.querySelectorAll?.(`.${HIDDEN_CLASS}`) || []
    ) {
      element.classList.remove(HIDDEN_CLASS);
    }
  }

  function removePanel() {
    document.getElementById?.(PANEL_ID)?.remove();
  }

  function cleanupSearchPage() {
    clearTimeout(state.scanTimer);
    state.scanTimer = null;
    removePanel();
    clearHiddenClasses();
    state.counts = createEmptyCounts();
    state.visibleCount = 0;
    state.temporaryRevealActive = false;
    state.panelExpanded = false;
  }

  function createSvgIcon() {
    const svg = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'svg'
    );
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'path'
    );
    path.setAttribute(
      'd',
      'M4 6.5h16M7 12h10M10 17.5h4'
    );
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    return svg;
  }

  function createChevronIcon() {
    const svg = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'svg'
    );
    svg.setAttribute('class', 'ywh-osf-panel-toggle__icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'path'
    );
    path.setAttribute('d', 'M7 9.5l5 5 5-5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function setPanelExpanded(expanded) {
    state.panelExpanded = Boolean(expanded);
    const panel = document.getElementById?.(PANEL_ID);
    if (!panel) return;

    const content = panel.querySelector?.('[data-expanded-content]');
    const button = panel.querySelector?.('[data-panel-toggle]');
    const label = panel.querySelector?.('[data-panel-toggle-label]');
    panel.dataset.expanded = String(state.panelExpanded);
    if (content) {
      content.hidden = !state.panelExpanded;
      content.setAttribute(
        'aria-hidden',
        String(!state.panelExpanded)
      );
    }
    if (button) {
      button.setAttribute(
        'aria-expanded',
        String(state.panelExpanded)
      );
      button.setAttribute(
        'aria-label',
        state.panelExpanded
          ? '検索フィルターを閉じる'
          : '検索フィルターを開く'
      );
    }
    if (label) {
      label.textContent = state.panelExpanded ? '閉じる' : '開く';
    }
  }

  function appendText(parent, tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function createModeButton(mode, label, ariaLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ywh-osf-mode-button';
    button.dataset.mode = mode;
    button.setAttribute('aria-label', ariaLabel);
    button.setAttribute('aria-pressed', String(state.mode === mode));
    button.textContent = label;
    button.addEventListener('click', () => {
      if (
        button.disabled ||
        button.getAttribute('aria-disabled') === 'true'
      ) {
        return;
      }
      requestModeChange(mode);
    });
    return button;
  }

  function toggleTemporaryReveal(button) {
    if (
      button.disabled ||
      button.getAttribute('aria-disabled') === 'true'
    ) {
      return;
    }
    state.temporaryRevealActive = !state.temporaryRevealActive;
    scanSearchResults();
  }

  function createLabeledControl(
    parent,
    labelText,
    control,
    ariaLabel
  ) {
    const label = document.createElement('label');
    label.className = 'ywh-osf-field';
    appendText(label, 'span', 'ywh-osf-field__label', labelText);
    control.setAttribute('aria-label', ariaLabel);
    label.appendChild(control);
    parent.appendChild(label);
    return control;
  }

  function createManagementButton(label, ariaLabel, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className || 'ywh-osf-action-button';
    button.setAttribute('aria-label', ariaLabel);
    button.textContent = label;
    return button;
  }

  function clearPendingChannel(clearInputs = false) {
    state.pendingChannel = null;
    const panel = document.getElementById?.(PANEL_ID);
    if (!panel) return;

    const target = panel.querySelector?.('[data-channel-target]');
    const confirmButton = panel.querySelector?.('[data-channel-confirm]');
    if (target) {
      target.textContent = '';
      target.hidden = true;
    }
    if (confirmButton) confirmButton.disabled = true;

    if (clearInputs) {
      for (const selector of [
        '[data-channel-id-input]',
        '[data-channel-path-input]',
        '[data-channel-name-input]',
      ]) {
        const input = panel.querySelector?.(selector);
        if (input) input.value = '';
      }
    }
  }

  function showPendingChannel(pending, message) {
    state.pendingChannel = pending;
    const panel = document.getElementById?.(PANEL_ID);
    const target = panel?.querySelector?.('[data-channel-target]');
    const confirmButton = panel?.querySelector?.('[data-channel-confirm]');
    if (target) {
      const channel = pending.channel;
      const idLabel = channel.channelId || 'なし（pathのみ）';
      const evidence = pending.candidate?.reasons?.length
        ? ` / 根拠: ${pending.candidate.reasons.join(' / ')}`
        : '';
      target.textContent =
        `登録対象: ID: ${idLabel} / path: ${channel.canonicalPath} / ` +
        `名前: ${channel.displayName}${evidence}`;
      target.hidden = false;
    }
    if (confirmButton) confirmButton.disabled = false;
    setManagementStatus(message);
  }

  function prepareCreditCandidate(candidate) {
    if (
      !candidate ||
      !state.creditCandidates.includes(candidate) ||
      !state.settings.profiles[candidate.profileId]
    ) {
      setManagementStatus('候補が古いため、検索結果を再確認してください。', true);
      return;
    }
    const channel = sanitizeChannel(candidate.channel);
    if (!channel?.canonicalPath) {
      setManagementStatus('候補のチャンネルpathを確認できません。', true);
      return;
    }
    showPendingChannel({
      source: 'credit-candidate',
      profileId: candidate.profileId,
      channel,
      candidate,
    }, '根拠と登録対象を確認し、登録ボタンを押してください。');
  }

  function isExplicitChannelPath(path) {
    return /^\/(?:channel\/[^/]+|@[^/]+|c\/[^/]+|user\/[^/]+)$/i
      .test(path);
  }

  function prepareChannelTarget(idInput, pathInput, nameInput) {
    const profile = getActiveProfile();
    if (!profile) {
      setManagementStatus('先にプロフィールを作成してください。', true);
      return;
    }

    const channelId = String(idInput.value ?? '').trim();
    const canonicalPath = normalizeChannelPath(pathInput.value);
    const displayName = String(nameInput.value ?? '').trim();
    if (!canonicalPath || !isExplicitChannelPath(canonicalPath)) {
      setManagementStatus(
        '正確なチャンネルpathまたはhandleを入力してください。',
        true
      );
      return;
    }
    if (!displayName) {
      setManagementStatus('チャンネル表示名を入力してください。', true);
      return;
    }

    const channel = {
      ...(channelId ? { channelId } : {}),
      canonicalPath,
      displayName,
      enabled: true,
    };
    showPendingChannel({
      source: 'manual',
      profileId: profile.id,
      channel,
    }, '表示された登録対象を確認し、登録ボタンを押してください。');
  }

  function renderManagementState() {
    const panel = document.getElementById?.(PANEL_ID);
    if (!panel) return;

    const profileSelect = panel.querySelector?.('[data-profile-select]');
    const renameInput = panel.querySelector?.('[data-profile-rename-input]');
    const renameButton = panel.querySelector?.('[data-profile-rename]');
    const deleteButton = panel.querySelector?.('[data-profile-delete]');
    const profileModeSelect = panel.querySelector?.('[data-profile-mode]');
    const bindingQuery = panel.querySelector?.('[data-binding-query]');
    const bindingProfileSelect = panel.querySelector?.(
      '[data-binding-profile-select]'
    );
    const bindingSaveButton = panel.querySelector?.('[data-binding-save]');
    const bindingRemoveButton = panel.querySelector?.('[data-binding-remove]');
    const channelList = panel.querySelector?.('[data-channel-list]');
    const creditCandidateList = panel.querySelector?.(
      '[data-credit-candidate-list]'
    );
    const channelInputs = [
      panel.querySelector?.('[data-channel-id-input]'),
      panel.querySelector?.('[data-channel-path-input]'),
      panel.querySelector?.('[data-channel-name-input]'),
    ].filter(Boolean);
    const prepareButton = panel.querySelector?.('[data-channel-prepare]');
    const confirmButton = panel.querySelector?.('[data-channel-confirm]');
    const profiles = Object.values(state.settings.profiles);
    const activeProfile = getActiveProfile();
    const normalizedQuery = normalizeText(getCurrentSearchQuery());
    const boundProfileId = state.settings.queryBindings[normalizedQuery] || '';

    if (profileSelect) {
      profileSelect.textContent = '';
      if (profiles.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'プロフィールなし';
        profileSelect.appendChild(option);
      } else {
        for (const profile of profiles) {
          const option = document.createElement('option');
          option.value = profile.id;
          option.textContent = profile.displayName || profile.id;
          profileSelect.appendChild(option);
        }
      }
      profileSelect.value = activeProfile?.id || '';
      profileSelect.disabled = profiles.length === 0;
    }

    if (renameInput) {
      renameInput.value = activeProfile?.displayName || '';
      renameInput.disabled = !activeProfile;
    }
    if (profileModeSelect) {
      profileModeSelect.value = activeProfile?.mode || MODE.ALL;
      profileModeSelect.disabled = !activeProfile;
    }
    if (bindingQuery) {
      bindingQuery.textContent = normalizedQuery
        ? `現在の正規化検索語: ${normalizedQuery}`
        : '現在の検索語は空です。';
    }
    if (bindingProfileSelect) {
      bindingProfileSelect.textContent = '';
      for (const profile of profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.displayName || profile.id;
        bindingProfileSelect.appendChild(option);
      }
      bindingProfileSelect.value =
        boundProfileId || activeProfile?.id || profiles[0]?.id || '';
      bindingProfileSelect.disabled =
        !normalizedQuery || profiles.length === 0;
    }
    if (bindingSaveButton) {
      bindingSaveButton.disabled =
        !normalizedQuery || profiles.length === 0;
    }
    if (bindingRemoveButton) {
      bindingRemoveButton.disabled = !boundProfileId;
    }
    if (renameButton) renameButton.disabled = !activeProfile;
    if (deleteButton) deleteButton.disabled = !activeProfile;
    for (const input of channelInputs) input.disabled = !activeProfile;
    if (prepareButton) prepareButton.disabled = !activeProfile;

    if (
      state.pendingChannel &&
      (
        !state.settings.profiles[state.pendingChannel.profileId] ||
        (
          state.pendingChannel.source !== 'credit-candidate' &&
          state.pendingChannel.profileId !== activeProfile?.id
        )
      )
    ) {
      clearPendingChannel();
    } else if (confirmButton) {
      confirmButton.disabled = !state.pendingChannel;
    }

    if (creditCandidateList) {
      creditCandidateList.textContent = '';
      const candidates = state.creditCandidates.filter((candidate) => {
        const profile = state.settings.profiles[candidate.profileId];
        return profile && duplicateChannelIndex(
          profile.channels,
          candidate.channel
        ) < 0;
      });
      if (state.creditLookupError) {
        // The existing management status reports the lookup failure.
      } else if (candidates.length === 0) {
        appendText(
          creditCandidateList,
          'li',
          'ywh-osf-channel-empty',
          'クレジット一致による未登録候補はありません。'
        );
      } else {
        for (const candidate of candidates) {
          const item = document.createElement('li');
          item.className = 'ywh-osf-channel-item';
          item.dataset.creditCandidate = '';
          const detail = document.createElement('div');
          const identity = [
            candidate.channel.displayName,
            candidate.channel.channelId
              ? `ID: ${candidate.channel.channelId}`
              : '',
            candidate.channel.canonicalPath,
            `登録先: ${candidate.profileName}`,
          ].filter(Boolean).join(' / ');
          appendText(
            detail,
            'div',
            'ywh-osf-channel-identity',
            identity
          );
          const reason = appendText(
            detail,
            'div',
            'ywh-osf-panel__note',
            `候補の根拠: ${candidate.reasons.join(' / ')}`
          );
          reason.dataset.creditCandidateReason = '';
          item.appendChild(detail);
          const prepareButton = createManagementButton(
            'この候補を確認',
            `公式ソース候補を確認: ${identity}`
          );
          prepareButton.dataset.creditCandidatePrepare = '';
          prepareButton.addEventListener('click', () => {
            prepareCreditCandidate(candidate);
          });
          item.appendChild(prepareButton);
          creditCandidateList.appendChild(item);
        }
      }
    }

    if (channelList) {
      channelList.textContent = '';
      const channels = activeProfile?.channels || [];
      if (channels.length === 0) {
        appendText(
          channelList,
          'li',
          'ywh-osf-channel-empty',
          '登録済みチャンネルはありません。'
        );
      } else {
        channels.forEach((channel, index) => {
          const item = document.createElement('li');
          item.className = 'ywh-osf-channel-item';
          const identity = [
            channel.displayName,
            channel.channelId ? `ID: ${channel.channelId}` : '',
            channel.canonicalPath,
          ].filter(Boolean).join(' / ');
          appendText(item, 'span', 'ywh-osf-channel-identity', identity);
          const removeButton = createManagementButton(
            '解除',
            `チャンネル登録を解除: ${identity}`,
            'ywh-osf-action-button ywh-osf-action-button--danger'
          );
          removeButton.dataset.channelRemove = String(index);
          removeButton.addEventListener('click', () => {
            requestChannelRemove(activeProfile.id, channel);
          });
          item.appendChild(removeButton);
          channelList.appendChild(item);
        });
      }
    }
  }

  function createPreviewCreditsSection() {
    const section = document.createElement('section');
    section.className = 'ywh-osf-preview-credits';
    appendText(section, 'h3', 'ywh-osf-management__title', '未知動画のクレジット確認');
    appendText(
      section,
      'p',
      'ywh-osf-panel__note',
      'ボタンを押したときだけ、他Topic動画を最大20件確認します。視聴履歴には登録しません。'
    );
    const actions = document.createElement('div');
    actions.className = 'ywh-osf-preview-actions';
    const start = createManagementButton(
      '他Topic 0件をクレジット確認',
      '他Topic動画のクレジット確認を開始'
    );
    start.dataset.previewCreditsStart = '';
    start.addEventListener('click', startPreviewCredits);
    actions.appendChild(start);
    const cancel = createManagementButton(
      '中止',
      '実行中のクレジット確認を中止',
      'ywh-osf-action-button ywh-osf-action-button--danger'
    );
    cancel.dataset.previewCreditsCancel = '';
    cancel.hidden = true;
    cancel.addEventListener('click', cancelPreviewCredits);
    actions.appendChild(cancel);
    section.appendChild(actions);
    const status = appendText(section, 'p', 'ywh-osf-preview-status', '');
    status.dataset.previewCreditsStatus = '';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const results = document.createElement('ul');
    results.className = 'ywh-osf-preview-results';
    results.dataset.previewCreditsResults = '';
    section.appendChild(results);
    return section;
  }

  function createManagementSection() {
    const section = document.createElement('section');
    section.className = 'ywh-osf-management';
    section.setAttribute('aria-labelledby', 'ywh-osf-management-title');
    const heading = appendText(
      section,
      'h3',
      'ywh-osf-management__title',
      'プロフィールと公式ソース'
    );
    heading.id = 'ywh-osf-management-title';

    const profileSelect = document.createElement('select');
    profileSelect.dataset.profileSelect = '';
    createLabeledControl(
      section,
      '使用するプロフィール',
      profileSelect,
      '使用するプロフィールを選択'
    );
    profileSelect.addEventListener('change', () => {
      clearPendingChannel();
      requestProfileSelection(profileSelect.value);
    });

    const profileModeSelect = document.createElement('select');
    profileModeSelect.dataset.profileMode = '';
    for (const [mode, label] of [
      [MODE.ALL, 'すべて表示'],
      [MODE.OFFICIAL, '公式優先'],
      [MODE.DISCOVERY, '発掘'],
    ]) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = label;
      profileModeSelect.appendChild(option);
    }
    createLabeledControl(
      section,
      'プロフィールの表示モード',
      profileModeSelect,
      'プロフィールの表示モードを選択'
    );
    profileModeSelect.addEventListener('change', () => {
      const profileId = state.settings.activeProfileId;
      if (profileId) {
        requestProfileModeChange(profileId, profileModeSelect.value);
      }
    });

    const createRow = document.createElement('div');
    createRow.className = 'ywh-osf-form-row';
    const createInput = document.createElement('input');
    createInput.type = 'text';
    createInput.dataset.profileCreateInput = '';
    createInput.setAttribute('autocomplete', 'off');
    createLabeledControl(
      createRow,
      '新しいプロフィール名',
      createInput,
      '新しいプロフィール名'
    );
    const createButton = createManagementButton(
      '作成',
      'プロフィールを作成'
    );
    createButton.dataset.profileCreate = '';
    createButton.addEventListener('click', () => {
      requestProfileCreate(createInput.value, createInput);
    });
    createRow.appendChild(createButton);
    section.appendChild(createRow);

    const renameRow = document.createElement('div');
    renameRow.className = 'ywh-osf-form-row';
    const renameInput = document.createElement('input');
    renameInput.type = 'text';
    renameInput.dataset.profileRenameInput = '';
    createLabeledControl(
      renameRow,
      'プロフィール名',
      renameInput,
      'プロフィールの新しい名前'
    );
    const renameButton = createManagementButton(
      '名前を変更',
      'プロフィール名を変更'
    );
    renameButton.dataset.profileRename = '';
    renameButton.addEventListener('click', () => {
      requestProfileRename(renameInput.value, renameInput);
    });
    renameRow.appendChild(renameButton);
    const deleteButton = createManagementButton(
      '削除',
      '現在のプロフィールを削除',
      'ywh-osf-action-button ywh-osf-action-button--danger'
    );
    deleteButton.dataset.profileDelete = '';
    deleteButton.addEventListener('click', requestProfileDelete);
    renameRow.appendChild(deleteButton);
    section.appendChild(renameRow);

    appendText(
      section,
      'h4',
      'ywh-osf-management__subtitle',
      '検索語とプロフィールの関連付け'
    );
    const bindingQuery = appendText(
      section,
      'p',
      'ywh-osf-binding-query',
      ''
    );
    bindingQuery.dataset.bindingQuery = '';
    const bindingRow = document.createElement('div');
    bindingRow.className = 'ywh-osf-form-row';
    const bindingProfileSelect = document.createElement('select');
    bindingProfileSelect.dataset.bindingProfileSelect = '';
    createLabeledControl(
      bindingRow,
      '関連付けるプロフィール',
      bindingProfileSelect,
      '現在の検索語に関連付けるプロフィール'
    );
    const bindingSaveButton = createManagementButton(
      '関連付け',
      '現在の検索語を選択したプロフィールに関連付け'
    );
    bindingSaveButton.dataset.bindingSave = '';
    bindingSaveButton.addEventListener('click', () => {
      requestQueryBinding(bindingProfileSelect.value);
    });
    bindingRow.appendChild(bindingSaveButton);
    const bindingRemoveButton = createManagementButton(
      '関連付けを解除',
      '現在の検索語のプロフィール関連付けを解除',
      'ywh-osf-action-button ywh-osf-action-button--danger'
    );
    bindingRemoveButton.dataset.bindingRemove = '';
    bindingRemoveButton.addEventListener(
      'click',
      requestQueryBindingRemove
    );
    bindingRow.appendChild(bindingRemoveButton);
    section.appendChild(bindingRow);

    appendText(
      section,
      'h4',
      'ywh-osf-management__subtitle',
      'クレジットDBからの公式ソース候補'
    );
    appendText(
      section,
      'p',
      'ywh-osf-panel__note',
      '候補は自動登録されません。根拠を確認し、採用する場合だけ登録してください。'
    );
    const creditCandidateList = document.createElement('ul');
    creditCandidateList.className = 'ywh-osf-channel-list';
    creditCandidateList.dataset.creditCandidateList = '';
    creditCandidateList.setAttribute(
      'aria-label',
      'クレジットDBから推測した公式ソース候補'
    );
    section.appendChild(creditCandidateList);

    appendText(
      section,
      'h4',
      'ywh-osf-management__subtitle',
      '公式チャンネルを明示登録'
    );
    const channelFields = document.createElement('div');
    channelFields.className = 'ywh-osf-channel-fields';
    const idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.dataset.channelIdInput = '';
    createLabeledControl(
      channelFields,
      'チャンネルID（任意）',
      idInput,
      '登録するチャンネルID'
    );
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.dataset.channelPathInput = '';
    createLabeledControl(
      channelFields,
      '正確なpathまたはhandle',
      pathInput,
      '登録する正確なチャンネルpathまたはhandle'
    );
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.dataset.channelNameInput = '';
    createLabeledControl(
      channelFields,
      'チャンネル表示名',
      nameInput,
      '登録するチャンネル表示名'
    );
    section.appendChild(channelFields);

    for (const input of [idInput, pathInput, nameInput]) {
      input.addEventListener('input', () => clearPendingChannel());
    }
    const prepareButton = createManagementButton(
      '登録内容を確認',
      '登録するチャンネルの内容を確認'
    );
    prepareButton.dataset.channelPrepare = '';
    prepareButton.addEventListener('click', () => {
      prepareChannelTarget(idInput, pathInput, nameInput);
    });
    section.appendChild(prepareButton);

    const target = appendText(
      section,
      'p',
      'ywh-osf-channel-target',
      ''
    );
    target.dataset.channelTarget = '';
    target.setAttribute('aria-live', 'polite');
    target.hidden = true;
    const confirmButton = createManagementButton(
      'このチャンネルを登録',
      '表示されたチャンネルを公式ソースとして登録'
    );
    confirmButton.dataset.channelConfirm = '';
    confirmButton.disabled = true;
    confirmButton.addEventListener('click', () => {
      const pending = state.pendingChannel;
      if (!pending) return;
      if (pending.source === 'credit-candidate') {
        adoptCreditCandidate({
          candidate: pending.candidate,
          userAccepted: true,
          register: (channel) => {
            requestChannelAdd(pending.profileId, channel);
          },
        });
        return;
      }
      requestChannelAdd(pending.profileId, pending.channel);
    });
    section.appendChild(confirmButton);

    const channelList = document.createElement('ul');
    channelList.className = 'ywh-osf-channel-list';
    channelList.dataset.channelList = '';
    channelList.setAttribute('aria-label', '登録済み公式チャンネル');
    section.appendChild(channelList);

    const status = appendText(
      section,
      'p',
      'ywh-osf-management__status',
      ''
    );
    status.id = 'ywh-osf-management-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    return section;
  }

  function ensurePanel() {
    if (!isSearchPage() || !document.body) return null;

    let panel = document.getElementById?.(PANEL_ID);
    if (panel) return panel;

    state.panelExpanded = false;
    panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', '公式優先検索フィルター');
    panel.dataset.expanded = 'false';

    const handle = document.createElement('div');
    handle.className = 'ywh-osf-handle';
    handle.dataset.collapsedHandle = '';
    const globalHideButton = document.createElement('button');
    globalHideButton.type = 'button';
    globalHideButton.className = 'ywh-osf-global-hide';
    globalHideButton.dataset.globalHide = '';
    globalHideButton.setAttribute('role', 'switch');
    globalHideButton.setAttribute('aria-checked', 'false');
    globalHideButton.setAttribute(
      'aria-label',
      'その他チャンネルを隠す。公式とTopicは表示'
    );
    globalHideButton.textContent =
      'その他チャンネルを隠す（公式・Topicは表示）';
    globalHideButton.addEventListener('click', () => {
      requestGlobalHideChange(
        globalHideButton.getAttribute('aria-checked') !== 'true'
      );
    });
    handle.appendChild(globalHideButton);

    const panelToggle = document.createElement('button');
    panelToggle.type = 'button';
    panelToggle.className = 'ywh-osf-panel-toggle';
    panelToggle.dataset.panelToggle = '';
    panelToggle.setAttribute('aria-controls', 'ywh-osf-expanded-content');
    panelToggle.setAttribute('aria-expanded', 'false');
    panelToggle.setAttribute('aria-label', '検索フィルターを開く');
    panelToggle.appendChild(createChevronIcon());
    const panelToggleLabel = appendText(
      panelToggle,
      'span',
      'ywh-osf-panel-toggle__label',
      '開く'
    );
    panelToggleLabel.dataset.panelToggleLabel = '';
    panelToggle.addEventListener('click', () => {
      setPanelExpanded(!state.panelExpanded);
    });
    handle.appendChild(panelToggle);
    panel.appendChild(handle);

    const expandedContent = document.createElement('div');
    expandedContent.id = 'ywh-osf-expanded-content';
    expandedContent.className = 'ywh-osf-panel__expanded';
    expandedContent.dataset.expandedContent = '';
    expandedContent.setAttribute('role', 'region');
    expandedContent.setAttribute('aria-labelledby', 'ywh-osf-title');
    expandedContent.setAttribute('aria-hidden', 'true');
    expandedContent.hidden = true;
    panel.appendChild(expandedContent);

    const header = document.createElement('div');
    header.className = 'ywh-osf-panel__header';
    header.appendChild(createSvgIcon());
    const heading = appendText(
      header,
      'h2',
      'ywh-osf-panel__title',
      '公式優先検索フィルター'
    );
    heading.id = 'ywh-osf-title';
    expandedContent.appendChild(header);

    appendText(
      expandedContent,
      'p',
      'ywh-osf-panel__note',
      '判定できない動画は安全のため表示します'
    );
    appendText(
      expandedContent,
      'p',
      'ywh-osf-panel__note',
      '表示モードは検索語に対応するプロフィールから解決されます。'
    );
    appendText(
      expandedContent,
      'p',
      'ywh-osf-global-hide__note',
      'Topicはチャンネル名から自動判定します。'
    );
    const effective = appendText(
      expandedContent,
      'p',
      'ywh-osf-panel__effective',
      '未登録の検索語: すべて表示'
    );
    effective.dataset.effectiveProfile = '';
    effective.setAttribute('aria-live', 'polite');
    const unboundHint = appendText(
      expandedContent,
      'p',
      'ywh-osf-panel__hint',
      'この検索語をプロフィールへ紐付けると利用できます'
    );
    unboundHint.dataset.unboundHint = '';
    unboundHint.setAttribute('role', 'status');

    const modes = document.createElement('div');
    modes.className = 'ywh-osf-panel__modes';
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', '表示モード');
    modes.appendChild(
      createModeButton(
        MODE.OFFICIAL,
        '公式優先',
        '公式優先で表示'
      )
    );
    modes.appendChild(
      createModeButton(
        MODE.DISCOVERY,
        '発掘',
        '未登録Topicを含めて発掘'
      )
    );
    modes.appendChild(
      createModeButton(
        MODE.ALL,
        'すべて表示',
        'フィルターをオフにしてすべて表示'
      )
    );
    expandedContent.appendChild(modes);

    const temporaryRevealButton = createManagementButton(
      '一時的にすべて表示',
      'フィルターで隠した動画を一時的にすべて表示',
      'ywh-osf-action-button ywh-osf-temporary-reveal'
    );
    temporaryRevealButton.dataset.temporaryReveal = '';
    temporaryRevealButton.setAttribute('aria-pressed', 'false');
    temporaryRevealButton.addEventListener('click', () => {
      toggleTemporaryReveal(temporaryRevealButton);
    });
    expandedContent.appendChild(temporaryRevealButton);
    const temporaryRevealStatus = appendText(
      expandedContent,
      'p',
      'ywh-osf-temporary-reveal__status',
      ''
    );
    temporaryRevealStatus.dataset.temporaryRevealStatus = '';
    temporaryRevealStatus.setAttribute('role', 'status');
    temporaryRevealStatus.setAttribute('aria-live', 'polite');
    temporaryRevealStatus.hidden = true;

    const summary = document.createElement('p');
    summary.className = 'ywh-osf-panel__summary';
    summary.setAttribute('aria-live', 'polite');
    appendText(summary, 'span', '', '表示 ');
    const visible = appendText(summary, 'strong', '', '0');
    visible.dataset.countVisible = '';
    appendText(summary, 'span', '', ' / ');
    const total = appendText(summary, 'strong', '', '0');
    total.dataset.countTotal = '';
    expandedContent.appendChild(summary);

    const counts = document.createElement('dl');
    counts.className = 'ywh-osf-panel__counts';
    for (const [category, label] of Object.entries(countLabels)) {
      const row = document.createElement('div');
      row.className = 'ywh-osf-count-row';
      appendText(row, 'dt', '', label);
      const value = appendText(row, 'dd', '', '0');
      value.dataset.count = category;
      counts.appendChild(row);
    }
    expandedContent.appendChild(counts);
    expandedContent.appendChild(createPreviewCreditsSection());
    expandedContent.appendChild(createManagementSection());
    document.body.appendChild(panel);
    setPanelExpanded(false);
    renderManagementState();
    return panel;
  }

  function initializePage() {
    if (state.disposed) return;

    if (!isSearchPage()) {
      cleanupSearchPage();
      return;
    }

    ensurePanel();
    scanSearchResults();
  }

  function onNavigateFinish() {
    const shouldCollapse = isSearchPage();
    if (shouldCollapse) state.panelExpanded = false;
    initializePage();
    if (shouldCollapse) setPanelExpanded(false);
  }

  function isPanelMutation(mutation) {
    const panel = document.getElementById?.(PANEL_ID);
    if (!panel || !mutation.target) return false;
    return mutation.target === panel || panel.contains?.(mutation.target);
  }

  function onRuntimeMessage(message) {
    if (message?.type !== 'PREVIEW_VIDEO_CREDITS_PROGRESS' || !state.previewRunning) return;
    state.previewProcessed = Number(message.processed) || state.previewProcessed;
    state.previewTotal = Number(message.total) || state.previewTotal;
    renderPanelState();
  }

  function onMutation(mutations) {
    if (!isSearchPage()) {
      cleanupSearchPage();
      return;
    }

    if (mutations.every(isPanelMutation)) return;
    scheduleScan();
  }

  let controller;

  function cleanup() {
    if (state.disposed) return;
    state.disposed = true;
    clearTimeout(state.scanTimer);
    state.observer?.disconnect();
    document.removeEventListener?.(
      'yt-navigate-finish',
      onNavigateFinish
    );
    globalThis.chrome?.storage?.onChanged?.removeListener?.(onStorageChanged);
    globalThis.chrome?.runtime?.onMessage?.removeListener?.(onRuntimeMessage);
    cleanupSearchPage();

    if (globalThis._ywhOfficialSearchFilter === controller) {
      delete globalThis._ywhOfficialSearchFilter;
    }
  }

  controller = Object.freeze({ cleanup });
  globalThis._ywhOfficialSearchFilter = controller;

  initializePage();
  state.loadPromise = loadSettings();

  if (typeof MutationObserver === 'function' && document.body) {
    state.observer = new MutationObserver(onMutation);
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href'],
    });
  }

  document.addEventListener?.(
    'yt-navigate-finish',
    onNavigateFinish
  );
  globalThis.chrome?.storage?.onChanged?.addListener?.(onStorageChanged);
  globalThis.chrome?.runtime?.onMessage?.addListener?.(onRuntimeMessage);
})();
