// Chrome rejects the whole extension when a message uses $name$ without defining it
// in "placeholders" (e.g. adjacent substitutions like "$2$3" parse as "$2$").
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = process.argv[2] || path.join(__dirname, '..');
const localesDir = path.join(root, '_locales');
let checked = 0;

for (const locale of fs.readdirSync(localesDir)) {
  const file = path.join(localesDir, locale, 'messages.json');
  if (!fs.existsSync(file)) continue;
  const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [key, entry] of Object.entries(messages)) {
    const defined = new Set(Object.keys(entry.placeholders || {}).map(name => name.toLowerCase()));
    for (const match of entry.message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)) {
      assert.ok(defined.has(match[1].toLowerCase()),
        `${locale}/${key}: "$${match[1]}$" used but not defined in placeholders`);
    }
    checked++;
  }
}

assert.ok(checked > 0, 'no messages checked');

// Every __MSG_key__ in manifest.json must exist in each locale, or the listing shows the raw key.
const manifestText = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
for (const locale of fs.readdirSync(localesDir)) {
  const file = path.join(localesDir, locale, 'messages.json');
  if (!fs.existsSync(file)) continue;
  const keys = new Set(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).map(k => k.toLowerCase()));
  for (const match of manifestText.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
    assert.ok(keys.has(match[1].toLowerCase()), `${locale}: manifest uses __MSG_${match[1]}__ but it is not defined`);
  }
}
console.log(`PASS chrome placeholder definitions: ${checked} messages`);
