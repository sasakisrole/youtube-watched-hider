'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../official_search_filter_core.js');

const STORAGE_KEY = 'officialSearchFilter';
const ROOT = path.join(__dirname, '..');
const RUNTIME_SOURCE = fs.readFileSync(
  path.join(ROOT, 'official_search_filter.js'),
  'utf8'
);
const CSS = fs.readFileSync(
  path.join(ROOT, 'official_search_filter.css'),
  'utf8'
);
const SETTINGS_TEST_PATH = path.join(
  __dirname,
  'verify_official_search_filter_settings.js'
);
const settingsTestSource = fs.readFileSync(SETTINGS_TEST_PATH, 'utf8');
const helperSource = settingsTestSource.slice(
  0,
  settingsTestSource.lastIndexOf('\nasync function main() {')
);
const helpers = new Function(
  'require',
  '__dirname',
  `${helperSource}\nreturn {
    createStorageStub,
    validSettings,
    makeRuntime,
    panel,
    settle,
    loadRuntime,
    createCard,
  };`
)(require, __dirname);
const {
  createStorageStub,
  validSettings,
  makeRuntime,
  panel,
  settle,
  loadRuntime,
  createCard,
} = helpers;

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

function profileSettings({
  mode = 'all',
  channels = [],
  queryBindings = {},
} = {}) {
  return {
    ...validSettings(mode, 'artist'),
    profiles: {
      artist: {
        id: 'artist',
        displayName: 'Artist',
        aliases: [],
        channels,
        mode,
      },
    },
    queryBindings,
  };
}

function control(runtime, selector) {
  return panel(runtime).querySelector(selector);
}

function dispatch(element, type) {
  for (const listener of element.listeners[type] || []) {
    listener({ target: element, currentTarget: element });
  }
}

async function enterAndPrepareChannel(runtime, {
  channelId = '',
  canonicalPath,
  displayName,
}) {
  const idInput = control(runtime, '[data-channel-id-input]');
  const pathInput = control(runtime, '[data-channel-path-input]');
  const nameInput = control(runtime, '[data-channel-name-input]');
  idInput.value = channelId;
  pathInput.value = canonicalPath;
  nameInput.value = displayName;
  control(runtime, '[data-channel-prepare]').click();
  await settle();
}

async function confirmChannel(runtime) {
  control(runtime, '[data-channel-confirm]').click();
  await settle();
}

