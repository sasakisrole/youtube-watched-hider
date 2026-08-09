// Executes extracted liked-sync production paths with fake browser dependencies only.
// Run: node tests/verify_liked_sync_behavior.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const ct = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const az = fs.readFileSync(path.join(root, 'analyzer.js'), 'utf8');

function between(src, a, b) {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`markers not found: ${a} / ${b}`);
  return src.slice(i, j);
}
function fn(name, src) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('(', start), p = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') p++;
    else if (src[i] === ')' && --p === 0) { i++; break; }
  }
  i = src.indexOf('{', i);
  let d = 0, q = '', line = false, block = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if ('"\'`'.includes(c)) { q = c; continue; }
    if (c === '{') d++;
    else if (c === '}' && --d === 0) return src.slice(start, i + 1);
  }
  throw new Error('unterminated function: ' + name);
}
function top(name) {
  let i = bg.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  if (bg.slice(i - 6, i) === 'async ') i -= 6;
  const j = bg.indexOf('\nfunction ', i + 1);
  return bg.slice(i, j < 0 ? bg.length : j);
}
let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

const proxy = between(ct, 'const PROXY_FETCH_TIMEOUT_MS',
  '\n  chrome.runtime.onMessage.addListener(onMessage);');
function content(document, fetch) {
  return new Function('deps',
    'const {document,fetch,AbortController,setTimeout,clearTimeout,computeSapisidHash}=deps;\n'
    + fn('getYouTubeSyncContext', ct) + '\n' + proxy
    + '\nreturn {onMessage};')({ document, fetch, AbortController,
      setTimeout, clearTimeout, computeSapisidHash: async () => 'fake-auth' });
}
function message(handler, payload) {
  return new Promise((resolve, reject) => {
    try { if (handler(payload, {}, resolve) !== true) reject(new Error('message channel closed')); }
    catch (e) { reject(e); }
  });
}
const itemExtractor = eval('(function(){' + top('findFirstContinuationToken') + '\n'
  + top('extractItemsAndContinuation') + '\nreturn extractItemsAndContinuation;})()');
const ownerExtractor = eval('(function(){' + fn('extractOwnerIdentity', bg)
  + '\nreturn extractOwnerIdentity;})()');
function chromeStorage() {
  const data = {};
  return { data, chrome: { storage: { local: {
    get: (defaults, cb) => cb({ ...defaults, ...data }),
    set: (values, cb) => { Object.assign(data, values); if (cb) cb(); },
  } } } };
}
function sync(deps) {
  const tab = async (m, id) => m.type === 'GET_YOUTUBE_SYNC_CONTEXT'
    ? deps.context(m, id) : deps.tab(m, id);
  const db = async (op, payload) => op === 'GET_LIKED_STATS'
    ? { total: 0, accounts: [] } : deps.db(op, payload);
  return new Function('sendToYouTubeTab', 'sendToOffscreenDb', 'chrome',
    'parseLikedPlaylistHtml', 'extractYtcfg', 'extractItemsAndContinuation',
    'extractOwnerIdentity', fn('syncLikedPlaylist', bg) + '\nreturn syncLikedPlaylist;')(
      tab, db, deps.chrome, deps.parse, deps.ytcfg, itemExtractor, ownerExtractor);
}
function page(id, token = '') {
  const items = [{ lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentId: id, metadata: { lockupMetadataViewModel: { title: { content: id } } } } }];
  if (token) items.push({ continuationItemRenderer: {
    continuationEndpoint: { continuationCommand: { token } },
  } });
  return { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }] };
}

async function testsA() {
  console.log('A. captured authUser -> real fetch headers');
  {
    const calls = [];
    const mod = content({ documentElement: { innerHTML: '"SESSION_INDEX":"99"' } },
      async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({}) }; });
    const r = await message(mod.onMessage, {
      type: 'FETCH_INNERTUBE_BROWSE', authUser: '6', apiKey: 'k', body: {},
    });
    check('REQ-A1 actual InnerTube fetch receives captured X-Goog-AuthUser',
      r.success && calls.length === 1 && calls[0].options.headers['X-Goog-AuthUser'] === '6'
      && calls[0].options.headers['X-Goog-AuthUser'] !== '0');
  }
  {
    const doc = { documentElement: { innerHTML:
      '"SESSION_INDEX":"7","LOGGED_IN_USER_ACCOUNT_ID":"start"' } };
    const headers = [];
    const mod = content(doc, async (url, options = {}) => {
      if (!url.includes('/youtubei/')) return { ok: true, url, text: async () => '<html></html>' };
      headers.push(options.headers['X-Goog-AuthUser']);
      const body = JSON.parse(options.body);
      if (body.browseId) {
        doc.documentElement.innerHTML = '"SESSION_INDEX":"9","LOGGED_IN_USER_ACCOUNT_ID":"other"';
        return { ok: true, json: async () => page('videoid0001', 'NEXT') };
      }
      return { ok: true, json: async () => page('videoid0002') };
    });
    let writes = 0;
    const { chrome } = chromeStorage();
    const run = sync({ chrome,
      context: async (m) => ({ ...(await message(mod.onMessage, m)), tabId: 41 }), tab: (m) => message(mod.onMessage, m),
      db: async () => { writes++; return { added: 2 }; },
      parse: () => ({ items: [], continuation: '', ownerName: 'Owner',
        ownerHandle: '@owner', ownerChannelId: 'UCowner' }),
      ytcfg: () => ({ apiKey: 'k', clientVersion: '1', context: { client: {} }, authUser: '' }),
    });
    const r = await run({ confirmAccountChange: true, confirmUnknownAccount: true });
    check('REQ-A2 page-to-page fetches retain start authUser after live account change',
      headers.length === 2 && headers.every(x => x === '7')
      && !r.success && r.reason === 'sync-session-changed' && r.dbWriteSkipped && writes === 0);
  }
  {
    const mod = content({ documentElement: { innerHTML: '<html>no session</html>' } },
      async () => { throw new Error('fetch must not run'); });
    let writes = 0;
    const { chrome } = chromeStorage();
    const run = sync({ chrome, context: async m => ({ ...(await message(mod.onMessage, m)), tabId: 41 }),
      tab: m => message(mod.onMessage, m), db: async () => { writes++; return {}; },
      parse: () => ({}), ytcfg: () => ({}) });
    const r = await run();
    check('REQ-A3 missing authUser fails closed before fetch or storage',
      !r.success && r.reason === 'sync-account-unavailable' && writes === 0);
  }
}

