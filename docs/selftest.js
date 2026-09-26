#!/usr/bin/env node
/* Offline fixture harness for the single inline script in index.html.
 *
 * Reads index.html, extracts the ONE inline <script> block with a regex,
 * evaluates it in a vm context against a minimal document stub, and asserts
 * every measured expectation. No network, no browser, no dependencies.
 *
 * Exit 0 when every fixture passes; non-zero with one clear line per failure.
 *
 *   node selftest.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* The page under test. Overridable so a MUTATED COPY of index.html can be run
   through the very same fixtures (TWEB_HTML=/tmp/mut.html node selftest.js):
   every assertion below must FAIL against a reverted fix. */
const HTML_PATH = process.env.TWEB_HTML || path.join(__dirname, 'index.html');

/* ------------------------------ harness ------------------------------ */

/* EVERY binding the reporting path touches is declared HERE, with let, before
   any other code can run. The escaped-exception backstop below fires on a
   throw from module evaluation, which is long before the fixtures start, so a
   backstop state variable declared further down would still be in its
   temporal dead zone when the backstop fired -- and the handler itself would
   throw a ReferenceError instead of reporting. (An earlier attempt had exactly
   that bug.) `failures` is the sink every failure is pushed into, so it must
   exist before anything can push. */
let failures = [];
let checks = 0;
let finished = false;
let harnessFailsafe = null;
let backstopRan = false;

/* Failure detail is CLIPPED. A wrong chunk list is thousands of code points
   long -- embedding one whole turns the report into an unreadable wall of
   text and buries the other failures. The head of a value identifies it, and
   the total length is reported alongside. This only affects how a failure is
   WORDED: the comparison itself is unchanged, and a clipped failure is still
   a failure. */
const DETAIL_LIMIT = 300;
function clip(line) {
  const s = String(line);
  return s.length <= DETAIL_LIMIT ? s : s.slice(0, DETAIL_LIMIT) + '... [' + s.length + ' chars total]';
}
function ok(name, condition, detail) {
  checks += 1;
  if (condition) return true;
  failures.push(clip(detail ? name + ' -> ' + detail : name));
  return false;
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  return ok(name, a === e, 'expected ' + e + ', got ' + a);
}
function throws(name, fn) {
  checks += 1;
  let threw = false, message = '';
  try { fn(); } catch (e) { threw = true; message = (e && e.message) || String(e); }
  if (!threw) failures.push(name + ' -> expected a throw, got a value');
  return threw;
}
function section(title) { process.stdout.write('\n== ' + title + '\n'); }
function report(name, value) { process.stdout.write('   ' + name + ': ' + value + '\n'); }

/* --------------------------- the reporting path --------------------------- */

/* The ONE summary line, produced in one place so that finish() and the
   process-exit backstop cannot drift apart. Every non-zero exit that carries
   at least one failure prints this literal. */
function failSummary() { return 'FAIL  ' + checks + ' checks, ' + failures.length + ' failures'; }
function printFailures() {
  process.stderr.write('\n' + failSummary() + '\n');
  process.stderr.write(failures.length + ' of ' + checks + ' checks FAILED:\n');
  for (const f of failures) process.stderr.write('  FAIL  ' + f + '\n');
}

/* An exception that escaped a fixture, or that was thrown while index.html's
   inline script was being evaluated, is turned into an ordinary counted
   failure and the run is terminated through finish(). The message is the
   first line of the error and nothing else: the whole point of the backstop
   is that a mutation gets a clean one-line-per-failure report instead of a
   bare stack trace. */
function recordEscape(where, err) {
  const message = String((err && err.message) || err).split('\n')[0];
  ok('no exception escaped the harness (' + where + ')', false, message);
}
/* `backstopRan` is the loop guard: an error raised inside finish()'s own write
   must not re-enter the handler for ever. `process.exitCode` is set as well as
   calling finish(), because a very late escape can arrive while finish() is
   already exiting, where an explicit process.exit(0) would win. */
function escapeBackstop(where, err) {
  if (!backstopRan) {
    backstopRan = true;
    recordEscape(where, err);
  }
  process.exitCode = 1;
  finish();
}
process.on('uncaughtException', function (err) { escapeBackstop('uncaughtException', err); });
/* An async fixture that rejects outside its own try/catch is the async twin of
   the same class of escape; Node does NOT route it to uncaughtException, so it
   would otherwise kill the process with no summary. Both go through one
   handler, and a rejection that any fixture already caught never reaches it. */
process.on('unhandledRejection', function (reason) { escapeBackstop('unhandledRejection', reason); });

/* --------------------------- chunk-list guard --------------------------- */

/* Google TTS counts CODE POINTS, so a chunk's length is Array.from(s).length.
   Declared here, not beside the TTS fixtures, because the guard below needs it
   and the guard is needed by the translate fixtures further up. */
function cpCount(s) { return typeof s === 'string' ? Array.from(s).length : -1; }
function describeChunks(value) {
  if (!Array.isArray(value)) return 'not an array (' + JSON.stringify(value) + ')';
  if (value.length === 0) return 'an empty array (0 chunks)';
  return value.length + ' chunk' + (value.length === 1 ? '' : 's') + ' of ' +
    JSON.stringify(value.map(cpCount)) + ' code points';
}

/* A chunker that returns null, a non-array, or too few chunks must produce a
   REPORTED FAILURE that states what was expected and what actually came back.
   It must never surface as an escaped TypeError out of `chunks[1].slice`, and
   it must never be a way to make a broken result pass. So:

     * The guard is itself a COUNTED check, but it only ever fires on a build
       that is already broken. On a green run it contributes nothing and the
       total stays exactly 255.
     * When it does fire it hands the surrounding assertions a POISON list of
       the required arity -- the right NUMBER of elements, each a single chunk
       that is over BOTH budgets (9000+ code points, encoded 9000+ > 8000).
       Every assertion that consumes the list therefore still runs and still
       FAILS against real, inspectable data: join-reassembly, the code-point
       bound, the encoded-budget bound, the exact chunk counts, the code-point
       alignment, and the positional indexing.
     * The poison is prefixed with the literal 'umps' so the one guard-rail
       assertion whose subject is the second chunk ("the second chunk does not
       start inside the word 'jumps'") also FAILS when no second chunk exists,
       rather than passing vacuously on a value it was never given. */
const POISON_CHUNK = 'umps' + 'a'.repeat(9000);
function guardChunks(name, value, minCount) {
  if (Array.isArray(value) && value.length >= minCount) return value;
  ok(name + ': the chunker returned a usable chunk list', false,
    'expected an Array of at least ' + minCount + ' chunk' + (minCount === 1 ? '' : 's') +
    ', got ' + describeChunks(value));
  const arity = Array.isArray(value) ? Math.max(value.length, minCount) : minCount;
  const poison = [];
  for (let i = 0; i < arity; i += 1) poison.push(POISON_CHUNK);
  return poison;
}

/* ------------------------- extract and evaluate ------------------------- */

const html = fs.readFileSync(HTML_PATH, 'utf8');
const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
if (blocks.length !== 1) {
  process.stderr.write('FAIL: expected exactly 1 inline <script> block, found ' + blocks.length + '\n');
  process.exit(2);
}
const code = blocks[0].replace(/^<script>/, '').replace(/<\/script>$/, '');

if (/<\/script/i.test(code)) {
  process.stderr.write('FAIL: extracted script contains a script-closing sequence\n');
  process.exit(2);
}
/* Check the CODE, not the prose: comments legitimately name the forbidden APIs. */
const codeOnly = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
if (/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(codeOnly)) {
  process.stderr.write('FAIL: the page must never use an HTML-parsing DOM write or eval\n');
  process.exit(2);
}

/* FIX B5: the stub records the listener registration and does nothing else.
   The module is expected to do no DOM work beyond registering DOMContentLoaded. */
const domCalls = { addEventListener: [], getElementById: 0, createElement: 0 };
const documentStub = {
  addEventListener: function (type) { domCalls.addEventListener.push(type); },
  getElementById: function () { domCalls.getElementById += 1; return null; },
  createElement: function () { domCalls.createElement += 1; return {}; },
  removeEventListener: function () {}
};

const sandbox = {
  module: { exports: {} },
  console: console,
  document: documentStub,
  window: undefined,
  fetch: function () { throw new Error('the harness must never touch the network'); },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'index.inline.js' });
const T = sandbox.module.exports;

/* ------------------------------ fixtures ------------------------------ */

section('module import is DOM-free');
eq('exactly one DOMContentLoaded listener registered',
  domCalls.addEventListener, ['DOMContentLoaded']);
eq('getElementById never called at import', domCalls.getElementById, 0);
eq('createElement never called at import', domCalls.createElement, 0);
ok('pure functions were exported', ['chunkForTranslate', 'chunkForTts', 'parseGoogleTranslate',
  'speedToBucket', 'wpmToRate', 'joinTranslated', 'speakGoogle', 'sanitizeText', 'encodedLen',
  'splitOnSentences', 'fetchJson'].every(function (k) { return typeof T[k] === 'function'; }),
  'missing: ' + Object.keys(T).join(','));
eq('ENCODED_QUERY_BUDGET', T.ENCODED_QUERY_BUDGET, 8000);
eq('TTS_CHUNK_LIMIT', T.TTS_CHUNK_LIMIT, 200);
/* SPEC CHANGE (v9 reorientation, text -> translated audio). These three
   assertions used to pin the OPPOSITE of the current spec:
       'target list excludes the two English locales' === 19
       'no en_US/en_GB target'
       '19 targets, first and last'                   === ['ar_AE','zh_TW']
   They encoded a now-WRONG expectation — English is a selectable target, and
   the target list is every locale — so they are updated rather than kept. The
   21-entry list and its first/last pair are still asserted exactly. */
eq('the target list is every locale, 21 entries', T.TARGET_LOCALES.length, 21);
ok('en_US is a selectable target', T.TARGET_LOCALES.some(function (p) { return p[0] === 'en_US'; }));
ok('en_GB is a selectable target', T.TARGET_LOCALES.some(function (p) { return p[0] === 'en_GB'; }));
/* The invariant is "the same 21 codes, none added or lost", so it is compared
   as a SET. It was previously a positional compare, which silently encoded
   "TARGET_LOCALES is an unsorted copy" — precisely what the v10 sort below
   removes. Set equality keeps the full intent; the exact new ORDER is pinned
   separately and more strongly by 'sorted target display names' below. */
eq('the target codes are exactly the TRANSLATION_LOCALES codes',
  T.TARGET_LOCALES.map(function (p) { return p[0]; }).slice().sort(),
  T.TRANSLATION_LOCALES.map(function (p) { return p[0]; }).slice().sort());
