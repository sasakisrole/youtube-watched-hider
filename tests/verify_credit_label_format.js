const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const block = source.slice(source.indexOf('function cleanCreditLine'), source.indexOf('async function fetchCreditsFromWatch'));
const parse = new Function('self', block + '\nreturn parseCreditsFromDescription;')({ CreditTarget: require(path.join(root, 'credit_target.js')) });
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
for (const bullet of ['・', '•', '●', '■', '◆', '-', '*']) {
  check('bullet ' + bullet, () => assert.equal(parse(bullet + '作曲：Alice').composer, 'Alice'));
}
for (const [label, role] of [['作詞', 'lyricist'], ['Composer', 'composer'], ['編曲', 'arranger']]) {
  for (const wrap of [x => '【' + x + '】', x => '[' + x + ']']) {
    check('wrapped label ' + wrap(label), () => assert.equal(parse(wrap(label) + ': Alice')[role], 'Alice'));
  }
}
check('wrapped compound with bullet', () => {
  const r = parse('●【作詞・作曲】：Alice / [Arrange]: Bob');
  assert.equal(r.composer, 'Alice'); assert.equal(r.lyricist, 'Alice'); assert.equal(r.arranger, 'Bob');
});
for (const label of ['Vocal', 'Music Video', 'See Composer']) {
  check('wrapped non-role terminates value ' + label, () => {
    const r = parse('作曲: Alice / 【' + label + '】: Bob');
    assert.equal(r.composer, 'Alice'); assert.equal(r.lyricist + r.arranger, '');
  });
}
for (const label of ['Music', 'Writer', 'Author', 'See Composer', 'Composer Notes']) {
  check('reject ambiguous wrapped label ' + label, () => assert.equal(parse('【' + label + '】: Alice').composer, ''));
}
for (const value of ['https://example.com', '@handle', '']) {
  check('reject invalid wrapped value ' + value, () => assert.equal(parse('[Composer]: ' + value).composer, ''));
}
check('preserve brackets in names', () => assert.equal(parse('Composer: Alice [Band]').composer, 'Alice [Band]'));
check('do not infer roles without colon', () => assert.equal(parse('【作曲】についての説明').composer, ''));
check('no cross-line label matching', () => assert.equal(parse('[Composer\n]: Alice').composer, ''));
check('wrapped names remain separate across lines', () => assert.equal(parse('【作曲】: Alice\n[Composer]: Bob').composer, 'Alice, Bob'));
for (const input of ['【See Composer: Alice】: Bob', '【See Composer: Alice】', '[See Composer: Alice]: Bob', '[See Composer: Alice]', '【 Composer: Alice】']) {
  check('do not read inside an unknown wrapper ' + input, () => assert.equal(parse(input).composer, ''));
}
check('unknown wrapper does not hide a following role', () => assert.equal(parse('[See Composer: Alice]: Bob / Arranger: Carol').arranger, 'Carol'));
check('multiple role words inside an unknown wrapper stay unassigned', () => {
  const r = parse('【See Composer: Alice / Arranger: Bob】: Carol');
  assert.equal(r.composer + r.lyricist + r.arranger, '');
});
for (const input of ['【See Composer: Alice / Vocal: Bob】', '【Notes [Composer]: Alice / Vocal: Bob】']) {
  check('unknown boundaries inside wrappers cannot expose a name ' + input, () => assert.equal(parse(input).composer, ''));
}
for (const input of ['[Notes [Info] [Composer]: Alice / Vocal: Bob]', '【Notes 【Info】 [Composer]: Alice / Vocal: Bob】']) {
  check('nested wrappers cannot expose a credit ' + input, () => assert.equal(parse(input).composer, ''));
}
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
