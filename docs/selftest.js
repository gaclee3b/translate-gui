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

const HTML_PATH = path.join(__dirname, 'index.html');

/* ------------------------------ harness ------------------------------ */

const failures = [];
let checks = 0;
let finished = false;

function ok(name, condition, detail) {
  checks += 1;
  if (condition) return true;
  failures.push(detail ? name + ' -> ' + detail : name);
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
eq("'a' x 8000 -> 1 chunk", T.chunkForTranslate('a'.repeat(8000)).map(function (c) { return c.length; }), [8000]);
eq("'a' x 8001 -> 2 chunks [8000, 1]",
  T.chunkForTranslate('a'.repeat(8001)).map(function (c) { return c.length; }), [8000, 1]);

section('hard split path: one unpunctuated sentence');
const hundredK = T.chunkForTranslate('a'.repeat(100000));
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
const cjk1200 = T.chunkForTranslate(cjk(1200));
eq('1200 CJK chars -> 2 requests', cjk1200.length, 2);
ok('each 1200-CJK request is within budget',
  cjk1200.every(function (c) { return T.encodedLen(c) <= 8000; }),
  JSON.stringify(cjk1200.map(function (c) { return T.encodedLen(c); })));
eq('the 1200-CJK case really does exceed one request', T.encodedLen(cjk(1200)) > 8000, true);
report('1200 CJK encoded', T.encodedLen(cjk(1200)));
report('1200 CJK per-chunk encoded', JSON.stringify(cjk1200.map(function (c) { return T.encodedLen(c); })));

const cjk2000 = T.chunkForTranslate(cjk(2000));
eq('2000 CJK chars -> 3 requests', cjk2000.length, 3);
ok('each 2000-CJK request is within budget',
  cjk2000.every(function (c) { return T.encodedLen(c) <= 8000; }),
  JSON.stringify(cjk2000.map(function (c) { return T.encodedLen(c); })));
eq('2000 CJK reassembles to the original input', cjk2000.join(''), cjk(2000));
report('2000 CJK per-chunk encoded', JSON.stringify(cjk2000.map(function (c) { return T.encodedLen(c); })));

section('hard split of an oversized single CJK sentence (no terminator)');
const cjkRun = Array.from(cjk(2000)).join('');
const cjkPieces = T.chunkForTranslate(cjkRun);
eq('2000 CJK with no terminator -> 3 pieces', cjkPieces.length, 3);
ok('each piece is within budget',
  cjkPieces.every(function (c) { return T.encodedLen(c) <= 8000; }),
  JSON.stringify(cjkPieces.map(function (c) { return T.encodedLen(c); })));
eq('the hard split loses nothing', cjkPieces.join(''), cjkRun);

section('code-point safety: surrogate pairs are never split');
const emoji = '\u{1F600}'.repeat(1000);
const emojiChunks = T.chunkForTranslate(emoji);
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

section('TTS chunker: an exact port of the desktop contract');
eq("'a' x 150 -> 1 chunk of 150", T.chunkForTts('a'.repeat(150)).map(function (c) { return c.length; }), [150]);
const threeSentences = ('a'.repeat(49) + '.').repeat(3);
eq('3 sentences of 50 chars -> 1 chunk of 150',
  T.chunkForTts(threeSentences).map(function (c) { return c.length; }), [150]);
const fiveSentences = ('b'.repeat(49) + '.').repeat(5);
eq('5 sentences of 50 chars -> EXACTLY [200, 50]',
  T.chunkForTts(fiveSentences).map(function (c) { return c.length; }), [200, 50]);
eq('the [200, 50] chunks reassemble to the whole input', T.chunkForTts(fiveSentences).join(''), fiveSentences);
eq("'a' x 250 as a single sentence -> null (browser-speech fallback)", T.chunkForTts('a'.repeat(250)), null);
ok('a single sentence of 201 unpunctuated CJK chars also returns null',
  T.chunkForTts('語'.repeat(201)) === null);
eq("'a' x 200 is the last single-sentence size that is not null", T.chunkForTts('a'.repeat(200)).length, 1);

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
   settings defaults use it, and loadSettings() prefers a stored target. */
eq('DEFAULT_TARGET is the target derived from the browser language',
  T.DEFAULT_TARGET, T.defaultTargetFor(T.BROWSER_LANG, T.TARGET_LOCALES));
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

section('TTS remainder on partial playback failure (injectable audio backend)');

/* HARNESS GUARD. A stub whose speak() never fires onend leaves an await
   unsettled; node then drains its event loop and exits 0 with no summary,
   which reads as success. This timer makes that impossible: if finish() has
   not run within 20s, record a failure and finish anyway. unref() keeps the
   timer itself from holding the process open. */
const harnessFailsafe = setTimeout(function () {
  failures.push('harness did not complete (an await never settled)');
  finish();
}, 20000);
if (harnessFailsafe && typeof harnessFailsafe.unref === 'function') harnessFailsafe.unref();

/* unref() means the timer will not hold the process open, so on a true hang it
   never fires — the event loop drains and node exits. This guard closes that
   gap: the harness can never exit 0 without having printed the summary. */
process.on('exit', function (code) {
  if (finished) return;
  process.stderr.write('\nFAIL: the harness exited before finish() ran' +
    ' (an await never settled); ' + checks + ' checks, ' + failures.length + ' failures\n');
  if (code === 0) process.exitCode = 1;
});

(async function runRemainderFixture() {
  const sentences = [];
  for (let i = 0; i < 13; i++) {
    const tag = ('[' + i + ']').padEnd(48, '.');
    sentences.push(tag + '.');
  }
  const text = sentences.join('');                       /* 13 x 50 = 650 chars */
  const parts = T.chunkForTts(text);
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
  eq('the remainder is chunks 3 and 4 joined by the target rule',
    outcome.remainder, T.joinTranslated(parts.slice(2), 'zh_CN'));
  ok('the remainder is never the full text', outcome.remainder !== text,
    'the remainder must not replay the chunk that already played');
  ok('the remainder does not include the chunk that played',
    outcome.remainder.indexOf(parts[0]) === -1);
  report('remainder join (zh_CN, no separator)', JSON.stringify(outcome.remainder.slice(0, 24)) + '...');

  /* Same failure with a spaced language must join with a space. */
  const spacedRun = makeBackend(1);
  const spaced = await T.speakGoogle(text, 'de_DE', 1.0, { backend: spacedRun.backend });
  eq('the remainder uses the space join for a spaced target',
    spaced.remainder, T.joinTranslated(parts.slice(2), 'de_DE'));

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

  /* An unsplittable input must say so rather than silently truncating. */
  const unsplittableRun = makeBackend(-1);
  eq("'a' x 250 is unsplittable for Google TTS",
    (await T.speakGoogle('a'.repeat(250), 'de_DE', 1.0, { backend: unsplittableRun.backend })).mode, 'unsplittable');

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
    created.push(this);
  }
  Object.defineProperty(FakeAudio.prototype, 'src', {
    get: function () { return this._src; },
    set: function (v) { this._src = v; this.referrerPolicyAtSrc = this.referrerPolicy; }
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
  clearTimeout(harnessFailsafe);
  if (failures.length) {
    process.stderr.write('\n' + failures.length + ' of ' + checks + ' checks FAILED:\n');
    for (const f of failures) process.stderr.write('  FAIL  ' + f + '\n');
    process.exit(1);
  }
  process.stdout.write('\nPASS  ' + checks + ' checks, 0 failures\n');
  process.exit(0);
}