/* SPEC CHANGE (v10, dropdown order). The target list is now sorted ALPHABETICALLY
   BY DISPLAY NAME — the label the user actually reads — instead of by locale
   code, because code order reads as random in the dropdown. So the first/last
   pair changes: first is still Arabic (ar_AE, sorts first either way) but the
   LAST entry is now Vietnamese vi_VN, not zh_TW. The codes-as-a-set assertion
   above is unaffected and still proves no locale was added or lost. */
eq('21 targets, first and last (sorted by display name)',
  [T.TARGET_LOCALES[0][0], T.TARGET_LOCALES[20][0]], ['ar_AE', 'vi_VN']);
/* The real guard: the display names must be in non-decreasing case-insensitive
   alphabetical order. This FAILS if the sort in index.html is removed, since
   code order puts German ('german') before English ('english (uk)'). */
{
  const names = T.TARGET_LOCALES.map(function (p) { return String(p[1]).toLowerCase(); });
  const outOfOrder = [];
  for (let i = 1; i < names.length; i += 1) {
    if (names[i - 1].localeCompare(names[i]) > 0) outOfOrder.push(i - 1 + ':' + names[i - 1] + ' > ' + i + ':' + names[i]);
  }
  ok('target display names are in non-decreasing alphabetical order', outOfOrder.length === 0, outOfOrder.join('; '));
  eq('sorted target display names',
    names, ['arabic', 'chinese (simplified)', 'chinese (traditional)', 'dutch', 'english (uk)', 'english (us)',
      'french', 'german', 'hindi', 'indonesian', 'italian', 'japanese', 'korean', 'polish', 'portuguese',
      'russian', 'spanish', 'thai', 'turkish', 'ukrainian', 'vietnamese']);
  /* The canonical list must NOT have been reordered along with the copy. */
  eq('TRANSLATION_LOCALES keeps its original locale-code order',
    T.TRANSLATION_LOCALES.map(function (p) { return p[0]; }).slice(0, 4),
    ['ar_AE', 'de_DE', 'en_GB', 'en_US']);
  eq('TRANSLATION_LOCALES still ends with the two Chinese locales',
    T.TRANSLATION_LOCALES.map(function (p) { return p[0]; }).slice(18),
    ['vi_VN', 'zh_CN', 'zh_TW']);
}
eq('English display names survived the un-exclusion',
  T.TARGET_LOCALES.filter(function (p) { return p[0].indexOf('en_') === 0; }).map(function (p) { return p[1]; }),
  ['English (UK)', 'English (US)']);
eq('LOCALE_TO_GOOGLE_CODE maps en_US', T.LOCALE_TO_GOOGLE_CODE.en_US, 'en');
eq('LOCALE_TO_GOOGLE_CODE maps en_GB', T.LOCALE_TO_GOOGLE_CODE.en_GB, 'en-GB');
ok('every target has a Google code', T.TARGET_LOCALES.every(function (p) {
  return typeof T.LOCALE_TO_GOOGLE_CODE[p[0]] === 'string' && T.LOCALE_TO_GOOGLE_CODE[p[0]].length > 0;
}));

section('sanitising: lone surrogates must not abort a translation');
ok("sanitizeText('a\\ud800b') does not throw", (function () {
  try { return typeof T.sanitizeText('a\ud800b') === 'string'; } catch (e) { return false; }
})());
eq("sanitizeText('a\\ud800b') replaces the lone high surrogate", T.sanitizeText('a\ud800b').length, 3);
ok("encodeURIComponent survives a lone high surrogate", (function () {
  try { T.encodedLen('a\ud800b'); return true; } catch (e) { return false; }
})());
ok('chunker survives a lone high surrogate', (function () {
  try { return T.chunkForTranslate('a\ud800b').length === 1; } catch (e) { return false; }
})());

section('budget boundary: encoded length, not character count');
eq("encodeURIComponent('a' x 8000).length", encodeURIComponent('a'.repeat(8000)).length, 8000);
eq("encodedLen('a' x 8000)", T.encodedLen('a'.repeat(8000)), 8000);
const a8000 = guardChunks("'a' x 8000", T.chunkForTranslate('a'.repeat(8000)), 1);
eq("'a' x 8000 -> 1 chunk", a8000.map(function (c) { return c.length; }), [8000]);
const a8001 = guardChunks("'a' x 8001", T.chunkForTranslate('a'.repeat(8001)), 2);
eq("'a' x 8001 -> 2 chunks [8000, 1]",
  a8001.map(function (c) { return c.length; }), [8000, 1]);

section('hard split path: one unpunctuated sentence');
const hundredK = guardChunks("'a' x 100000", T.chunkForTranslate('a'.repeat(100000)), 13);
eq("'a' x 100000 -> 13 chunks", hundredK.length, 13);
eq("'a' x 100000 -> [8000 x 12, 4000]",
  hundredK.map(function (c) { return c.length; }),
  new Array(12).fill(8000).concat([4000]));
ok('every hard-split piece is within the encoded budget',
  hundredK.every(function (c) { return T.encodedLen(c) <= 8000; }));
eq("'a' x 100000 concatenates back to the original", hundredK.join('').length, 100000);

section('CJK greedy packing: 9x percent-encoding');
const CJK_SEED = '日本語のテキストです。';   /* 10 code points, 90 encoded */
function cjk(n) { return CJK_SEED.repeat(Math.ceil(n / CJK_SEED.length)).slice(0, n); }
const cjk1200 = guardChunks('1200 CJK chars', T.chunkForTranslate(cjk(1200)), 2);
eq('1200 CJK chars -> 2 requests', cjk1200.length, 2);
ok('each 1200-CJK request is within budget',
  cjk1200.every(function (c) { return T.encodedLen(c) <= 8000; }),
  JSON.stringify(cjk1200.map(function (c) { return T.encodedLen(c); })));
eq('the 1200-CJK case really does exceed one request', T.encodedLen(cjk(1200)) > 8000, true);
report('1200 CJK encoded', T.encodedLen(cjk(1200)));
report('1200 CJK per-chunk encoded', JSON.stringify(cjk1200.map(function (c) { return T.encodedLen(c); })));

const cjk2000 = guardChunks('2000 CJK chars', T.chunkForTranslate(cjk(2000)), 3);
eq('2000 CJK chars -> 3 requests', cjk2000.length, 3);
ok('each 2000-CJK request is within budget',
  cjk2000.every(function (c) { return T.encodedLen(c) <= 8000; }),
  JSON.stringify(cjk2000.map(function (c) { return T.encodedLen(c); })));
eq('2000 CJK reassembles to the original input', cjk2000.join(''), cjk(2000));
report('2000 CJK per-chunk encoded', JSON.stringify(cjk2000.map(function (c) { return T.encodedLen(c); })));

section('hard split of an oversized single CJK sentence (no terminator)');
const cjkRun = Array.from(cjk(2000)).join('');
const cjkPieces = guardChunks('2000 CJK with no terminator', T.chunkForTranslate(cjkRun), 3);
eq('2000 CJK with no terminator -> 3 pieces', cjkPieces.length, 3);
ok('each piece is within budget',
  cjkPieces.every(function (c) { return T.encodedLen(c) <= 8000; }),
  JSON.stringify(cjkPieces.map(function (c) { return T.encodedLen(c); })));
eq('the hard split loses nothing', cjkPieces.join(''), cjkRun);

section('code-point safety: surrogate pairs are never split');
const emoji = '\u{1F600}'.repeat(1000);
const emojiChunks = guardChunks('1000 x U+1F600', T.chunkForTranslate(emoji), 2);
eq('1000 x U+1F600 -> 2 chunks', emojiChunks.length, 2);
eq('emoji pieces are [666, 334] code points',
  emojiChunks.map(function (c) { return Array.from(c).length; }), [666, 334]);
ok('every emoji piece re-encodes without URIError', emojiChunks.every(function (c) {
  try { encodeURIComponent(c); return true; } catch (e) { return false; }
}));
eq('emoji pieces concatenate back to the original', emojiChunks.join(''), emoji);
ok('no emoji piece ends with an unpaired high surrogate', emojiChunks.every(function (c) {
  const code = c.charCodeAt(c.length - 1);
  return !(code >= 0xD800 && code <= 0xDBFF);
}));
eq('emoji pieces are code-point aligned at the join',
  Array.from(emojiChunks[0]).length + Array.from(emojiChunks[1]).length, 1000);

section('TTS chunker: sentences accumulate; an oversized sentence is hard-split');
const tts150 = guardChunks("'a' x 150", T.chunkForTts('a'.repeat(150)), 1);
eq("'a' x 150 -> 1 chunk of 150", tts150.map(function (c) { return c.length; }), [150]);
const threeSentences = ('a'.repeat(49) + '.').repeat(3);
const threeChunks = guardChunks('3 sentences of 50 chars', T.chunkForTts(threeSentences), 1);
eq('3 sentences of 50 chars -> 1 chunk of 150',
  threeChunks.map(function (c) { return c.length; }), [150]);
const fiveSentences = ('b'.repeat(49) + '.').repeat(5);
const fiveChunks = guardChunks('5 sentences of 50 chars', T.chunkForTts(fiveSentences), 2);
eq('5 sentences of 50 chars -> EXACTLY [200, 50]',
  fiveChunks.map(function (c) { return c.length; }), [200, 50]);
eq('the [200, 50] chunks reassemble to the whole input', fiveChunks.join(''), fiveSentences);

/* SPEC CHANGE (TTS hard split). These two assertions encoded the OLD contract:
   chunkForTts returned null for a single sentence over the 200 code-point
   limit, the caller turned that into mode 'unsplittable', made ZERO Google TTS
   requests and fell back to the browser speech engine — which usually has no
   voice for the target language, so the user saw the translation and heard
   NOTHING. Korean hit it constantly, because Korean paragraphs often carry no
   sentence-final punctuation at all and so arrived as ONE 'sentence' over the
   limit, while English prose has periods and mostly escaped.

   The contract now: ALWAYS an array, every chunk at most 200 code points, and
   the chunks reassemble to the whole input. */
const long250 = guardChunks("'a' x 250 as a single sentence", T.chunkForTts('a'.repeat(250)), 2);
eq("'a' x 250 as a single sentence -> [200, 50], not null", long250, ['a'.repeat(200), 'a'.repeat(50)]);
ok("'a' x 250 no longer returns null (the browser-speech fallback is gone)",
  long250 !== null && Array.isArray(long250));
ok("'a' x 250: every chunk is at most 200 code points",
  long250.every(function (c) { return Array.from(c).length <= 200; }));