async function main() {
  console.log('profile CRUD and deterministic ids');
  {
    const storage = createStorageStub(validSettings());
    let runtime = makeRuntime(storage);
    await settle();

    const createInput = control(runtime, '[data-profile-create-input]');
    createInput.value = 'Artist Profile';
    control(runtime, '[data-profile-create]').click();
    await settle();
    check('profile create persists the core profile shape with deterministic id',
      storage.store[STORAGE_KEY].activeProfileId === 'artist-profile' &&
      JSON.stringify(storage.store[STORAGE_KEY].profiles['artist-profile']) ===
        JSON.stringify({
          id: 'artist-profile',
          displayName: 'Artist Profile',
          aliases: [],
          channels: [],
          mode: 'all',
        }));

    createInput.value = 'Artist Profile';
    control(runtime, '[data-profile-create]').click();
    await settle();
    check('duplicate profile names use a deterministic dedupe suffix',
      storage.store[STORAGE_KEY].activeProfileId === 'artist-profile-2' &&
      Boolean(storage.store[STORAGE_KEY].profiles['artist-profile']) &&
      Boolean(storage.store[STORAGE_KEY].profiles['artist-profile-2']) &&
      !/Date\.|Math\.random/.test(RUNTIME_SOURCE));

    runtime.context._ywhOfficialSearchFilter.cleanup();
    runtime = makeRuntime(storage);
    await settle();
    check('created active profile round-trips into a new runtime',
      control(runtime, '[data-profile-select]').value === 'artist-profile-2');

    const renameInput = control(runtime, '[data-profile-rename-input]');
    renameInput.value = 'Renamed Profile';
    control(runtime, '[data-profile-rename]').click();
    await settle();
    check('profile rename preserves id and round-trips in storage',
      storage.store[STORAGE_KEY].profiles['artist-profile-2'].id ===
        'artist-profile-2' &&
      storage.store[STORAGE_KEY].profiles['artist-profile-2'].displayName ===
        'Renamed Profile');

    storage.externalUpdate({
      ...storage.store[STORAGE_KEY],
      queryBindings: {
        'artist query': 'artist-profile-2',
        'kept query': 'artist-profile',
      },
    });
    control(runtime, '[data-profile-delete]').click();
    await settle();
    check('profile delete removes dangling queryBindings only',
      !storage.store[STORAGE_KEY].profiles['artist-profile-2'] &&
      !Object.hasOwn(storage.store[STORAGE_KEY].queryBindings, 'artist query') &&
      storage.store[STORAGE_KEY].queryBindings['kept query'] ===
        'artist-profile');
    check('profile delete selects a remaining profile and updates the UI',
      storage.store[STORAGE_KEY].activeProfileId === 'artist-profile' &&
      control(runtime, '[data-profile-select]').value === 'artist-profile');
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('explicit channel registration and identity safety');
  {
    const storage = createStorageStub(profileSettings());
    const runtime = makeRuntime(storage);
    await settle();
    check('page DOM never auto-registers a scraped or guessed channel path',
      storage.store[STORAGE_KEY].profiles.artist.channels.length === 0);

    await enterAndPrepareChannel(runtime, {
      channelId: 'UC_EXACT',
      canonicalPath: 'https://www.youtube.com/@Artist/',
      displayName: 'Artist Official',
    });
    const target = control(runtime, '[data-channel-target]');
    check('add flow explicitly shows id, normalized path, and name',
      target.hidden === false &&
      target.textContent.includes('UC_EXACT') &&
      target.textContent.includes('/@artist') &&
      target.textContent.includes('Artist Official'));
    check('preview alone does not register the target',
      storage.store[STORAGE_KEY].profiles.artist.channels.length === 0);

    await confirmChannel(runtime);
    let channels = storage.store[STORAGE_KEY].profiles.artist.channels;
    check('confirmed add stores id, explicit normalized path, name, and enabled',
      JSON.stringify(channels[0]) === JSON.stringify({
        channelId: 'UC_EXACT',
        canonicalPath: '/@artist',
        displayName: 'Artist Official',
        enabled: true,
      }));
    check('core classifies the exact authoritative channelId as OFFICIAL',
      core.classifyChannel({
        profile: storage.store[STORAGE_KEY].profiles.artist,
        channel: {
          channelId: 'UC_EXACT',
          canonicalPath: '/@different-path',
          displayName: 'Different Name',
        },
      }) === core.CATEGORY.OFFICIAL);
    check('different channelId with the same path is not rescued by path',
      core.classifyChannel({
        profile: storage.store[STORAGE_KEY].profiles.artist,
        channel: {
          channelId: 'UC_DIFFERENT',
          canonicalPath: '/@artist',
          displayName: 'Artist Official',
        },
      }) !== core.CATEGORY.OFFICIAL);
    check('same-name different-id channel is never auto-confirmed',
      core.classifyChannel({
        profile: storage.store[STORAGE_KEY].profiles.artist,
        channel: {
          channelId: 'UC_NAME_ONLY',
          canonicalPath: '/@someone-else',
          displayName: 'Artist Official',
        },
      }) !== core.CATEGORY.OFFICIAL);

    await enterAndPrepareChannel(runtime, {
      canonicalPath: 'HTTPS://www.youtube.com/@PathOnly/?view=0',
      displayName: 'Path Only',
    });
    await confirmChannel(runtime);
    channels = storage.store[STORAGE_KEY].profiles.artist.channels;
    check('path-only explicit add stores the normalized exact path without id',
      channels.length === 2 &&
      !Object.hasOwn(channels[1], 'channelId') &&
      channels[1].canonicalPath === '/@pathonly');
    check('core path fallback matches a normalized path when id is absent',
      core.classifyChannel({
        profile: storage.store[STORAGE_KEY].profiles.artist,
        channel: {
          canonicalPath: 'https://www.youtube.com/@PATHONLY/',
          displayName: 'Unrelated Name',
        },
      }) === core.CATEGORY.OFFICIAL);

    await enterAndPrepareChannel(runtime, {
      channelId: 'UC_EXACT',
      canonicalPath: '/@explicitly-updated',
      displayName: 'Artist Updated',
    });
    await confirmChannel(runtime);
    channels = storage.store[STORAGE_KEY].profiles.artist.channels;
    check('duplicate channelId merges instead of creating a second entry',
      channels.length === 2 &&
      channels[0].canonicalPath === '/@explicitly-updated');

    await enterAndPrepareChannel(runtime, {
      canonicalPath: '@PATHONLY/',
      displayName: 'Path Only Updated',
    });
    await confirmChannel(runtime);
    channels = storage.store[STORAGE_KEY].profiles.artist.channels;
    check('duplicate normalized path-only add merges without a second entry',
      channels.length === 2 &&
      channels[1].displayName === 'Path Only Updated');

    control(runtime, '[data-channel-remove]').click();
    await settle();
    channels = storage.store[STORAGE_KEY].profiles.artist.channels;
    check('explicit channel remove persists and updates the rendered list',
      channels.length === 1 &&
      channels[0].canonicalPath === '/@pathonly' &&
      panel(runtime).querySelectorAll('[data-channel-remove]').length === 1);
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('classification re-evaluation');
  {
    const storage = createStorageStub(profileSettings({
      mode: 'official',
      queryBindings: { 'artist - topic': 'artist' },
    }));
    const runtime = makeRuntime(storage);
    await settle();
    check('unregistered current card is hidden in official mode',
      runtime.cards.official.classList.contains('ywh-osf-hidden'));
    await enterAndPrepareChannel(runtime, {
      canonicalPath: '/@artist',
      displayName: 'Explicit Artist',
    });
    await confirmChannel(runtime);
    check('successful explicit add re-evaluates and reveals the current card',
      !runtime.cards.official.classList.contains('ywh-osf-hidden'));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('live channelId-only classification');
  {
    const storage = createStorageStub(profileSettings({
      queryBindings: { 'artist - topic': 'artist' },
      channels: [{
        channelId: 'UC_LIVE',
        canonicalPath: '/@does-not-match',
        displayName: 'Saved Source',
        enabled: true,
      }],
    }));
    const baseRuntime = loadRuntime();
    baseRuntime.context.chrome = storage.chrome;
    const results = baseRuntime.document.createElement('main');
    baseRuntime.document.body.appendChild(results);
    const liveCard = createCard(
      baseRuntime.document,
      'live-id',
      '/channel/UC_LIVE',
      'Unrelated Live Name'
    );
    const unregisteredCard = createCard(
      baseRuntime.document,
      'unregistered-id',
      '/channel/UC_UNREGISTERED',
      'Unregistered Source'
    );
    results.appendChild(liveCard);
    results.appendChild(unregisteredCard);
    baseRuntime.run();
    const runtime = { ...baseRuntime, cards: { liveCard, unregisteredCard } };
    await settle();
    control(runtime, '[data-mode="official"]').click();
    await settle();

    check('live runtime honors active-profile channelId when paths differ',
      !liveCard.classList.contains('ywh-osf-hidden') &&
      unregisteredCard.classList.contains('ywh-osf-hidden') &&
      control(runtime, '[data-count="official"]').textContent === '1');
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('honest save failures');
  {
    const storage = createStorageStub(
      profileSettings(),
      { writeLastError: true }
    );
    const runtime = makeRuntime(storage);
    await settle();
    await enterAndPrepareChannel(runtime, {
      channelId: 'UC_FAIL',
      canonicalPath: '/@failed',
      displayName: 'Failed Channel',
    });
    await confirmChannel(runtime);
    check('failed channel save leaves persisted profile unchanged',
      storage.store[STORAGE_KEY].profiles.artist.channels.length === 0);
    check('failed channel save shows no registered row and surfaces error',
      panel(runtime).querySelectorAll('[data-channel-remove]').length === 0 &&
      control(runtime, '#ywh-osf-management-status').dataset.status === 'error');
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }
  {
    const storage = createStorageStub(validSettings(), {
      rejectWrite: true,
    });
    const runtime = makeRuntime(storage);
    await settle();
    const input = control(runtime, '[data-profile-create-input]');
    input.value = 'Must Not Persist';
    control(runtime, '[data-profile-create]').click();
    await settle();
    check('failed profile save is not rendered or persisted as registered',
      Object.keys(storage.store[STORAGE_KEY].profiles).length === 0 &&
      control(runtime, '[data-profile-select]').value === '' &&
      control(runtime, '#ywh-osf-management-status').dataset.status === 'error');
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log('management UI accessibility');
  {
    const storage = createStorageStub(profileSettings());
    const runtime = makeRuntime(storage);
    await settle();
    const management = panel(runtime).querySelector('.ywh-osf-management');
    const controls = management.querySelectorAll('button, input, select');
    check('every management control has an accessible label',
      controls.length >= 10 &&
      controls.every((item) => Boolean(item.getAttribute('aria-label'))));
    check('management controls are keyboard-native with no negative tabindex',
      controls.every((item) =>
        ['BUTTON', 'INPUT', 'SELECT'].includes(item.tagName) &&
        item.getAttribute('tabindex') !== '-1'
      ));
    check('management CSS provides 44px targets and visible focus',
      CSS.includes('.ywh-osf-action-button') &&
      CSS.includes('min-height: 44px') &&
      CSS.includes('.ywh-osf-field input:focus-visible') &&
      CSS.includes('.ywh-osf-field select:focus-visible'));
    check('management markup contains no emoji',
      !/[\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u20E3\u{1F300}-\u{1FAFF}]/u
        .test(RUNTIME_SOURCE));
    runtime.context._ywhOfficialSearchFilter.cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