class Button {
  constructor() { this.disabled = false; this.listeners = []; }
  addEventListener(type, listener) { if (type === 'click') this.listeners.push(listener); }
  async click() { for (const listener of this.listeners) await listener({ target: this }); }
}
const buttonBlock = between(az, '  // Sync liked playlist button', '\n  // Copy prompt button');
function buttonHarness(response) {
  const button = new Button(), msg = { textContent: '' }, sent = [], confirms = [];
  const document = { getElementById: id => id === 'azSyncLiked' ? button : id === 'azLikedMsg' ? msg : null };
  const window = { confirm: text => { confirms.push(text); return false; } };
  const chrome = { runtime: { sendMessage: (m, cb) => { sent.push({ ...m }); cb(response); } } };
  new Function('document', 'window', 'chrome', 'reloadLikedAfterSync', 'console',
    fn('resolveLikedSync', az) + '\n' + buttonBlock)(
      document, window, chrome, async () => {}, { warn() {}, info() {} });
  return { button, msg, sent, confirms };
}
async function testsB() {
  console.log('\nB. real sync button -> confirmation escalation');
  const unknown = buttonHarness({ success: false, reason: 'account-unknown', current: {} });
  await unknown.button.click();
  check('REQ-B1 actual sync-button click evaluates the confirmation guard',
    unknown.confirms.length === 1 && unknown.confirms[0].includes('アカウントを識別できません'));
  const changed = buttonHarness({ success: false, reason: 'account-changed',
    previous: { accountId: 'old' }, current: { accountId: 'new' } });
  await changed.button.click();
  check('REQ-B2 ownerless and account-changed cannot bypass the actual button guard',
    [unknown, changed].every(h => h.confirms.length === 1 && h.sent.length === 1
      && h.msg.textContent === 'キャンセルしました'));
  check('REQ-B3 rejecting confirmation prevents the guarded sync rerun',
    [unknown, changed].every(h => h.sent.length === 1
      && !h.sent[0].confirmUnknownAccount && !h.sent[0].confirmAccountChange && !h.button.disabled));
}

const importBlock = between(bg, "  if (message.type === 'IMPORT_DATA')",
  "\n  if (message.type === 'DELETE_VIDEO')");
function importHarness(result) {
  const storage = { likedSyncMeta: { accountId: 'stale' } }, writes = [], ops = [];
  const get = async defaults => ({ ...defaults, ...storage });
  const set = async values => { writes.push(structuredClone(values)); Object.assign(storage, values); };
  const send = async op => {
    ops.push(op);
    if (op === 'EXPORT_DATA') return { watchedVideos: [], likedVideos: [], likedSyncMeta: null };
    return structuredClone(result);
  };
  const factory = new Function('sendToOffscreenDb', 'storageLocalGet', 'storageLocalSet',
    'storageLocalSetChecked', 'broadcastCacheInvalidated', 'chrome',
    fn('getImportedLikedCount', bg) + '\n' + fn('getUnverifiedImportedLikedMeta', bg) + '\n'
    + fn('storeImportedMeta', bg) + '\n' + fn('storeImportedMetaIfAbsent', bg) + '\n'
    + fn('getReplaceImportedLikedMeta', bg)
    + '\nreturn function(message,sender,sendResponse){\n' + importBlock + '\nreturn false;};');
  const handler = factory(send, get, set, set, () => {},
    { runtime: { getManifest: () => ({ version: 'test' }) } });
  return { handler, storage, writes, ops };
}
async function importMode(type) {
  const h = importHarness({ liked: { imported: 3, failed: false },
    likedSyncMeta: null, watchedIds: [], count: 0 });
  const response = await message(h.handler, { type, data: {} });
  const m = h.storage.likedSyncMeta;
  return { ...h, ok: response.success && h.writes.length === 1 && m.ownerUnverified
    && m.accountId === '' && m.restoredLikedCount === 3 && Number.isFinite(m.restoredAt) };
}
async function testsC() {
  console.log('\nC. real import handlers -> ownerless metadata storage');
  const replace = await importMode('REPLACE_IMPORT');
  check('REQ-C1 replace handler saves ownerless metadata', replace.ok && replace.ops.includes('REPLACE_APPLY'));
  const safe = await importMode('MERGE_IMPORT');
  check('REQ-C2 safe-merge handler saves ownerless metadata', safe.ok && safe.ops.join() === 'MERGE_IMPORT');
  const backup = await importMode('IMPORT_DATA');
  check('REQ-C3 backup-merge handler saves ownerless metadata', backup.ok && backup.ops.join() === 'IMPORT_DATA');
}

testsA().then(testsB).then(testsC).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error('harness error:', e); process.exit(1); });