eq("'a' x 250 reassembles to the whole input", long250.join(''), 'a'.repeat(250));
const cjk201 = guardChunks('201 unpunctuated CJK chars', T.chunkForTts('語'.repeat(201)), 2);
eq("201 unpunctuated CJK chars -> [200, 1], not null", cjk201, ['語'.repeat(200), '語']);
ok('201 unpunctuated CJK chars: every chunk is at most 200 code points',
  cjk201.every(function (c) { return Array.from(c).length <= 200; }));
eq('the [200, 1] CJK chunks reassemble to the whole input', cjk201.join(''), '語'.repeat(201));
eq("'a' x 200 is the last single-sentence size that needs no split",
  guardChunks("'a' x 200", T.chunkForTts('a'.repeat(200)), 1).length, 1);
eq("'' still yields the single empty chunk it always did",
  guardChunks('the empty string', T.chunkForTts(''), 1), ['']);
ok('the hard splitter is exported', typeof T.hardSplitSentence === 'function');

section('TTS chunker: the inputs that produced NO AUDIO AT ALL before the fix');

/* Code-point length, which is what Google TTS counts. */
const cpLen = function (s) { return Array.from(s).length; };
const tight = function (name, chunks) {
  ok(name + ': every chunk is at most 200 code points', chunks.every(function (c) { return cpLen(c) <= 200; }),
    JSON.stringify(chunks.map(cpLen)));
};
const squashed = function (s) { return s.replace(/\s+/g, ''); };

/* (a) THE USER'S ACTUAL FAILURE: a 342-character Korean paragraph with no
   sentence-final punctuation anywhere, so splitOnSentences returns exactly one
   'sentence' of 342 code points — over the limit by 142. */
const koPara = [
  '오늘 아침 일기를 옮기다가 한 가지 분명해진 일이 있었습니다',
  '이 문서는 원본 텍스트를 그대로 소리로 들려주는 도구여야 하기 때문에 문장 끝에 마침표를 하나도 넣지 않았습니다',
  '그래서 한국어처럼 문장 부호가 드문 언어는 한 덩어리로 아주 길게 들어올 수 있고',
  '그럴 때 조용히 잘라서 여러 번에 걸쳐 읽어 주는 것이 훨씬 나은 일입니다',
  '영어 문장이라면 마침표가 자주 나오기 때문에 이런 문제를 거의 만나지 못하겠죠',
  '그러니 아무 일도 하지 못하고 조용히 넘어가는 것보다 차라리 잘게 나누어 소리를 내는 편이 더 낫습니다',
  '사용자는 번역된 글자를 볼 수는 있어도 아무 소리도 전혀 들을 수 없는 상태가 가장 나쁜 경우입니다'
].join(' ');
ok('the Korean fixture really has no sentence terminator at all', !/[。！？.!?]/.test(koPara));
ok('the Korean fixture is one single "sentence" over the limit',
  T.splitOnSentences(koPara).length === 1 && cpLen(koPara) > T.TTS_CHUNK_LIMIT,
  'sentences=' + T.splitOnSentences(koPara).length + ' len=' + cpLen(koPara));
const koChunks = guardChunks('the 342-character Korean paragraph', T.chunkForTts(koPara), 2);
ok('Korean: the result is an Array, never null', Array.isArray(koChunks), JSON.stringify(koChunks));
tight('Korean', koChunks);
ok('Korean: more than one chunk (it is really split, not truncated)',
  koChunks.length > 1, 'chunks=' + koChunks.length);
eq('Korean: the chunks rejoin to the whitespace-stripped original',
  squashed(koChunks.join('')), squashed(koPara));
report('Korean chunk code-point lengths', JSON.stringify(koChunks.map(cpLen)) +
  ' (input ' + cpLen(koPara) + ', sum ' + koChunks.map(cpLen).reduce(function (a, b) { return a + b; }, 0) + ')');

/* (b) The same shape in English: 525 characters, still no period, so the whole
   run is one 'sentence' over the limit. */
const enRun = 'this translation page reads the translated text out loud in the target language and it has to keep working even when a whole paragraph arrives without a single full stop to break it on, so the chunker cannot lean on punctuation here and must fall back on the last space inside each window rather than giving up and handing the entire paragraph to a browser voice that does not exist for most of the target languages on this list, which is exactly why English seemed fine while Korean was silent every single time you tried it';
ok('the English fixture really has no sentence terminator at all', !/[。！？.!?]/.test(enRun));
ok('the English fixture is one single "sentence" over the limit',
  T.splitOnSentences(enRun).length === 1 && cpLen(enRun) > T.TTS_CHUNK_LIMIT,
  'sentences=' + T.splitOnSentences(enRun).length + ' len=' + cpLen(enRun));
const enChunks = guardChunks('the 525-character English run', T.chunkForTts(enRun), 2);
ok('English: the result is an Array, never null', Array.isArray(enChunks), JSON.stringify(enChunks));
tight('English', enChunks);
ok('English: more than one chunk (it is really split, not truncated)', enChunks.length > 1, 'chunks=' + enChunks.length);
eq('English: the chunks rejoin to the whitespace-stripped original',
  squashed(enChunks.join('')), squashed(enRun));
report('English chunk code-point lengths', JSON.stringify(enChunks.map(cpLen)) +
  ' (input ' + cpLen(enRun) + ', sum ' + enChunks.map(cpLen).reduce(function (a, b) { return a + b; }, 0) + ')');

/* (c) NO WHITESPACE AT ALL: the hard cut has nothing to break on, so this is
   the case that proves the cut itself and not merely the space preference. */
const cjkHard = guardChunks('240 CJK chars, no whitespace at all', T.chunkForTts('語'.repeat(240)), 2);
ok('240 CJK chars: the result is an Array, never null', Array.isArray(cjkHard), JSON.stringify(cjkHard));
tight('240 CJK chars', cjkHard);
eq('240 CJK chars: [200, 40]', cjkHard.map(cpLen), [200, 40]);
eq('the 240 CJK chunks reassemble to the whole input', cjkHard.join(''), '語'.repeat(240));
report('no-whitespace CJK chunk code-point lengths', JSON.stringify(cjkHard.map(cpLen)));

/* (d) The split must respect whitespace: no chunk may begin in the middle of a
   Latin word. Measured against the original by offset, because the chunks
   reassemble exactly, so a chunk boundary IS a position in the input. */
const wordRun = 'the quick brown fox jumps over the lazy dog '.repeat(6);   /* 264 chars */
const wordChunks = guardChunks('the 264-character one-sentence English run', T.chunkForTts(wordRun), 2);
tight('the 264-character one-sentence English run', wordChunks);
eq('the 264-character one-sentence English run reassembles', wordChunks.join(''), wordRun);
let offset = 0;
const starts = wordChunks.map(function (c) { const at = offset; offset += cpLen(c); return at; });
/* Guard the guard: a NAIVE cut at exactly the 200 limit would start the second
   chunk on the 's' of "jumps", so this assertion is not trivially true. */
ok('the fixture is shaped so a naive 200 cut lands mid-word',
  wordRun[199] !== ' ' && wordRun[200] !== ' ', JSON.stringify(wordRun.slice(196, 204)));
ok('every chunk after the first starts at a word boundary (a space precedes it)',
  starts.slice(1).every(function (at) { return wordRun[at - 1] === ' '; }),
  'chunk starts at ' + JSON.stringify(starts));
ok('the second chunk does not start inside the word "jumps"',
  wordChunks[1].slice(0, 4) !== 'umps', JSON.stringify(wordChunks[1].slice(0, 8)));
report('whitespace-respecting chunk code-point lengths', JSON.stringify(wordChunks.map(cpLen)) +
  ' (input ' + cpLen(wordRun) + ', starts at ' + JSON.stringify(starts) + ')');

/* (e) NO REGRESSION: the shapes that were already covered still hold. */
eq('no regression: 150 chars stay in one chunk',
  guardChunks('no regression 150 chars', T.chunkForTts('a'.repeat(150)), 1).map(cpLen), [150]);
eq('no regression: 3 sentences of 50 stay in one chunk of 150',
  guardChunks('no regression 3 sentences', T.chunkForTts(threeSentences), 1).map(cpLen), [150]);
const noRegress5 = guardChunks('no regression 5 sentences', T.chunkForTts(fiveSentences), 2);
eq('no regression: 5 sentences of 50 stay exactly [200, 50]', noRegress5.map(cpLen), [200, 50]);
eq('no regression: the [200, 50] chunks still reassemble', noRegress5.join(''), fiveSentences);

/* An oversized sentence in the MIDDLE must not swallow the sentences around it. */
const mixed = ('c'.repeat(50) + '.').repeat(2) + 'd'.repeat(450) + ('e'.repeat(50) + '.').repeat(2);
const mixedChunks = guardChunks('a 250-char sentence between two 100-char blocks', T.chunkForTts(mixed), 5);
tight('a 250-char sentence between two 100-char blocks', mixedChunks);
ok('a 250-char sentence between two 100-char blocks still reassembles', mixedChunks.join('') === mixed);
ok('a 250-char sentence between two 100-char blocks yields 5 chunks',
  mixedChunks.length === 5, JSON.stringify(mixedChunks.map(cpLen)));
report('mixed oversized-sentence chunk code-point lengths', JSON.stringify(mixedChunks.map(cpLen)));

/* The 200 limit is CODE POINTS: 200 astral code points are 400 UTF-16 units but
   still 200 characters, so they fit in one chunk instead of being refused. */
const astral = guardChunks('200 astral code points', T.chunkForTts('\u{1F600}'.repeat(200)), 1);
eq('200 astral code points fit in a single chunk', astral.length, 1);
eq('that astral chunk is 200 code points', cpLen(astral[0]), 200);
ok('no astral chunk ends with an unpaired high surrogate', astral.every(function (c) {
  const code = c.charCodeAt(c.length - 1);
  return !(code >= 0xD800 && code <= 0xDBFF);
}));
eq('the astral chunks reassemble to the whole input', astral.join(''), '\u{1F600}'.repeat(200));

section('speed and rate mappings');
eq('speedToBucket(80)', T.speedToBucket(80), 0.5);
eq('speedToBucket(500)', T.speedToBucket(500), 1.0);
eq('speedToBucket(290) [JS half-up; Python banker rounding gives 0.7]', T.speedToBucket(290), 0.8);
eq('wpmToRate(175)', T.wpmToRate(175), 1.0);
eq('wpmToRate(80)', T.wpmToRate(80), 0.5);
eq('wpmToRate(500)', T.wpmToRate(500), 2.5);

