// Run: node tests/verify_i18n_history_static.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const html = read('history.html');
const source = read('history.js');
const ja = JSON.parse(read('_locales/ja/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));

function validateTranslations(markup, japanese, english) {
  assert.deepStrictEqual(Object.keys(japanese).sort(), Object.keys(english).sort(), 'locale key sets differ');
  const entries = [];
  for (const match of markup.matchAll(/<([\w-]+)\b([^>]*\bdata-i18n(?:-[\w-]+)?="[^"\s]+"[^>]*)>/g)) {
    const [, tag, attrs] = match;
    for (const attr of attrs.matchAll(/\bdata-i18n(?:-(placeholder|title|aria-label))?="([^"]+)"/g)) {
      const [, target, key] = attr;
      // Reuse identical messages already shared with the official-profile UI.
      const sharedKeys = ['officialProfileName', 'officialComposer', 'officialLyricist', 'officialArranger', 'officialUnassigned'];
      assert(key.startsWith('history_') || sharedKeys.includes(key), `${key}: history prefix required for new keys`);
      const fallback = target
        ? attrs.match(new RegExp(`(?:^|\\s)${target}="([^"]*)"`))?.[1]
        : markup.slice(match.index + match[0].length).split(`</${tag}>`)[0].trim();
      assert(typeof fallback === 'string' && !fallback.includes('<'), `${key}: translate a leaf with a fallback`);
      assert(japanese[key] && english[key], `${key}: missing locale key`);
      assert.strictEqual(japanese[key].message, fallback, `${key}: Japanese fallback changed`);
      assert(english[key].message.trim(), `${key}: empty English message`);
      assert(!/[\u3040-\u30ff\u3400-\u9fff]/.test(english[key].message), `${key}: untranslated English message`);
      entries.push({ key, target, fallback });
    }
  }
  assert(entries.length > 0, 'history must declare translation keys');
  return entries;
}

const entries = validateTranslations(html, ja, en);
// REQ-4: exercise the validator itself with both kinds of incomplete input.
assert.throws(() => validateTranslations(html, { ...ja, history_jaOnly: { message: '追加' } }, en), /locale key sets differ/);
assert.throws(() => validateTranslations('<span data-i18n="history_missing">未登録</span>', ja, en), /history_missing: missing locale key/);

// Coverage guard: include every body element, even initial text later rewritten
// by another script. Only comments and script/style contents are out of scope.
const japaneseText = /[\u3040-\u30ff\u3400-\u9fff]/;
function validateCoverage(markup) {
const stack = [];
const body = markup.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1];
assert(typeof body === 'string', 'history body must exist');
for (const token of body.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
  const value = token[0];
  const raw = stack.at(-1);
  if (raw && ['script', 'style'].includes(raw.tag)) {
    if (new RegExp(`^</${raw.tag}\\s*>$`, 'i').test(value)) stack.pop();
    continue;
  }
  if (value.startsWith('<!--')) continue;
  if (value.startsWith('</')) {
    const closing = value.match(/^<\/([\w-]+)/)?.[1].toLowerCase();
    const index = stack.findLastIndex(el => el.tag === closing);
    if (index >= 0) stack.length = index;
    continue;
  }
  if (!value.startsWith('<')) {
    const parent = stack.at(-1);
    if (japaneseText.test(value)) {
      assert(parent?.attrs['data-i18n'], `untranslated static text: ${value.trim()}`);
    }
    continue;
  }
  const tag = value.match(/^<([\w-]+)/)?.[1].toLowerCase();
  if (!tag) continue;
  const attrs = Object.fromEntries([...value.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    if (japaneseText.test(attrs[attr] || '')) assert(attrs[`data-i18n-${attr}`], `untranslated ${attr}: ${attrs[attr]}`);
  }
  if (!['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag)) stack.push({ tag, attrs });
}
}
validateCoverage(html);
// Each declared target must independently fail coverage if its binding is lost.
let mutationCount = 0;
for (const match of html.matchAll(/\sdata-i18n(?:-(?:placeholder|title|aria-label))?="[^"]+"/g)) {
  const mutated = html.slice(0, match.index) + html.slice(match.index + match[0].length);
  assert.throws(() => validateCoverage(mutated), /untranslated/, `missing binding was not detected: ${match[0]}`);
  mutationCount++;
}
validateCoverage('<body><!-- 日本語 --><script>const label = "日本語";</script><style>/* 日本語 */</style></body>');

// Exercise the actual initializer, including absent chrome/i18n/getMessage
// and missing keys. Attribute translation must preserve child text.
const start = source.indexOf('// Static history localization');
const end = source.indexOf('// End static history localization', start);
assert(start >= 0 && end > start, 'localization initializer must exist');
const initializer = source.slice(start, end);
assert(initializer.includes('applyStaticHistoryI18n();'), 'initializer must run at startup');
for (const locale of [ja, en, {}, null, 'noChrome', 'noGetMessage']) {
  const elements = entries.map(({ key, target, fallback }) => ({
    textContent: target ? 'unchanged child' : `\n  ${fallback}  \n`,
    attrs: { [`data-i18n${target ? '-' + target : ''}`]: key, ...(target ? { [target]: fallback } : {}) },
    getAttribute(name) { return this.attrs[name]; },
    setAttribute(name, value) { this.attrs[name] = value; },
  }));
  const context = {
    document: { querySelectorAll(selector) { return elements.filter(el => selector.slice(1, -1) in el.attrs); } },
  };
  if (locale !== 'noChrome') {
    context.chrome = locale === null ? {} : locale === 'noGetMessage' ? { i18n: {} }
      : { i18n: { getMessage(key) { return locale[key]?.message || ''; } } };
  }
  vm.runInNewContext(initializer, context);
  entries.forEach(({ key, target, fallback }, i) => {
    const expected = locale?.[key]?.message || fallback;
    assert.strictEqual(target ? elements[i].attrs[target] : elements[i].textContent, target ? expected : `\n  ${expected}  \n`);
    if (target) assert.strictEqual(elements[i].textContent, 'unchanged child');
  });
}
for (const target of ['', 'placeholder', 'title', 'aria-label']) {
  assert(entries.some(entry => (entry.target || '') === target), `missing target coverage: ${target}`);
}
console.log(`PASS static history i18n: ${new Set(entries.map(e => e.key)).size} keys, ${entries.length} targets; full body coverage, ja/en parity, fallback, English, two negative fixtures, ${mutationCount} missing-binding mutations`);
