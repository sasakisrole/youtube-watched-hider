const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const self = { CreditMaintenance: require('../credit_corrections.js'), CreditTarget: require(path.join(ROOT, 'credit_target.js')) };
const titleBlock = source.slice(source.indexOf('const MB_SUFFIX_PATTERNS'), source.indexOf('async function mbGet'));
const { parseMbTitle } = new Function(`${titleBlock}\nreturn { parseMbTitle };`)();
const parserBlock = source.slice(source.indexOf('function cleanCreditLine'), source.indexOf('async function fetchCreditsFromWatch'));
const { parseCreditsFromDescription: parse } = new Function('self', `${parserBlock}\nreturn { parseCreditsFromDescription };`)(self);
let passed = 0;
let failed = 0;
function check(name, test) {
  try { test(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}

for (const [input, expected] of [
  ['[Dream of Tomorrow]', '[Dream of Tomorrow]'],
  ['[CODE : DEEP]', '[CODE : DEEP]'],
  ['【カラオケ】夜明け【Example】', '【カラオケ】夜明け'],
  ['[Part One] Song [Official Audio]', '[Part One] Song'],
  ['Song (feat. Singer)', 'Song'],
  ['Song (feat. Singer) [Official Audio]', 'Song'],
  ['Song feat. Singer', 'Song'],
  ['Song (Remix feat. Alice)', 'Song'],
  ['Song ( feat. Alice)', 'Song'],
  ['(Song feat. Alice)', '(Song feat. Alice)'],
  ['Song (Remix - Live)', 'Song'],
  ['Song (Acoustic)', 'Song'],
  ['Song - Live2022', 'Song'],
  ['Defeat', 'Defeat'],
  ['(Song)', '(Song)'],
  ['【曲名】', '【曲名】'],
]) check('title ' + input, () => assert.equal(parseMbTitle(input).baseWorkTitle, expected));
check('live review survives suffix cleanup', () => assert.equal(parseMbTitle('Song (Live) [Official]').requiresManualReview, true));
check('instrumental review survives suffix cleanup', () => assert.equal(parseMbTitle('Song (Instrumental)').recordingVersion, 'Instrumental'));

for (const label of ['作詞・作曲', '作詞／作曲', '作曲 & 作詞', '作詞作曲', 'Music & Lyrics', 'Lyrics & Music', 'Music and Words', 'Words & Music']) {
  check('compound label ' + label, () => {
    const actual = parse(label + ': Alice');
    assert.equal(actual.composer, 'Alice');
    assert.equal(actual.lyricist, 'Alice');
    assert.equal(actual.arranger, '');
  });
}
check('three Japanese roles', () => assert.deepEqual(parse('作詞・作曲・編曲：Alice'), {
  composer: 'Alice', lyricist: 'Alice', arranger: 'Alice', creditsRaw: '',
}));
check('compound label stops at next role', () => assert.deepEqual(parse('Music & Lyrics: Alice / Arrange: Bob'), {
  composer: 'Alice', lyricist: 'Alice', arranger: 'Bob', creditsRaw: '',
}));
check('compound label does not swallow Vocal', () => assert.equal(parse('作詞・作曲：Alice Vocal: Bob').composer, 'Alice'));
for (const input of ['Music: Listen on Spotify', 'Music Video: Alice', 'Writer: Alice', 'Author: Alice', '作詞・作曲：http://example.com', 'Music & Lyrics: @handle']) {
  check('reject ambiguous or polluted ' + input, () => {
    const actual = parse(input);
    assert.equal(actual.composer + actual.lyricist + actual.arranger, '');
  });
}
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