section('language-aware joining, chosen from the TARGET language');
eq("the zh separator is ''", T.joinSeparator('zh_CN'), '');
eq("the ko separator is a space (Korean does use spaces)", T.joinSeparator('ko_KR'), ' ');
eq("the ja separator is ''", T.joinSeparator('ja_JP'), '');
eq("the de separator is a space", T.joinSeparator('de_DE'), ' ');
eq("the th separator is ''", T.joinSeparator('th_TH'), '');
eq('a Google language code reduces to the same base code', T.joinSeparator('zh-CN'), '');
eq("joinTranslated(['a','b'],'zh_CN') joins with no separator", T.joinTranslated(['a', 'b'], 'zh_CN'), 'ab');
eq("joinTranslated(['a','b'],'ko_KR') joins with a space", T.joinTranslated(['a', 'b'], 'ko_KR'), 'a b');
eq("joinTranslated(['a','b'],'ja_JP') joins with no separator", T.joinTranslated(['a', 'b'], 'ja_JP'), 'ab');
eq("joinTranslated(['a','b'],'de_DE') joins with a space", T.joinTranslated(['a', 'b'], 'de_DE'), 'a b');

/* v8 reorientation: the page is text -> translated audio. There is exactly one
   speak path (onTranslate), the target is the OUTPUT language, and the un-
   translated input can no longer be spoken. `html` and `code` are the already-
   loaded index.html text and its inline script (see the top of this file). */
section('v8: text -> translated audio');

const targetCodes = T.TARGET_LOCALES.map(function (p) { return p[0]; });
const dtf = function (lang) { return T.defaultTargetFor(lang, T.TARGET_LOCALES); };

/* A. Locale mapping. A hyphenated tag is normalised to the underscore form
   and matched exactly; a tag with no region (or a region absent from the list)
   matches on its base language; anything unresolvable takes the fallback. */
eq("defaultTargetFor('en-US') is an exact match -> en_US", dtf('en-US'), 'en_US');
eq("defaultTargetFor('en-GB') is an exact match -> en_GB", dtf('en-GB'), 'en_GB');
eq("defaultTargetFor('de-DE') is an exact match -> de_DE", dtf('de-DE'), 'de_DE');
eq("defaultTargetFor('ko-KR') is an exact match -> ko_KR", dtf('ko-KR'), 'ko_KR');
eq("defaultTargetFor('ja') matches on its base language -> ja_JP", dtf('ja'), 'ja_JP');
eq("defaultTargetFor('fr-CA') matches on its base language -> fr_FR", dtf('fr-CA'), 'fr_FR');
eq("defaultTargetFor('') falls back -> en_US", dtf(''), 'en_US');
eq('defaultTargetFor(undefined) falls back -> en_US', dtf(undefined), 'en_US');
eq("defaultTargetFor('xx-YY') falls back -> en_US", dtf('xx-YY'), 'en_US');

/* B. The fallback is en_US, and it is really a selectable target. */
eq('DEFAULT_TARGET_FALLBACK', T.DEFAULT_TARGET_FALLBACK, 'en_US');
ok('the fallback locale is one of the selectable targets',
  targetCodes.indexOf(T.DEFAULT_TARGET_FALLBACK) >= 0, T.DEFAULT_TARGET_FALLBACK);

/* C. Google TTS is the default engine, in the module and in the markup. */
eq("defaultSettings().engine is 'google'", T.defaultSettings().engine, 'google');
ok('the engine select marks the google option selected',
  html.indexOf('value="google" selected') >= 0);
ok('google is the only engine option marked selected',
  (html.match(/<option value="(google|browser)"\s*selected/g) || []).length === 1,
  JSON.stringify(html.match(/<option value="(google|browser)"[^>]*selected/g) || []));
ok('the engine select is still present as #engine', html.indexOf('id="engine"') >= 0);

/* D. English is a selectable target, and the list is the full 21 locales. */
ok('en_US is a selectable target', targetCodes.indexOf('en_US') >= 0);
ok('en_GB is a selectable target', targetCodes.indexOf('en_GB') >= 0);
eq('the target list is 21 locales', targetCodes.length, 21);

/* E. The un-translated input can no longer be spoken: the Speak button and the
   auto-speak toggle are gone from the markup, and no code path references the
   selection box, the old handler, or auto-speak at all. Plain absence — the
   previous code named none of these in a comment either. */
ok('the markup has no Speak button (id="btnSpeak")', html.indexOf('id="btnSpeak"') === -1);
ok('the markup has no auto-speak toggle (id="autoSpeak")', html.indexOf('id="autoSpeak"') === -1);
ok('the script has no speechSelection', code.indexOf('speechSelection') === -1);
ok('the script has no onSpeak', code.indexOf('onSpeak') === -1);
ok('the script has no autoSpeak', code.indexOf('autoSpeak') === -1);
ok('neither the speak button nor the auto-speak toggle is exported',
  !['onSpeak', 'autoSpeak'].some(function (k) { return k in T; }),
  Object.keys(T).join(','));

/* F. The default target is DERIVED from the browser's own language, not
   hard-coded, and a SAVED target beats the derived one. The three invariants:
   the shipped DEFAULT_TARGET is exactly defaultTargetFor(BROWSER_LANG), the
   settings defaults use it, and loadSettings() prefers a stored target.

   NOT SELF-DERIVED. This assertion used to be
       eq(..., T.DEFAULT_TARGET, T.defaultTargetFor(T.BROWSER_LANG, T.TARGET_LOCALES))
   which is vacuous with respect to defaultTargetFor: DEFAULT_TARGET is ITSELF
   produced at import by defaultTargetFor (index.html: `const DEFAULT_TARGET =
   defaultTargetFor(BROWSER_LANG, TARGET_LOCALES)`), so a second call to the same
   function always agreed with it — any bug in the derivation moved BOTH sides of
   the comparison and the assertion stayed green. The expectation is now two
   literals read off the specification instead:
     * this harness evaluates the page under node, where `navigator` does not
       exist, so BROWSER_LANG is the empty string — asserted as '' below;
     * the spec's rule 4 (and `if (!raw)` early in the function) says an empty
       language yields the fallback, and the fallback is independently pinned to
       the literal 'en_US' by 'DEFAULT_TARGET_FALLBACK' in the section above.
   So the expected value is the fixed string 'en_US', not a second evaluation. */
eq('DEFAULT_TARGET is the target derived from the browser language',
  [T.BROWSER_LANG, T.DEFAULT_TARGET], ['', 'en_US']);
eq('defaultSettings().target is the derived DEFAULT_TARGET',
  T.defaultSettings().target, T.DEFAULT_TARGET);
ok('the derived DEFAULT_TARGET is a selectable target',
  targetCodes.indexOf(T.DEFAULT_TARGET) >= 0, T.DEFAULT_TARGET);
/* With no storage at all, loadSettings() still returns the derived default. */
eq('loadSettings() without storage yields the derived default target',
  T.loadSettings().target, T.DEFAULT_TARGET);

/* Saved-target precedence, without a storage seam in the source: the sandbox
   is the script's global object, so a localStorage installed here is the one
   lsGet() sees. It is removed again below, so no later fixture is affected. */
const savedTarget = T.DEFAULT_TARGET === 'ja_JP' ? 'ko_KR' : 'ja_JP';
const lsStub = {
  getItem: function (k) { return k === 'tweb.settings.v1' ? JSON.stringify({ target: savedTarget }) : null; },
  setItem: function () { return undefined; },
  removeItem: function () { return undefined; }
};
sandbox.localStorage = lsStub;
eq('a saved target beats the derived default in loadSettings()', T.loadSettings().target, savedTarget);
delete sandbox.localStorage;
eq('with the storage stub removed, the derived default is back', T.loadSettings().target, T.DEFAULT_TARGET);

/* G. The stale-engine migration. The old build defaulted the engine to
    'browser' and PERSISTED it, so a returning user's tweb.settings.v1 says
    engine:'browser' and the page never even tries Google audio. The migration
    must drop that one field and keep the rest of the record. */
function settingsStub(record) {
  const calls = { removeItem: [], setItem: [] };
  return {
    calls: calls,
    getItem: function (k) { return k === 'tweb.settings.v1' ? JSON.stringify(record) : null; },
    setItem: function (k, v) { calls.setItem.push(k); return undefined; },
    removeItem: function (k) { calls.removeItem.push(k); return undefined; }
  };
}
const oldSpeed = (T.SPEED_MIN + T.SPEED_MAX) / 2;             /* inside the clamp range */
const oldVoice = 'urn:fixture:2';

const stale = settingsStub({ engine: 'browser', target: savedTarget, speed: oldSpeed, voice: oldVoice });
sandbox.localStorage = stale;
const migrated = T.loadSettings();
eq("a persisted engine:'browser' from the old build is migrated to 'google'",
  migrated.engine, 'google');
eq('the migration preserves the saved target', migrated.target, savedTarget);
eq('the migration preserves the saved speed', migrated.speed, oldSpeed);
eq('the migration preserves the saved voice', migrated.voice, oldVoice);
eq('the migration deleted nothing from storage', stale.calls.removeItem, []);
eq('the migration did not rewrite storage behind the user\'s back', stale.calls.setItem, []);

const current = settingsStub({ engine: 'google', target: savedTarget, speed: oldSpeed, voice: oldVoice });
sandbox.localStorage = current;
const kept = T.loadSettings();
eq("a persisted engine:'google' is left alone", kept.engine, 'google');
eq('and its other settings survive too', [kept.target, kept.speed, kept.voice],
  [savedTarget, oldSpeed, oldVoice]);

const junk = settingsStub({ engine: 'BROWSER', target: savedTarget, speed: oldSpeed, voice: oldVoice });
sandbox.localStorage = junk;
eq('an unrecognised stored engine falls back to the default, other settings intact',
  [T.loadSettings().engine, T.loadSettings().target, T.loadSettings().speed],
  ['google', savedTarget, oldSpeed]);

delete sandbox.localStorage;
eq('with no storage at all the default engine is google', T.loadSettings().engine, 'google');
eq('defaultSettings().engine is still google with no storage', T.defaultSettings().engine, 'google');

section('strict parser: what must be rejected');
throws('parseGoogleTranslate(null) throws', function () { T.parseGoogleTranslate(null); });
throws('parseGoogleTranslate([]) throws', function () { T.parseGoogleTranslate([]); });
throws('parseGoogleTranslate([null]) throws', function () { T.parseGoogleTranslate([null]); });
throws("whitespace translation ['   ','en'] throws", function () { T.parseGoogleTranslate(['   ', 'en']); });
throws("empty translation ['','en'] throws", function () { T.parseGoogleTranslate(['', 'en']); });
throws("non-string detected field ['hi',5] throws", function () { T.parseGoogleTranslate(['hi', 5]); });
throws("truthy non-array segment [['a'],'notanarray'] throws", function () {
  T.parseGoogleTranslate([[['a'], 'notanarray']]);
});
throws('a non-array data throws', function () { T.parseGoogleTranslate({ a: 1 }); });
throws('a segmented response with no usable text throws', function () { T.parseGoogleTranslate([[[null]]]); });

