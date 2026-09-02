#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../official_profile_store.js');

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

function createStorageStub() {
  const state = {};
  return {
    state,
    getCount: 0,
    setCount: 0,
    get(key, callback) {
      this.getCount += 1;
      const result = Object.hasOwn(state, key) ? { [key]: state[key] } : {};
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

function registration(bindQuery, confirmed = true) {
  return {
    profileName: 'Binding Artist',
    query: 'Binding Artist',
    channel: {
      channelId: 'UC_BINDING',
      canonicalPath: '/channel/UC_BINDING',
      displayName: 'Binding Artist - Topic',
    },
    confirmed,
    bindQuery,
  };
}

function createInput() {
  const listeners = new Map();
  return {
    checked: false,
    addEventListener(type, listener) {
      const registered = listeners.get(type) || [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener();
    },
  };
}

function verifyConfirmationReset(analyzer) {
  const elements = {
    azOfficialProfileName: createInput(),
    azOfficialChannelUrl: createInput(),
    azOfficialConfirmed: createInput(),
  };
  const start = analyzer.indexOf('let currentOfficialCandidate = null;');
  const end = analyzer.indexOf('\n  async function runAnalysis()', start);
  if (start < 0 || end < 0) return null;
  const document = {
    getElementById(id) {
      return elements[id] || null;
    },
  };
  new Function('document', 'window', analyzer.slice(start, end))(document, {});

  elements.azOfficialConfirmed.checked = true;
  elements.azOfficialProfileName.dispatch('input');
  const profileReset = elements.azOfficialConfirmed.checked === false;
  elements.azOfficialConfirmed.checked = true;
  elements.azOfficialChannelUrl.dispatch('input');
  const urlReset = elements.azOfficialConfirmed.checked === false;
  return { profileReset, urlReset };
}

async function main() {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'history.html'), 'utf8');
  const analyzer = fs.readFileSync(path.join(root, 'analyzer.js'), 'utf8');
  const checkboxTag = html.match(/<input[^>]+id="azOfficialBindQuery"[^>]*>/)?.[0] || '';

  console.log('Analyze binding UI wiring');
  check('binding checkbox exists and is off by default',
    Boolean(checkboxTag) && !/\schecked(?:\s|=|>)/i.test(checkboxTag));
  check('opening each candidate resets the optional binding to off',
    /azOfficialBindQuery'\)\.checked\s*=\s*false/.test(analyzer));
  check('the selected checkbox value is passed through instead of hard-coded',
    /const bindQuery\s*=\s*document\.getElementById\('azOfficialBindQuery'\)\.checked/.test(analyzer) &&
    /confirmed:\s*true,\s*query,\s*bindQuery,/s.test(analyzer) &&
    !/confirmed:\s*true,\s*bindQuery:\s*false/s.test(analyzer));
  check('the candidate search term is passed as the binding query',
    /const query\s*=\s*String\(currentOfficialCandidate\.profileName/.test(analyzer));
  const confirmationReset = verifyConfirmationReset(analyzer);
  check('editing the official profile name clears confirmation',
    confirmationReset?.profileReset === true);
  check('editing the channel URL clears confirmation',
    confirmationReset?.urlReset === true);

  console.log('binding persistence gate');
  const defaultStorage = createStorageStub();
  const defaultResult = await store.registerConfirmed(registration(false), defaultStorage);
  const defaultSettings = defaultStorage.state[store.STORAGE_KEY];
  check('default-off registration persists no query binding',
    defaultResult.saved === true &&
    Object.keys(defaultSettings.queryBindings).length === 0);

  const selectedStorage = createStorageStub();
  const selectedResult = await store.registerConfirmed(registration(true), selectedStorage);
  const selectedSettings = selectedStorage.state[store.STORAGE_KEY];
  check('explicit selection alone persists the normalized query binding',
    selectedResult.saved === true &&
    selectedSettings.queryBindings['binding artist'] === selectedResult.profileId);

  const unconfirmedStorage = createStorageStub();
  const rejected = await store.registerConfirmed(registration(true, false), unconfirmedStorage);
  check('unconfirmed binding path saves nothing',
    rejected.saved === false &&
    rejected.reason === 'confirmation-required' &&
    unconfirmedStorage.getCount === 0 &&
    unconfirmedStorage.setCount === 0 &&
    Object.keys(unconfirmedStorage.state).length === 0);

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
