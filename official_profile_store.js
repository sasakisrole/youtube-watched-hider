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

  function sanitizeSettings(value) {
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
    };
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

  async function registerConfirmed(registration, storageArea) {
    if (registration?.confirmed !== true) {
      return { saved: false, reason: 'confirmation-required' };
    }
    const area = storageArea || globalThis.chrome?.storage?.local;
    if (!area) return { saved: false, reason: 'storage-unavailable' };

    const stored = await storageGet(area);
    const result = mutateConfirmedRegistration(
      stored[STORAGE_KEY],
      registration
    );
    if (!result.changed) {
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
    duplicateChannelIndex,
    generateProfileId,
    createProfile,
    addChannel,
    mutateConfirmedRegistration,
    registerConfirmed,
  });

  globalThis.YWHOfficialProfileStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
