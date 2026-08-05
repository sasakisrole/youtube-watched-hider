#!/usr/bin/env node
'use strict';

const store = require('../official_profile_store.js');

const RECOVERED_ID = 'UCuAXFkgsw1L7xaCfnd5JJOw';
const LOWERCASE_ID = RECOVERED_ID.toLowerCase();
const UNRESOLVED_ID = 'ucaaaaaaaaaaaaaaaaaaaaaa';

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

function settingsWithChannels(channels) {
  const profiles = {};
  channels.forEach((channel, index) => {
    const id = `profile-${index}`;
    profiles[id] = {
      id,
      displayName: `Profile ${index}`,
      aliases: [],
      channels: [channel],
      mode: 'all',
    };
  });
  return {
    schemaVersion: 1,
    activeProfileId: 'profile-0',
    globalMode: 'all',
    hideOtherGlobal: false,
    profiles,
    queryBindings: {},
    candidateExclusions: [],
  };
}

function channelCount(settings) {
  return Object.values(settings.profiles).reduce(
    (sum, profile) => sum + profile.channels.length,
    0
  );
}

function createStorageStub(initialSettings) {
  const state = { [store.STORAGE_KEY]: initialSettings };
  return {
    state,
    getCount: 0,
    setCount: 0,
    get(key, callback) {
      this.getCount += 1;
      const result = { [key]: state[key] };
      callback?.(result);
      return Promise.resolve(result);
    },
    set(update, callback) {
      this.setCount += 1;
      Object.assign(state, update);
      callback?.();
      return Promise.resolve();
    },
  };
}

function brokenChannel(channelId, displayName) {
  return {
    channelId,
    canonicalPath: `/channel/${channelId}`,
    displayName,
    enabled: true,
  };
}

async function main() {
  console.log('safe lowercase channelId migration');
  const before = settingsWithChannels([
    brokenChannel(LOWERCASE_ID, 'Recoverable'),
    brokenChannel(UNRESOLVED_ID, 'Unresolved'),
    brokenChannel('UC0123456789012345678901', 'Already Correct'),
  ]);
  const beforeCount = channelCount(before);
  const evidence = [{
    channelId: RECOVERED_ID,
    canonicalPath: `/channel/${RECOVERED_ID}`,
  }];
  const migrated = store.migrateLowercaseChannelIds(before, evidence);
  const recovered = migrated.settings.profiles['profile-0'].channels[0];
  const unresolved = migrated.settings.profiles['profile-1'].channels[0];

  check('confirmed authoritative evidence restores exact channelId case',
    migrated.changed === true &&
    migrated.recoveredCount === 1 &&
    recovered.channelId === RECOVERED_ID &&
    recovered.canonicalPath === `/channel/${RECOVERED_ID}` &&
    !Object.hasOwn(recovered, 'channelIdMigration'));
  check('record without evidence remains byte-for-byte identified and marked unresolved',
    unresolved.channelId === UNRESOLVED_ID &&
    unresolved.canonicalPath === `/channel/${UNRESOLVED_ID}` &&
    unresolved.channelIdMigration === store.CHANNEL_ID_MIGRATION_UNRESOLVED);
  check('migration never reduces the stored channel record count',
    channelCount(migrated.settings) === beforeCount);

  const second = store.migrateLowercaseChannelIds(migrated.settings, evidence);
  check('running the same migration twice is idempotent',
    second.changed === false &&
    JSON.stringify(second.settings) === JSON.stringify(migrated.settings) &&
    channelCount(second.settings) === beforeCount);

  console.log('ambiguous evidence remains unresolved');
  const ambiguousLower = 'ucabcdefghijklmnopqrstuv';
  const ambiguous = store.migrateLowercaseChannelIds(
    settingsWithChannels([brokenChannel(ambiguousLower, 'Ambiguous')]),
    [
      { channelId: 'UCAbcdefghijklmnopqrstuv' },
      { channelId: 'UCaBcdefghijklmnopqrstuv' },
    ]
  );
  const ambiguousChannel = ambiguous.settings.profiles['profile-0'].channels[0];
  check('conflicting case evidence is never guessed',
    ambiguous.recoveredCount === 0 &&
    ambiguousChannel.channelId === ambiguousLower &&
    ambiguousChannel.channelIdMigration === store.CHANNEL_ID_MIGRATION_UNRESOLVED);

  console.log('confirmed Analyze registration repairs an existing record');
  const repairStorage = createStorageStub(settingsWithChannels([
    brokenChannel(LOWERCASE_ID, 'Recoverable'),
  ]));
  const repairRegistration = {
    profileName: 'Recoverable',
    channel: {
      channelId: RECOVERED_ID,
      canonicalPath: `/channel/${RECOVERED_ID}`,
      displayName: 'Recoverable',
    },
    confirmed: true,
    bindQuery: false,
  };
  const repair = await store.registerConfirmed(repairRegistration, repairStorage);
  const repaired = repairStorage.state[store.STORAGE_KEY]
    .profiles['profile-0'].channels[0];
  check('user-confirmed exact URL repairs storage without duplicating the profile',
    repair.saved === false &&
    repair.reason === 'already-registered' &&
    repairStorage.setCount === 1 &&
    repaired.channelId === RECOVERED_ID &&
    channelCount(repairStorage.state[store.STORAGE_KEY]) === 1);

  const repeatRepair = await store.registerConfirmed(repairRegistration, repairStorage);
  check('repeating confirmed repair performs no second migration write',
    repeatRepair.saved === false &&
    repeatRepair.reason === 'already-registered' &&
    repairStorage.setCount === 1);

  console.log('automatic unresolved marker persistence');
  const unresolvedStorage = createStorageStub(settingsWithChannels([
    brokenChannel(UNRESOLVED_ID, 'Unresolved'),
  ]));
  const firstLoad = await store.loadSettings(unresolvedStorage);
  const secondLoad = await store.loadSettings(unresolvedStorage);
  check('first load persists an explicit unresolved marker without deleting data',
    unresolvedStorage.setCount === 1 &&
    firstLoad.profiles['profile-0'].channels[0].channelId === UNRESOLVED_ID &&
    firstLoad.profiles['profile-0'].channels[0].channelIdMigration ===
      store.CHANNEL_ID_MIGRATION_UNRESOLVED &&
    channelCount(firstLoad) === 1);
  check('second load is idempotent and does not write again',
    unresolvedStorage.setCount === 1 &&
    JSON.stringify(secondLoad) === JSON.stringify(firstLoad));

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