section('strict parser: what must be accepted');
const flat = T.parseGoogleTranslate(['hello', 'en']);
eq("['hello','en'] -> text", flat.text, 'hello');
eq("['hello','en'] -> detected", flat.detected, 'en');
eq("['hello','en'] -> flat shape", flat.shape, 'flat');
const nestedFlat = T.parseGoogleTranslate([['hello', 'en']]);
eq('[["hello","en"]] (the shape clients5 really returns) -> text', nestedFlat.text, 'hello');
eq('[["hello","en"]] -> detected', nestedFlat.detected, 'en');
const seg = T.parseGoogleTranslate([[['hi', 'hello', null, null, 3]], ['en'], null]);
eq('segmented fixture -> text', seg.text, 'hi');
eq('segmented fixture -> detected "" (data[2] is null)', seg.detected, '');
eq('segmented fixture -> shape', seg.shape, 'segmented');
const segNullTail = T.parseGoogleTranslate([[['a', 'x'], null, ['b', 'y']]]);
eq('a falsy trailing segment is skipped, matching the desktop', segNullTail.text, 'ab');
eq('detected falls back to "" when data[2] is absent', T.parseGoogleTranslate([[['a']]]).detected, '');
eq('detected is read from data[2] in the segmented shape', T.parseGoogleTranslate([[['a']], null, 'de']).detected, 'de');

section('document-level referrer policy, and what counts as speakable');

/* The media element already carries referrerPolicy='no-referrer' (asserted in
   the fixture below), but that alone does not stop the Referer in practice: the
   policy that governs a media fetch is the DOCUMENT's. So the page must also
   declare it once, in <head>, where it covers every subresource request. */
ok('the page declares a document-level no-referrer policy',
  /<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/i.test(html),
  'no <meta name="referrer" content="no-referrer"> in the served markup');

/* R3: "somewhere in the file" is not the requirement. A referrer meta tag
   parked in <body> — or after </head> — is inert: the document-level policy is
   only honoured when the parser sees it inside the head, before subresources
   are fetched. So the assertion above, which only greps the whole file, is not
   enough on its own. Locate the head region and require the tag to sit in it.
   This fails if the tag is moved outside <head>. */
const headOpenAt = html.search(/<head\b[^>]*>/i);
const headCloseAt = html.search(/<\/head\s*>/i);
const referrerMetaAt = html.search(/<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/i);
ok('the no-referrer meta tag sits INSIDE the <head> region, not merely in the file',
  headOpenAt >= 0 && headCloseAt > headOpenAt &&
  referrerMetaAt > headOpenAt && referrerMetaAt < headCloseAt,
  'head at ' + headOpenAt + ', meta at ' + referrerMetaAt + ', /head at ' + headCloseAt);

/* A Google failure can leave a punctuation-only remainder. Handing "." to the
   local engine makes it say "dot" — nonsense that also misleads the user about
   what failed. The gate is "at least one letter or digit", Unicode-aware so
   Hangul/CJK still counts as speech. */
ok('hasSpeakableContent is exported', typeof T.hasSpeakableContent === 'function');
/* The gate is Unicode-aware, so EVERY script the app can translate has to pass
   it, not just the Latin/Hangul/CJK ones that happened to be in the table when
   it was written. A false negative here is silent and user-visible: the
   translation is shown and nothing is read aloud. */
const speakableCases = [
  ['.', false],
  ['...', false],
  ['', false],
  ['   ', false],
  [',', false],
  [', ', false],
  ['\n\t ', false],
  ['hello', true],
  ['안녕하세요', true],
  ['語', true],
  ['123', true],
  ['. hello', true],
  ['。', false],
  ['안녕.', true],
  ['مرحبا', true],
  ['नमस्ते', true],
  ['สวัสดี', true],
  ['Привет', true],
  ['Xin chào', true],
  ['Merhaba', true]
];
for (const c of speakableCases) {
  eq('hasSpeakableContent(' + JSON.stringify(c[0]) + ')', T.hasSpeakableContent(c[0]), c[1]);
}
report('the guard in runSpeech uses hasSpeakableContent',
  /if \(!hasSpeakableContent\(remainder\)\)/.test(code) ? 'yes' : 'NO');
ok('the runSpeech fallback guard calls hasSpeakableContent',
  /if \(!hasSpeakableContent\(remainder\)\)/.test(code));
ok('the old punctuation-blind guard is gone',
  code.indexOf('!remainder || !remainder.trim()') === -1);

/* R2 (b): EXERCISE THE catch BRANCH.
   A regex LITERAL carrying a Unicode property escape is a PARSE error on an
   engine without property-escape support, so such an engine never reaches the
   catch and the whole inline script fails to load — the page dies at parse
   time. The pattern must therefore be built with the RegExp CONSTRUCTOR inside
   a try. Node DOES support property escapes, so on this engine the catch is
   dead code and no assertion against the main context can ever reach it. The
   honest way to exercise it is a second context in which the global RegExp
   binding is shadowed by a constructor that throws exactly as such an engine
   would — everything else the script touches is unchanged. (Verified: RegExp
   appears in index.html only in that one constructor call, so shadowing the
   global is safe and does not perturb the rest of the module.) */
