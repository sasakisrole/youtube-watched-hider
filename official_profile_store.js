(() => {
  'use strict';

  const core = globalThis.YWHOfficialSearchFilterCore ||
    (typeof require === 'function'
      ? require('./official_search_filter_core.js')
      : null);

  if (!core || typeof core.normalizeChannelPath !== 'function') return;

  const { MODE, normalizeChannelPath, normalizeText } = core;
  const STORAGE_KEY = 'officialSearchFilter';
  const SETTINGS_SCHEMA_VERSION = 1;
  const CHANNEL_ID_MIGRATION_UNRESOLVED = 'unresolved-lowercase';

  function createDefaultSettings() {
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      activeProfileId: null,
      globalMode: MODE.ALL,
      hideOtherGlobal: false,
      profiles: {},
      queryBindings: {},
      candidateExclusions: [],
    };
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  }

  function isValidMode(mode) {
    return mode === MODE.ALL ||
      mode === MODE.OFFICIAL ||
      mode === MODE.DISCOVERY;
  }

  function sanitizeChannel(value) {
    if (!isPlainObject(value)) return null;

    const channelId = String(value.channelId ?? '').trim();
    const navigablePath = typeof core.canonicalChannelPath === 'function'
      ? core.canonicalChannelPath(value.canonicalPath)
      : normalizeChannelPath(value.canonicalPath);
    const canonicalPath = /^\/channel\/UC[A-Za-z0-9_-]{22}$/.test(navigablePath)
      ? navigablePath
      : normalizeChannelPath(navigablePath);
    const displayName = String(value.displayName ?? '').trim();
    // 候補一覧の出どころ（Analyze の集計チャンネル名）。登録済み判定の主キーにする。
    // プロフィール名を編集して保存しても候補と結び付けられるようにするため。
    const sourceChannelName = String(value.sourceChannelName ?? '').trim();
    if (!channelId && !canonicalPath) return null;

    return {
      ...(channelId ? { channelId } : {}),
      ...(canonicalPath ? { canonicalPath } : {}),
      ...(sourceChannelName ? { sourceChannelName } : {}),
      displayName,
      enabled: value.enabled !== false,
      ...(value.channelIdMigration === CHANNEL_ID_MIGRATION_UNRESOLVED
        ? { channelIdMigration: CHANNEL_ID_MIGRATION_UNRESOLVED }
        : {}),
    };
  }

  function duplicateChannelIndex(channels, target) {
    const targetId = String(target?.channelId ?? '').trim();
    const targetPath = normalizeChannelPath(target?.canonicalPath);

    return channels.findIndex((channel) => {
      const channelId = String(channel?.channelId ?? '').trim();
      if (targetId && channelId) return targetId === channelId;
      const channelPath = normalizeChannelPath(channel?.canonicalPath);
      return Boolean(targetPath && channelPath && targetPath === channelPath);
    });
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

  const MAX_EXCLUSIONS = 500;

  function sanitizeCandidateExclusions(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const name = entry.trim();
      if (!name) continue;
      const key = normalizeText(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(name);
      if (result.length >= MAX_EXCLUSIONS) break;
    }
    return result;
  }

  // 候補（Analyze の集計チャンネル）が、すでにプロフィールとして登録済みかを判定する。
  // 主キーは sourceChannelName。旧データ（v1.43.7 以前の登録）には無いので、
  // チャンネル表示名・プロフィール表示名でもフォールバック照合する。
  function findRegisteredProfileId(settingsValue, candidate) {
    const settings = sanitizeSettings(settingsValue);
    const channelKey = normalizeText(candidate?.channelName);
    const profileKey = normalizeText(candidate?.profileName);
    if (!channelKey && !profileKey) return null;

    for (const profile of Object.values(settings.profiles)) {
      for (const channel of profile.channels) {
        const sourceKey = normalizeText(channel.sourceChannelName);
        if (sourceKey && channelKey && sourceKey === channelKey) return profile.id;
      }
    }
    for (const profile of Object.values(settings.profiles)) {
      if (profileKey && normalizeText(profile.displayName) === profileKey) return profile.id;
      for (const channel of profile.channels) {
        const displayKey = normalizeText(channel.displayName);
        if (displayKey && channelKey && displayKey === channelKey) return profile.id;
      }
    }
    return null;
  }

  function sanitizeSettingsBase(value) {
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
      queryBindings: sanitizeQueryBindings(value.queryBindings, profiles),
      candidateExclusions: sanitizeCandidateExclusions(value.candidateExclusions),
    };
  }

  function isLowercaseChannelIdCandidate(value) {
    return /^uc[a-z0-9_-]{22}$/.test(String(value ?? '').trim());
  }

  function authoritativeChannelId(value) {
    const channelId = String(value?.channelId ?? '').trim();
    if (/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) return channelId;
    const canonicalPath = typeof core.canonicalChannelPath === 'function'
      ? core.canonicalChannelPath(value?.canonicalPath)
      : String(value?.canonicalPath ?? '').trim();
    const match = canonicalPath.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})$/);
    return match?.[1] || '';
  }

  function migrateSanitizedLowercaseChannelIds(settings, recoveryChannels = []) {
    const evidenceByLowercaseId = new Map();
    const addEvidence = (value) => {
      const channelId = authoritativeChannelId(value);
      if (!channelId) return;
      const key = channelId.toLowerCase();
      if (!evidenceByLowercaseId.has(key)) {
        evidenceByLowercaseId.set(key, new Set());
      }
      evidenceByLowercaseId.get(key).add(channelId);
    };

    for (const profile of Object.values(settings.profiles)) {
      for (const channel of profile.channels) addEvidence({
        canonicalPath: channel.canonicalPath,
      });
    }
    if (Array.isArray(recoveryChannels)) {
      for (const channel of recoveryChannels) addEvidence(channel);
    }

    let changed = false;
    let recoveredCount = 0;
    let unresolvedCount = 0;
    for (const profile of Object.values(settings.profiles)) {
      for (const channel of profile.channels) {
        if (!isLowercaseChannelIdCandidate(channel.channelId)) {
          if (channel.channelIdMigration === CHANNEL_ID_MIGRATION_UNRESOLVED) {
            delete channel.channelIdMigration;
            changed = true;
          }
          continue;
        }

        const evidence = evidenceByLowercaseId.get(channel.channelId);
        if (evidence?.size === 1) {
          const [recoveredId] = evidence;
          channel.channelId = recoveredId;
          if (
            normalizeChannelPath(channel.canonicalPath) ===
            `/channel/${recoveredId.toLowerCase()}`
          ) {
            channel.canonicalPath = `/channel/${recoveredId}`;
          }
          if (channel.channelIdMigration) delete channel.channelIdMigration;
          changed = true;
          recoveredCount += 1;
          continue;
        }

        unresolvedCount += 1;
        if (channel.channelIdMigration !== CHANNEL_ID_MIGRATION_UNRESOLVED) {
          channel.channelIdMigration = CHANNEL_ID_MIGRATION_UNRESOLVED;
          changed = true;
        }
      }
    }

    return {
      changed,
      settings,
      recoveredCount,
      unresolvedCount,
    };
  }

  function migrateLowercaseChannelIds(settingsValue, recoveryChannels = []) {
    return migrateSanitizedLowercaseChannelIds(
      sanitizeSettingsBase(settingsValue),
      recoveryChannels
    );
  }

  function sanitizeSettings(value) {
    return migrateLowercaseChannelIds(value).settings;
  }

  function generateProfileId(displayName, profiles) {
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

  function createProfile(settingsValue, displayName) {
    const name = String(displayName ?? '').trim();
    if (!name) return { changed: false, settings: sanitizeSettings(settingsValue) };

    const settings = sanitizeSettings(settingsValue);
    const id = generateProfileId(name, settings.profiles);
    settings.profiles[id] = {
      id,
      displayName: name,
      aliases: [],
      channels: [],
      mode: MODE.ALL,
    };
    settings.activeProfileId = id;
    return { changed: true, settings, profileId: id };
  }

  function addChannel(settingsValue, profileIdValue, target, options = {}) {
    const settings = sanitizeSettings(settingsValue);
    if (options.confirmed !== true) {
      return {
        changed: false,
        settings,
        reason: 'confirmation-required',
      };
    }

    const profileId = String(profileIdValue ?? '').trim();
    const profile = settings.profiles[profileId];
    const channel = sanitizeChannel(target);
    if (!profile || !channel || !channel.canonicalPath) {
      return { changed: false, settings, reason: 'invalid-target' };
    }

    const duplicateIndex = duplicateChannelIndex(profile.channels, channel);
    if (duplicateIndex >= 0) {
      profile.channels[duplicateIndex] = {
        ...profile.channels[duplicateIndex],
        ...channel,
        enabled: true,
      };
    } else {
      profile.channels.push({ ...channel, enabled: true });
    }
    return { changed: true, settings, profileId };
  }

  function mutateConfirmedRegistration(settingsValue, registration) {
    let settings = sanitizeSettings(settingsValue);
    if (registration?.confirmed !== true) {
      return {
        changed: false,
        settings,
        reason: 'confirmation-required',
      };
    }

    const profileName = String(registration.profileName ?? '').trim();
    const channel = sanitizeChannel(registration.channel);
    if (!profileName || !channel || !channel.canonicalPath) {
      return { changed: false, settings, reason: 'invalid-target' };
    }

    // 二重登録の防止。同じチャンネルが既にどれかのプロフィールに入っているなら
    // 新しいプロフィールを作らない（従来は createProfile が毎回走り、同名でも
    // id に -2 が付いた別プロフィールが増えていた）。
    for (const existing of Object.values(settings.profiles)) {
      if (duplicateChannelIndex(existing.channels, channel) >= 0) {
        return {
          changed: false,
          settings,
          reason: 'already-registered',
          profileId: existing.id,
        };
      }
    }
    const alreadyBySource = findRegisteredProfileId(settings, {
      channelName: channel.sourceChannelName,
      profileName,
    });
    if (alreadyBySource) {
      return {
        changed: false,
        settings,
        reason: 'already-registered',
        profileId: alreadyBySource,
      };
    }

    const created = createProfile(settings, profileName);
    settings = created.settings;
    const profile = settings.profiles[created.profileId];

    const added = addChannel(settings, profile.id, channel, {
      confirmed: true,
    });
    if (!added.changed) return added;
    settings = added.settings;
    settings.activeProfileId = profile.id;

    if (registration.bindQuery === true) {
      const query = normalizeText(registration.query);
      if (query) settings.queryBindings[query] = profile.id;
    }

    return {
      changed: true,
      settings,
      profileId: profile.id,
      createdProfile: true,
    };
  }

  function storageGet(storageArea) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        const lastError = globalThis.chrome?.runtime?.lastError;
        if (lastError) reject(new Error(lastError.message || 'Storage read failed'));
        else resolve(result || {});
      };
      try {
        const pending = storageArea.get(STORAGE_KEY, finish);
        if (pending?.then) pending.then(finish, reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  function storageSet(storageArea, settings) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const lastError = globalThis.chrome?.runtime?.lastError;
        if (lastError) reject(new Error(lastError.message || 'Storage write failed'));
        else resolve();
      };
      try {
        const pending = storageArea.set({ [STORAGE_KEY]: settings }, finish);
        if (pending?.then) pending.then(finish, reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  function setCandidateExcluded(settingsValue, channelName, excluded) {
    const settings = sanitizeSettings(settingsValue);
    const name = String(channelName ?? '').trim();
    if (!name) return { changed: false, settings, reason: 'invalid-target' };

    const key = normalizeText(name);
    const index = settings.candidateExclusions
      .findIndex((entry) => normalizeText(entry) === key);
    if (excluded === false) {
      if (index < 0) return { changed: false, settings, reason: 'unchanged' };
      settings.candidateExclusions.splice(index, 1);
      return { changed: true, settings };
    }
    if (index >= 0) return { changed: false, settings, reason: 'unchanged' };
    if (settings.candidateExclusions.length >= MAX_EXCLUSIONS) {
      return { changed: false, settings, reason: 'limit-reached' };
    }
    settings.candidateExclusions.push(name);
    return { changed: true, settings };
  }

  async function loadSettings(storageArea) {
    const area = storageArea || globalThis.chrome?.storage?.local;
    if (!area) return createDefaultSettings();
    const stored = await storageGet(area);
    const migration = migrateLowercaseChannelIds(stored[STORAGE_KEY]);
    if (migration.changed) await storageSet(area, migration.settings);
    return migration.settings;
  }

  async function updateCandidateExclusion(channelName, excluded, storageArea) {
    const area = storageArea || globalThis.chrome?.storage?.local;
    if (!area) return { saved: false, reason: 'storage-unavailable' };
    const stored = await storageGet(area);
    const result = setCandidateExcluded(stored[STORAGE_KEY], channelName, excluded);
    if (!result.changed) {
      return { saved: false, reason: result.reason || 'unchanged', settings: result.settings };
    }
    await storageSet(area, result.settings);
    return { saved: true, settings: result.settings };
  }

  async function registerConfirmed(registration, storageArea) {
    if (registration?.confirmed !== true) {
      return { saved: false, reason: 'confirmation-required' };
    }
    const area = storageArea || globalThis.chrome?.storage?.local;
    if (!area) return { saved: false, reason: 'storage-unavailable' };

    const stored = await storageGet(area);
    const migration = migrateLowercaseChannelIds(
      stored[STORAGE_KEY],
      [registration.channel]
    );
    const result = mutateConfirmedRegistration(
      migration.settings,
      registration
    );
    if (!result.changed) {
      if (migration.changed) await storageSet(area, result.settings);
      return { saved: false, reason: result.reason || 'unchanged' };
    }
    await storageSet(area, result.settings);
    return {
      saved: true,
      settings: result.settings,
      profileId: result.profileId,
      createdProfile: result.createdProfile,
    };
  }

  const api = Object.freeze({
    STORAGE_KEY,
    createDefaultSettings,
    sanitizeChannel,
    sanitizeSettings,
    migrateLowercaseChannelIds,
    isLowercaseChannelIdCandidate,
    CHANNEL_ID_MIGRATION_UNRESOLVED,
    duplicateChannelIndex,
    generateProfileId,
    createProfile,
    addChannel,
    mutateConfirmedRegistration,
    registerConfirmed,
    sanitizeCandidateExclusions,
    findRegisteredProfileId,
    setCandidateExcluded,
    updateCandidateExclusion,
    loadSettings,
  });

  globalThis.YWHOfficialProfileStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
