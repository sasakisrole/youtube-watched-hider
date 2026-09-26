const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
assert.strictEqual(JSON.parse(read('manifest.json')).default_locale, 'ja');
const ja = JSON.parse(read('_locales/ja/messages.json'));
const en = JSON.parse(read('_locales/en/messages.json'));
const html = read('popup.html');
const entries = [];
for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bdata-i18n(?:-[\w-]+)?="[^"\s]+"[^>]*)>/g)) {
  const [, tag, attrs] = match;
  for (const attr of attrs.matchAll(/\bdata-i18n(?:-(placeholder|title|aria-label))?="([^"]+)"/g)) {
    const [, target, key] = attr;
    const fallback = target
      ? attrs.match(new RegExp(`(?:^|\\s)${target}="([^"]*)"`))[1]
      : html.slice(match.index + match[0].length).split(`</${tag}>`)[0].trim();
    assert(!fallback.includes('<'), `${key}: translate a leaf, preserving child elements`);
    assert(ja[key] && en[key], `${key}: missing locale key`);
    assert.strictEqual(ja[key].message, fallback, `${key}: Japanese fallback changed`);
    assert(en[key].message.trim(), `${key}: empty English message`);
    entries.push({ key, target, fallback });
  }
}
assert(entries.length > 0, 'popup must declare translation keys');
for (const key of new Set(entries.map(e => e.key))) assert.ok(Object.hasOwn(ja, key), `missing ja key: ${key}`);
assert.deepStrictEqual(Object.keys(ja).sort(), Object.keys(en).sort());

// Exercise the actual initializer with a small DOM double, including fallback.
const source = read('popup.js');
const start = source.indexOf('// Static popup localization');
const end = source.indexOf('// End static popup localization', start);
assert(start >= 0 && end > start, 'localization initializer must exist');
for (const locale of [ja, en, {}, null]) {
  const elements = entries.map(({ key, target, fallback }) => ({
    textContent: target ? 'unchanged child' : fallback,
    attrs: { [`data-i18n${target ? '-' + target : ''}`]: key, ...(target ? { [target]: fallback } : {}) },
    getAttribute(name) { return this.attrs[name]; },
    setAttribute(name, value) { this.attrs[name] = value; },
  }));
  const context = {
    document: { querySelectorAll(selector) { return elements.filter(el => selector.slice(1, -1) in el.attrs); } },
    chrome: locale === null ? {} : { i18n: { getMessage(key) { return locale[key]?.message || ''; } } },
  };
  vm.runInNewContext(source.slice(start, end), context);
  entries.forEach(({ key, target, fallback }, i) => {
    assert.strictEqual(target ? elements[i].attrs[target] : elements[i].textContent, locale?.[key]?.message || fallback);
    if (target) assert.strictEqual(elements[i].textContent, 'unchanged child');
  });
}
console.log(`PASS static popup i18n: ${Object.keys(ja).length} keys, ${entries.length} targets; ja/en parity and fallback`);