function LegacyRegExp(pattern, flags) {
  if (typeof pattern === 'string' && /\\+p\{/.test(pattern)) {
    throw new SyntaxError('invalid property escape: simulated pre-\\p{...} engine');
  }
  return new RegExp(pattern, flags);
}
const noEscapeSandbox = {
  module: { exports: {} },
  console: console,
  document: {
    addEventListener: function () {},
    getElementById: function () { return null; },
    createElement: function () { return {}; },
    removeEventListener: function () {}
  },
  window: undefined,
  fetch: function () { throw new Error('the harness must never touch the network'); },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  RegExp: LegacyRegExp
};
noEscapeSandbox.globalThis = noEscapeSandbox;
vm.createContext(noEscapeSandbox);
vm.runInContext(code, noEscapeSandbox, { filename: 'index.inline.no-prop-escape.js' });
const T2 = noEscapeSandbox.module.exports;

/* Self-check first: a shadow that did not arm would make the three assertions
   below vacuous, so prove the throw happens before relying on it. */
throws('the shadowed RegExp really does throw on a property-escape pattern',
  function () { return new LegacyRegExp('[\\p{L}\\p{N}]', 'u'); });

eq('in the no-property-escape context the ASCII fallback accepts "hello"',
  T2.hasSpeakableContent('hello'), true);
eq('in the no-property-escape context the ASCII fallback rejects "."',
  T2.hasSpeakableContent('.'), false);
/* The discriminator. The fallback is deliberately narrower than the Unicode
   pattern, so a CJK character is rejected there but accepted in the main
   context. If the two agreed, the catch was never taken and this whole block
   would be proving nothing. */
eq('the no-property-escape context really took the ASCII fallback (CJK rejected there, accepted in the main context)',
  [T2.hasSpeakableContent('語'), T.hasSpeakableContent('語')], [false, true]);
eq('the no-property-escape context still loads and exports the module',
  typeof T2.hasSpeakableContent, 'function');

/* R2 (c): the accepted SOURCE-LEVEL proof. A behavioural proof of the
   constructor-vs-literal requirement is impossible on this engine — the
   literal works fine here, so the two forms are indistinguishable from the
   outside. These two assertions on the source text ARE the proof, and they are
   deliberately not softened into "it currently works".
   The negative one cannot false-trip on the prose: the comment in index.html
   warns about the literal without ever writing the literal form. */
ok('index.html never writes the property-escape pattern as a regex LITERAL (/[\\p{L}\\p{N}]/u must not appear)',
  html.indexOf('/[\\p{L}\\p{N}]/u') === -1,
  'the property-escape literal is present in the served markup');
ok('index.html builds the speakable pattern at runtime with a RegExp CONSTRUCTOR carrying the property escape',
  /new\s+RegExp\(\s*'[^'\n]*p\{L\}[^'\n]*'\s*,/.test(html));

section('TTS remainder on partial playback failure (injectable audio backend)');

/* HARNESS GUARD. A stub whose speak() never fires onend leaves an await
   unsettled; node then drains its event loop and exits 0 with no summary,
   which reads as success. This timer makes that impossible: if finish() has
   not run within 20s, record a failure and finish anyway. unref() keeps the
   timer itself from holding the process open. The id is assigned to the
   harness-wide `let` declared at the top -- NOT to a fresh `const` here --
   because the backstop can call finish() before this line has ever run. */
harnessFailsafe = setTimeout(function () {
  failures.push('harness did not complete (an await never settled)');
  finish();
}, 20000);
if (harnessFailsafe && typeof harnessFailsafe.unref === 'function') harnessFailsafe.unref();

/* unref() means the timer will not hold the process open, so on a true hang it
   never fires — the event loop drains and node exits. This guard closes that
   gap: the harness can never exit 0 without having printed the summary, and
   the summary it prints here is the same FAIL line finish() prints. */
process.on('exit', function (code) {
  if (finished) return;
  if (!failures.length) {
    failures.push('the harness exited before finish() ran (an await never settled)');
  }
  printFailures();
  if (code === 0) process.exitCode = 1;
});

(async function runRemainderFixture() {
  const sentences = [];
  for (let i = 0; i < 13; i++) {
    const tag = ('[' + i + ']').padEnd(48, '.');
    sentences.push(tag + '.');
  }
  const text = sentences.join('');                       /* 13 x 50 = 650 chars */
  const parts = guardChunks('the 13 x 50 remainder fixture input', T.chunkForTts(text), 4);
  eq('the fixture input is 4 TTS chunks', parts.length, 4);

  /* A FRESH backend and a FRESH played-log per case. Sharing one mutable
     `played` array and one mutable `failAt` across sequential calls leaks
     state between cases: the failure test keys off played.length, so the
     second call would reject on its very first chunk. */
  function makeBackend(failAt) {
    const played = [];
    return {
      played: played,
      backend: {
        play: function (url) {
          const payload = decodeURIComponent(url.split('&q=')[1].split('&')[0]);
          if (played.length === failAt) return Promise.reject(new Error('simulated HTTP 400'));
          played.push(payload);
          return Promise.resolve({ ok: true });
        }
      }
    };
  }

  /* Fail on the second chunk of 4: chunk 1 plays, chunk 2 rejects. */
  const partialRun = makeBackend(1);
  const outcome = await T.speakGoogle(text, 'zh_CN', 1.0, { backend: partialRun.backend });

  eq('a failed chunk does not report success', outcome.mode, 'partial');
  eq('the chunks before the failure were played', outcome.played, 1);
  eq('exactly one chunk was handed to the audio backend', partialRun.played.length, 1);
  /* Defensive reads of `remainder`. An absent remainder used to throw a
     TypeError inside this async fixture, and the outer .catch turned that into
     ONE failure naming the throw while skipping every assertion after it. Now
     it is a stated mismatch on the assertion that needs it, so the rest of the
     fixture still runs. This is NOT a relaxation: an absent remainder FAILS,
     where before it merely crashed. The `remIsText &&` term is what makes an
     undefined remainder fail instead of throwing; the check count is
     unchanged, so no assertion was added, removed, or relaxed. */
  const rem = outcome.remainder;
  const remIsText = typeof rem === 'string';
  /* NOT SELF-DERIVED. The expectation used to be joinTranslated(parts.slice(2),
     'zh_CN') — the same function under test, called a second time — so a bug in
     the joining logic appeared on BOTH sides of the comparison and cancelled
     itself out; the assertion could only ever fail if speakGoogle disagreed
     about WHICH pieces to pass, never about how they are joined. It is built
     here by LITERAL CONCATENATION of the two known input pieces instead:
       * `parts` comes from chunkForTts, a DIFFERENT function, so the chunk
         boundaries are not under test here;
       * the separator is a character written out in this file, and is
         independently pinned by "the zh separator is ''" further up.
     For a two-element list those two facts fully determine the result:
     parts[2] + parts[3] with no separator between them. */
  const zhRemainderExpected = parts[2] + parts[3];
  eq('the remainder is chunks 3 and 4 joined by the target rule',
    rem, zhRemainderExpected);
  ok('the remainder is never the full text', rem !== text,
    'the remainder must not replay the chunk that already played');
  ok('the remainder does not include the chunk that played',
    remIsText && rem.indexOf(parts[0]) === -1,
    'expected a string remainder, got ' + JSON.stringify(rem));
  report('remainder join (zh_CN, no separator)', JSON.stringify(String(rem).slice(0, 24)) + '...');

  /* Same failure with a spaced language must join with a space. NOT
     SELF-DERIVED, for the same reason as the zh_CN case above: the expected
     string is the two known pieces with ONE space written out literally
     between them, not joinTranslated(parts.slice(2), 'de_DE') called again. */
  const deRemainderExpected = parts[2] + ' ' + parts[3];
  const spacedRun = makeBackend(1);
  const spaced = await T.speakGoogle(text, 'de_DE', 1.0, { backend: spacedRun.backend });
  eq('the remainder uses the space join for a spaced target',
    spaced.remainder, deRemainderExpected);

  /* Nothing played at all -> the whole text is the remainder.
     NOTE: this case targets 'zh_CN', not a spaced language. The assertion
     "the remainder IS the full text" is only expressible for a no-space
     target: joinTranslated(parts, 'de_DE') joins the 4 chunks with a space,
     which is CORRECT for German but not byte-identical to the fixture text,
     because the fixture has no space at its chunk boundaries. Asserting
     remainder === text under de_DE would encode a wrong expectation. */
  const firstFailRun = makeBackend(0);
  const firstFailure = await T.speakGoogle(text, 'zh_CN', 1.0, { backend: firstFailRun.backend });
  eq('a failure on the first chunk is not a partial playback', firstFailure.mode, 'failed');
  eq('when nothing played, the remainder is the full text', firstFailure.remainder, text);

  /* Everything plays -> done, no remainder. failAt -1 never matches. */
  const allOkRun = makeBackend(-1);
  const allOk = await T.speakGoogle(text, 'de_DE', 1.0, { backend: allOkRun.backend });
  eq('a clean run reports done', allOk.mode, 'done');
  eq('a clean run played every chunk', allOk.played, 4);

  /* A stale generation must produce no remainder fallback at all. */
  const staleBackend = { play: function () { return Promise.reject(new Error('boom')); } };
  const stale = await T.speakGoogle(text, 'de_DE', 1.0, { gen: T.getOpGen() + 99, backend: staleBackend });
  eq('a stale generation yields a benign stale result', stale, { stale: true });

  /* SPEC CHANGE (TTS hard split). This used to assert mode 'unsplittable' for
     'a' x 250, which was the whole bug: chunkForTts returned null, so the loop
     below never ran, ZERO TTS requests were made and the browser voice — which
     usually has none for the target language — got the text. The same input is
     now split and spoken, and the 'unsplittable' guard itself is kept in
     speakGoogle as a defensive branch that chunkForTts can no longer reach. */
  const longRun = makeBackend(-1);
  const longOutcome = await T.speakGoogle('a'.repeat(250), 'de_DE', 1.0, { backend: longRun.backend });
  eq("'a' x 250 is now spoken rather than reported unsplittable", longOutcome.mode, 'done');
  eq("'a' x 250 was handed to the audio backend as 2 chunks", longRun.played.length, 2);
  eq("'a' x 250 was played as 2 chunks", longOutcome.played, 2);
  ok("'a' x 250 reassembled in the audio backend is the whole input",
    longRun.played.join('') === 'a'.repeat(250));
  /* R5: the source-scan assertion that used to live here —
       ok("the 'unsplittable' defensive branch is still in speakGoogle", ...)
     — was the ONE pre-existing assertion removed by this change. It asserted
     structural trivia: that a branch chunkForTts can no longer return is still
     spelled a particular way in the source. The behavioural assertions above
     are the contract, and they are untouched. The defensive branch itself is
     still in index.html; nothing about it is skipped or disabled. */

  /* The provider builds a tts url with the bucket and the language. */
  const url = T.PROVIDERS.google.ttsUrl('hi', 'zh-CN', 0.8);
  ok('the TTS url carries the language, the text and the bucket',
    url.indexOf('tl=zh-CN') >= 0 && url.indexOf('&q=hi&') >= 0 && url.indexOf('ttsspeed=0.8') >= 0, url);
  ok('the TTS url is on the Google translate host', url.indexOf('https://translate.google.com/translate_tts') === 0, url);

  /* The provider exposes exactly two failover endpoints, tried in order.
     A third candidate was removed: it sends no Access-Control-Allow-Origin
     header, so a page-level fetch of it can only ever fail CORS. */
  eq('exactly two translate endpoints', T.PROVIDERS.google.endpoints.length, 2);
  ok('endpoint 1 is the gtx endpoint', T.PROVIDERS.google.endpoints[0].indexOf('translate.googleapis.com') > 0);
  ok('endpoint 2 is the clients5 dict-chrome-ex endpoint',
    T.PROVIDERS.google.endpoints[1].indexOf('clients5.google.com') > 0 &&
    T.PROVIDERS.google.endpoints[1].indexOf('client=dict-chrome-ex') > 0);
  ok('no active endpoint is the CORS-dead translate.google.com/translate_a/single one',
    !T.PROVIDERS.google.endpoints.some(function (u) {
      return u.indexOf('translate.google.com/translate_a/single') >= 0;
    }),
    JSON.stringify(T.PROVIDERS.google.endpoints));
  const built = T.PROVIDERS.google.buildUrl(T.PROVIDERS.google.endpoints[0], 'a b', 'zh-CN');
  ok('a built url carries the encoded text and target', built.indexOf('q=a%20b') > 0 && built.indexOf('tl=zh-CN') > 0, built);

  /* Chrome voices are optional, so the browser-speech path must degrade rather
     than throw. The module DOES allow injection: it resolves `speechSynthesis`
     and `SpeechSynthesisUtterance` as globals of the evaluating context at CALL
     time, so the fixture installs stubs on the context object. That is the seam
     exercised below — the real functions, not a re-implementation. */
  section('browser speech: no voice, no speech synthesis, and a restored voice');

  /* Resolve without letting a throw abort the rest of the fixture. */
  async function settle(promise) {
    try { return { value: await promise }; }
    catch (err) { return { error: err }; }
  }

  /* (a) No speechSynthesis global at all. */
  delete sandbox.speechSynthesis;
  delete sandbox.SpeechSynthesisUtterance;
  const noSynth = await settle(T.speakBrowser('hello', { gen: T.getOpGen() }));
  ok('speakBrowser does not throw when speechSynthesis is absent', noSynth.error === undefined,
    noSynth.error ? String(noSynth.error && noSynth.error.message || noSynth.error) : 'resolved');
  eq('speakBrowser resolves to an unsupported result when speechSynthesis is absent',
    noSynth.value, { unsupported: true });
  eq('listBrowserVoices is [] when speechSynthesis is absent', T.listBrowserVoices(), []);

  /* A stubbed platform. speak() schedules the utterance's own onend, which is
     how a real browser proves the utterance finished. */
  function stubPlatform(voices) {
    const log = { spoken: 0, utterances: [] };
    function FakeUtterance(text) { this.text = text; }
    const synth = {
      getVoices: function () { return voices; },
      speak: function (u) {
        log.spoken += 1; log.utterances.push(u);
        setTimeout(function () { if (u.onend) u.onend({}); }, 0);
      },
      cancel: function () { log.cancelled += 1; },
      log: log
    };
    log.cancelled = 0;
    return { synth: synth, Utterance: FakeUtterance, log: log };
  }

  /* (b) The empty-voice-list path: nothing to match, so no voice is forced
     onto the utterance — but the utterance must still be spoken. */
  const emptyPlatform = stubPlatform([]);
  sandbox.speechSynthesis = emptyPlatform.synth;
  sandbox.SpeechSynthesisUtterance = emptyPlatform.Utterance;
  eq('listBrowserVoices is [] when getVoices() returns an empty list', T.listBrowserVoices(), []);
  const emptyVoices = await settle(T.speakBrowser('hello', { gen: T.getOpGen(), voiceURI: 'urn:not-installed' }));
  ok('speakBrowser does not throw when the voice list is empty', emptyVoices.error === undefined,
    emptyVoices.error ? String(emptyVoices.error && emptyVoices.error.message || emptyVoices.error) : 'resolved');
  eq('an empty voice list still speaks, and resolves ok', emptyVoices.value, { ok: true });
  eq('the utterance really was handed to speechSynthesis.speak', emptyPlatform.log.spoken, 1);
  eq('no voice is forced onto the utterance when the list is empty',
    emptyPlatform.log.utterances[0].voice, undefined);
  eq('the spoken text is the sanitised argument', emptyPlatform.log.utterances[0].text, 'hello');

  /* (c) A voice that IS present must be applied to the utterance. */
  const known = { name: 'Fixture Voice', lang: 'en-GB', voiceURI: 'urn:fixture:1' };
  const other = { name: 'Other Voice', lang: 'en-US', voiceURI: 'urn:fixture:2' };
  const fullPlatform = stubPlatform([known, other]);
  sandbox.speechSynthesis = fullPlatform.synth;
  const chosen = await settle(T.speakBrowser('hi', { gen: T.getOpGen(), voiceURI: 'urn:fixture:2' }));
  eq('a known voiceURI is applied to the utterance', chosen.value, { ok: true });
  eq('the applied voice is the one that was asked for', fullPlatform.log.utterances[0].voice, other);

  /* A getVoices() that throws must degrade to an empty list, not propagate. */
  sandbox.speechSynthesis = {
    getVoices: function () { throw new Error('platform is grumpy'); },
    /* speak MUST still schedule the utterance's own onend, exactly as
       stubPlatform does. A no-op speak() here would make speakBrowser's
       promise never settle: the event loop drains, node exits 0, and the
       harness prints no summary at all. */
    speak: function (u) { setTimeout(function () { if (u.onend) u.onend({}); }, 0); },
    cancel: function () {}
  };
  const grumpy = await settle(T.speakBrowser('hi', { gen: T.getOpGen(), voiceURI: 'urn:fixture:1' }));
  ok('speakBrowser does not throw when getVoices() throws', grumpy.error === undefined,
    grumpy.error ? String(grumpy.error && grumpy.error.message || grumpy.error) : 'resolved');
  eq('a throwing getVoices() degrades to an empty list', T.listBrowserVoices(), []);
  eq('a throwing getVoices() still speaks with the default voice', grumpy.value, { ok: true });

  section('voice preference: a saved voice is restored, a vanished one falls back');

  /* The grumpy platform above is still installed at this point and its
     getVoices() throws, which degrades every case below to an empty list.
     Re-install the full platform so the assertions below are measured against
     the two fixture voices. */
  sandbox.speechSynthesis = fullPlatform.synth;
  sandbox.SpeechSynthesisUtterance = fullPlatform.Utterance;
  eq('the voice list is back to the two fixture voices',
    T.listBrowserVoices().map(function (v) { return v.voiceURI; }), ['urn:fixture:1', 'urn:fixture:2']);

  eq('the saved voice wins when the platform still offers it',
    T.preferredVoice({ voice: 'urn:fixture:2' }), 'urn:fixture:2');
  eq('a voice the platform no longer offers falls back to the first one',
    T.preferredVoice({ voice: 'urn:removed' }), 'urn:fixture:1');
  eq('with no saved voice at all, the first available voice is chosen',
    T.preferredVoice({ voice: '' }), 'urn:fixture:1');
  eq('a missing settings record is treated as no saved voice',
    T.preferredVoice(undefined), 'urn:fixture:1');

  /* R6: the TARGET-AWARE half of preferredVoice's contract, which the four
     assertions above do not reach (they pass no target language at all, so only
     the select's own restore path is exercised). These are additional, never a
     replacement.

     The installed voices are deliberately ORDERED so that "return the first
     installed voice" — the answer an implementation that ignored targetLang
     would give — is NOT the answer any of the rules under test is supposed to
     produce. Without that ordering these assertions would pass on the very
     mutation they exist to catch. */
  const gbVoice = { name: 'Fixture GB', lang: 'en-GB', voiceURI: 'urn:pref:gb' };
  const koVoice = { name: 'Fixture Korean', lang: 'ko-KR', voiceURI: 'urn:pref:ko' };
  const usVoice = { name: 'Fixture US', lang: 'en-US', voiceURI: 'urn:pref:us' };
  const prefVoices = [gbVoice, koVoice, usVoice];
  const prefPlatform = stubPlatform(prefVoices);
  sandbox.speechSynthesis = prefPlatform.synth;
  sandbox.SpeechSynthesisUtterance = prefPlatform.Utterance;

  /* Guard the guard: state the first-installed answer explicitly, so a reader
     (and a mutation) can see it is not what the rules below return. */
  eq('the precedence platform lists the GB voice first, and the others after it',
    T.listBrowserVoices().map(function (v) { return v.voiceURI; }),
    ['urn:pref:gb', 'urn:pref:ko', 'urn:pref:us']);
  eq('the first installed voice is not the Korean one',
    T.listBrowserVoices()[0].voiceURI === T.listBrowserVoices()[1].voiceURI, false);

  /* B, rule 1: an explicitly SAVED voice that is still installed is the
     user's own choice and is honoured even when its language (en) is not the
     target (ko). */
  eq("rule 1: a saved installed voice is honoured even though its language differs from the target",
    T.preferredVoice({ voice: 'urn:pref:us' }, 'ko'), 'urn:pref:us');
  /* ... and it is honoured even for a target NOTHING installed matches, so the
     answer demonstrably cannot have come from rule 2. */
  eq('rule 1 still wins for a target that no installed voice matches',
    T.preferredVoice({ voice: 'urn:pref:us' }, 'ja'), 'urn:pref:us');
  /* The other half of rule 1: "saved AND installed". A saved voice that is NOT
     installed cannot be honoured, so the target rules apply instead. */
  eq('a saved voice that is not installed does not override the target match',
    T.preferredVoice({ voice: 'urn:pref:vanished' }, 'ko'), 'urn:pref:ko');

  /* C, rule 2: with no saved voice, the installed voice whose language matches
     the target is the one chosen. */
  eq("rule 2: with no saved voice, the target-language voice is chosen",
    T.preferredVoice({ voice: '' }, 'ko'), 'urn:pref:ko');
  eq('rule 2 matches on the base language, so ko_KR resolves to the same voice',
    T.preferredVoice(undefined, 'ko-KR'), 'urn:pref:ko');
  eq('rule 2 resolves an ambiguous language to one installed voice of that language',
    T.preferredVoice({ voice: '' }, 'en'), 'urn:pref:gb');

  /* D, rule 3: with no saved voice and nothing installed for the target, the
     answer is ''. The caller must read '' as DO NOT SPEAK — reading
     target-language text aloud with a wrong-language voice is the defect the
     rule exists to prevent, so silence beats gibberish. */
  eq("rule 3: no saved voice and no installed voice for 'ja' yields the empty selection",
    T.preferredVoice({ voice: '' }, 'ja'), '');
  eq('rule 3 applies to a missing settings record too', T.preferredVoice(undefined, 'ja'), '');
  /* Guard the guard: '' here is rule 3, not an empty platform. */
  eq('the rule-3 platform really has three installed voices', T.listBrowserVoices().length, 3);
  eq('none of them is Japanese', T.listBrowserVoices().filter(function (v) {
    return String(v.lang).toLowerCase().indexOf('ja') === 0;
  }).length, 0);

  /* The target rules must NOT leak into the no-target restore path: with no
     target language the saved voice wins, and a vanished saved voice still
     falls back to the first installed voice. */
  eq('with no target language the saved voice still wins',
    T.preferredVoice({ voice: 'urn:pref:us' }, undefined), 'urn:pref:us');
  eq('with no target language a vanished saved voice falls back to the first installed voice',
    T.preferredVoice({ voice: 'urn:pref:vanished' }, undefined), 'urn:pref:gb');

  sandbox.speechSynthesis = fullPlatform.synth;
  sandbox.SpeechSynthesisUtterance = fullPlatform.Utterance;
  eq('the full platform is restored after the target-aware voice cases',
    T.listBrowserVoices().map(function (v) { return v.voiceURI; }), ['urn:fixture:1', 'urn:fixture:2']);

  /* The genuinely-empty case needs a platform with NO voices installed, so
     temporarily install an empty-voice stub for this one assertion. */
  const silentPlatform = stubPlatform([]);
  sandbox.speechSynthesis = silentPlatform.synth;
  sandbox.SpeechSynthesisUtterance = silentPlatform.Utterance;
  eq('no saved voice and no platform voices yields an empty selection',
    T.preferredVoice({ voice: 'urn:removed' }), '');
  eq('that empty-voice platform really has no voices', T.listBrowserVoices(), []);
  sandbox.speechSynthesis = fullPlatform.synth;
  sandbox.SpeechSynthesisUtterance = fullPlatform.Utterance;
  eq('the full platform is restored after the empty-voice case',
    T.listBrowserVoices().map(function (v) { return v.voiceURI; }), ['urn:fixture:1', 'urn:fixture:2']);

  report('preferredVoice({voice:urn:fixture:2})', String(T.preferredVoice({ voice: 'urn:fixture:2' })));
  report('preferredVoice({voice:urn:removed})', String(T.preferredVoice({ voice: 'urn:removed' })));
  report("preferredVoice({voice:''})", String(T.preferredVoice({ voice: '' })));
  report('preferredVoice(undefined)', String(T.preferredVoice(undefined)));
  sandbox.speechSynthesis = stubPlatform([]).synth;
  report("preferredVoice({voice:urn:removed}) with no platform voices",
    String(T.preferredVoice({ voice: 'urn:removed' })));

  delete sandbox.speechSynthesis;
  delete sandbox.SpeechSynthesisUtterance;

  section('browser-local speech: the speakable gate and the voice precedence');

  /* R6: cases A-D drive the REAL runSpeech on its browser-PRIMARY path. Two
     things make that path reachable from this harness at all:
       * currentEngine() reads the #engine SELECT, not the stored settings, so
         the overlay below has to say engine.value = 'browser'. The engine in
         localStorage is irrelevant to the path taken.
       * PROVIDERS.google.supportsLocalVoice is TRUE, so the google branch is
         always the one production takes and the browser-primary path beneath
         it would otherwise be unreachable here.
     The overlay is installed HERE, deliberately AFTER the module-import
     assertion 'getElementById never called at import' has already run:
     installing it any earlier would make that pre-existing assertion fail. */
  const REAL_GET_ELEMENT_BY_ID = documentStub.getElementById;
  const uiNodes = {
    status: {
      textContent: '',
      attrs: {},
      setAttribute: function (k, v) { this.attrs[k] = String(v); }
    },
    engine: { value: 'browser' },
    voice: { value: '', disabled: false },
    speed: { value: '250' }
  };
  documentStub.getElementById = function (id) {
    domCalls.getElementById += 1;
    return Object.prototype.hasOwnProperty.call(uiNodes, id) ? uiNodes[id] : null;
  };

  /* The gate-rails: the overlay really is in force, and the two settings this
     section relies on to reach the browser path really hold. */
  eq('the overlay resolves #status to the captured status node',
    documentStub.getElementById('status'), uiNodes.status);
  eq('the #engine node really reports the browser engine', uiNodes.engine.value, 'browser');
  ok('the fixture speed is inside the clamp range, so currentWpm() honours it',
    Number(uiNodes.speed.value) >= T.SPEED_MIN && Number(uiNodes.speed.value) <= T.SPEED_MAX,
    uiNodes.speed.value);
  eq('the google provider really does claim local-voice support (so engine.value alone picks the path)',
    T.PROVIDERS.google.supportsLocalVoice, true);

  /* A FRESH platform and a FRESH status read per case. Sharing one mutable
     log leaks state between cases: the "nothing was spoken" cases read
     log.spoken, so a single shared platform would carry the previous case's
     utterance into the next. */
  function browserCase(voices) {
    const platform = stubPlatform(voices);
    sandbox.speechSynthesis = platform.synth;
    sandbox.SpeechSynthesisUtterance = platform.Utterance;
    uiNodes.status.textContent = '';
    uiNodes.status.attrs = {};
    const utter = function () { return platform.log.utterances[0]; };
    return {
      spoken: function () { return platform.log.spoken; },
      voice: function () { const u = utter(); return (u && u.voice) ? u.voice.voiceURI : undefined; },
      text: function () { const u = utter(); return (u && u.text !== undefined) ? u.text : undefined; },
      statusText: function () { return uiNodes.status.textContent; },
      statusKind: function () { return uiNodes.status.attrs['data-kind']; }
    };
  }
  function noThrow(name, settled) {
    ok(name, settled.error === undefined,
      settled.error ? String((settled.error && settled.error.message) || settled.error) : 'resolved');
  }

  /* A. PUNCTUATION-ONLY INPUT, browser-local. The Google-failure fallback path
     already carried a hasSpeakableContent guard; the browser-PRIMARY path — the
     one a user lands on after choosing "Browser local" — must carry the same
     gate, because "." passes a non-empty check and the local engine audibly
     says "dot" for it, which both misleads the user and hides what happened. */
  for (const punct of ['.', '...']) {
    const c = browserCase(prefVoices);
    const run = await settle(T.runSpeech(T.getOpGen(), { text: punct, lang: 'ko' }));
    noThrow('A: runSpeech does not throw on ' + JSON.stringify(punct) + ' in browser-local mode', run);
    eq('A: ' + JSON.stringify(punct) + ' starts NO utterance in browser-local mode', c.spoken(), 0);
    eq('A: ' + JSON.stringify(punct) + ' reports that nothing was speakable',
      c.statusText(), 'Nothing in the translation was speakable, so no audio was played.');
    eq('A: ' + JSON.stringify(punct) + ' reports an error, not a success', c.statusKind(), 'err');
  }
  /* Guard the guard: the target really DOES have an installed voice, so the
     silence above is the speakable gate's doing and not an accident of there
     being no usable voice. */
  eq("A: the target language really does have an installed voice, so the gate is what spoke",
    T.preferredVoice({ voice: '' }, 'ko'), 'urn:pref:ko');

  /* B. RULE 1 end to end: a SAVED, installed voice is the user's own choice and
     is spoken even though its language (en) is not the target (ko). */
  sandbox.localStorage = settingsStub({ engine: 'browser', target: 'ko_KR', speed: 250, voice: 'urn:pref:us' });
  const bCase = browserCase(prefVoices);
  const bRun = await settle(T.runSpeech(T.getOpGen(), { text: 'hello', lang: 'ko' }));
  noThrow('B: runSpeech does not throw with a saved browser voice', bRun);
  eq('B: the utterance really was started', bCase.spoken(), 1);
  eq("B: the SAVED voice spoke, not the target-language one", bCase.voice(), 'urn:pref:us');
  eq('B: the spoken text is the selection handed to runSpeech', bCase.text(), 'hello');
  eq('B: the status reports that it spoke', bCase.statusText(), 'Spoke with the browser voice.');
  delete sandbox.localStorage;

  /* C. RULE 2 end to end: no saved voice, so the installed voice whose language
     matches the target is the one that speaks. */
  const cCase = browserCase(prefVoices);
  const cRun = await settle(T.runSpeech(T.getOpGen(), { text: 'hello', lang: 'ko' }));
  noThrow('C: runSpeech does not throw with no saved voice', cRun);
  eq('C: the utterance really was started', cCase.spoken(), 1);
  eq("C: the installed voice matching the target 'ko' spoke, not the first installed one",
    cCase.voice(), 'urn:pref:ko');
  eq('C: the spoken text is the selection handed to runSpeech', cCase.text(), 'hello');
  eq('C: the status reports that it spoke', cCase.statusText(), 'Spoke with the browser voice.');

  /* D. RULE 3 end to end: no saved voice and NO installed voice for the target.
     Nothing is spoken, and the status says so in the user's own terms. */
  const dCase = browserCase(prefVoices);
  const dRun = await settle(T.runSpeech(T.getOpGen(), { text: 'hello', lang: 'ja' }));
  noThrow('D: runSpeech does not throw with no installed voice for the target', dRun);
  eq('D: NOTHING is spoken', dCase.spoken(), 0);
  eq('D: the status names the target language that has no installed voice',
    dCase.statusText(), 'No installed voice matches ja, so no audio was played.');
  eq('D: that status is an error, not a success', dCase.statusKind(), 'err');
  /* Guard the guard: the platform really has voices and none is Japanese, so
     the silence is rule 3 and not an empty voice list. */
  eq('D: the rule-3 platform really has three installed voices', T.listBrowserVoices().length, 3);
  eq('D: none of them is Japanese', T.listBrowserVoices().filter(function (v) {
    return String(v.lang).toLowerCase().indexOf('ja') === 0;
  }).length, 0);

  /* Restore the module's DOM seam and the platform globals, so nothing after
     this section can be perturbed by the overlay. */
  documentStub.getElementById = REAL_GET_ELEMENT_BY_ID;
  delete sandbox.speechSynthesis;
  delete sandbox.SpeechSynthesisUtterance;
  delete sandbox.localStorage;
  eq('the document seam is restored: the overlay is gone after this section',
    documentStub.getElementById('status'), null);
  eq('the platform speech globals are gone after this section',
    typeof sandbox.speechSynthesis + '/' + typeof sandbox.SpeechSynthesisUtterance, 'undefined/undefined');

  section('the media element must NOT send a Referer to the TTS endpoint');

  /* The real bug: Google serves a 404 text/html page to a translate_tts
     request that carries a Referer, and audio/mpeg only when it carries none.
     A media element always sends one cross-origin, so the audio never loaded
     and the user heard the computer voice instead. The element must therefore
     be told to omit the header, BEFORE src is assigned. This drives the real
     defaultAudioBackend() — not the injectable stub — so a revert of the fix
     in the play path fails here. */
  ok('defaultAudioBackend is exported', typeof T.defaultAudioBackend === 'function');

  const created = [];
  function FakeAudio() {
    this.referrerPolicy = '';
    this.attrs = {};
    this.onplaying = null; this.onended = null; this.onerror = null;
    this.paused = false;
    /* Snapshotted by the src setter below: what the policy was AT THE MOMENT
       the request was kicked off. A policy assigned after src is too late. */
    this.referrerPolicyAtSrc = null;
    /* R1: a real browser REFLECTS the referrerPolicy IDL property into the
       content attribute and back, so one snapshot would cover both spellings.
       This stub deliberately does NOT reflect — `this.referrerPolicy` and
       `this.attrs` are separate stores — and that separation is exactly what
       makes the ORDERING of the two assignments independently observable. Keep
       it that way: coupling them here would silently disarm the assertions
       below, because setting either one would satisfy both snapshots. */
    this.referrerPolicyAttrAtSrc = null;
    created.push(this);
  }
  Object.defineProperty(FakeAudio.prototype, 'src', {
    get: function () { return this._src; },
    set: function (v) {
      this._src = v;
      this.referrerPolicyAtSrc = this.referrerPolicy;
      this.referrerPolicyAttrAtSrc = this.getAttribute('referrerpolicy');
    }
  });
  FakeAudio.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
  FakeAudio.prototype.getAttribute = function (k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  };
  FakeAudio.prototype.pause = function () { this.paused = true; };
  /* Fires onplaying then onended, so the promise settles as a real successful
     playback would — the stubPlatform pattern, applied to audio. */
  FakeAudio.prototype.play = function () {
    const self = this;
    return Promise.resolve().then(function () {
      if (self.onplaying) self.onplaying();
      if (self.onended) self.onended();
    });
  };
  sandbox.Audio = FakeAudio;

  const audioUrl = 'https://translate.google.com/translate_tts?ie=UTF-8&q=hola';
  const playOutcome = await T.defaultAudioBackend().play(audioUrl, T.getOpGen());

  eq('play() created exactly one media element', created.length, 1);
  eq('the media element is told to omit the Referer header',
    created[0].referrerPolicy, 'no-referrer');
  eq('the no-referrer policy is also set as an attribute',
    created[0].getAttribute('referrerpolicy'), 'no-referrer');
  eq('the policy was in place BEFORE src was assigned, so the request omits it',
    created[0].referrerPolicyAtSrc, 'no-referrer');
  /* R1: the pre-existing assertion above only covers the IDL PROPERTY. The
     page sets the content attribute too, and that is a second, independent
     assignment with its own ordering requirement. This fails if the
     setAttribute call is moved to after `audio.src = url`. */
  eq('the no-referrer ATTRIBUTE was also in place BEFORE src was assigned',
    created[0].referrerPolicyAttrAtSrc, 'no-referrer');
  eq('src really was the URL under test', created[0].src, audioUrl);
  eq('the fake playback reports success', playOutcome, { ok: true });

  delete sandbox.Audio;
  report('referrerPolicy on the element', created[0].referrerPolicy);
  report('referrerPolicy when src was assigned', created[0].referrerPolicyAtSrc);

  finish();
})().catch(function (err) {
  failures.push('remainder fixture threw: ' + ((err && err.stack) || err));
  finish();
});

/* -------------------------------- report -------------------------------- */

function finish() {
  if (finished) return;
  finished = true;
  /* Null-tolerant on purpose: harnessFailsafe is only assigned once the async
     fixtures are armed, and the backstop above can reach finish() long before
     that -- clearTimeout of a temporal-dead-zone `const` would be a second,
     worse crash. */
  if (harnessFailsafe !== null && harnessFailsafe !== undefined) clearTimeout(harnessFailsafe);
  if (failures.length) {
    printFailures();
    process.exit(1);
  }
  process.stdout.write('\nPASS  ' + checks + ' checks, 0 failures\n');
  process.exit(0);
}
