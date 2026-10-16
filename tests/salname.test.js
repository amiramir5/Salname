/*
 * Salname test suite — runs with plain Node, no dependencies:
 *     node tests/salname.test.js
 *
 * The pure-logic tests extract the REAL functions out of index.html (never a copy),
 * so a test failure always means the shipped app is wrong, not a stale duplicate.
 * The last two sections are integrity checks on the offline/PWA setup.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const SW = path.join(ROOT, 'sw.js');
const MANIFEST = path.join(ROOT, 'manifest.webmanifest');

const html = fs.readFileSync(INDEX, 'utf8');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
    const same = actual === expected || JSON.stringify(actual) === JSON.stringify(expected);
    if (same) {
        pass++;
        console.log('PASS  ' + label);
    } else {
        failures.push(label);
        console.log('FAIL  ' + label);
        console.log('        expected: ' + JSON.stringify(expected));
        console.log('        actual:   ' + JSON.stringify(actual));
    }
}
function ok(label, condition) {
    check(label, !!condition, true);
}

/* ------------------------------------------------------------------ *
 * Extract real functions from index.html
 * ------------------------------------------------------------------ */
function extractFn(src, name) {
    const marker = '\n        function ' + name + '(';
    const i = src.indexOf(marker);
    if (i < 0) throw new Error('function not found in index.html: ' + name);
    const start = i + 1;
    // Top-level functions in this file close with a brace at exactly 8 spaces.
    const endMarker = '\n        }';
    const j = src.indexOf(endMarker, start);
    if (j < 0) throw new Error('end of function not found: ' + name);
    return src.slice(start, j + endMarker.length);
}

const FN_NAMES = [
    'normalizeFormulaOperator',
    'composeFormulaFromPlacement',
    'getFlipOperations',
    'flipNodeDirections',
    'structureBoxToSourceRect'
];

const bodies = FN_NAMES.map(n => extractFn(html, n)).join('\n\n');
const factory = new Function(bodies + '\nreturn { ' + FN_NAMES.join(', ') + ' };');
const {
    composeFormulaFromPlacement,
    flipNodeDirections,
    structureBoxToSourceRect
} = factory();

/* ------------------------------------------------------------------ *
 * 0. The inline JavaScript in index.html must at least parse
 * ------------------------------------------------------------------ */
console.log('--- 0. index.html inline JavaScript ---');
const inlineBlocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok('index.html contains inline script blocks', inlineBlocks.length > 0);

let syntaxError = null;
try {
    new vm.Script(inlineBlocks.join('\n;\n'), { filename: 'index.html:inline' });
} catch (e) {
    syntaxError = e.message;
}
check('inline JavaScript parses without a syntax error', syntaxError, null);

/* ------------------------------------------------------------------ *
 * 1. Formula operand order comes from SPATIAL POSITION, not from the model's guess
 * ------------------------------------------------------------------ */
console.log('--- 1. composeFormulaFromPlacement (right/left operand order) ---');
check('fraction minus: right=C_3H_2, left=استر',
    composeFormulaFromPlacement({ rightOperand: 'C_3H_2', operator: '\u2212', leftOperand: 'استر', denominator: '3' }),
    '\\frac{C_3H_2 - استر}{3}');

check('equality: right=fraction, left=اسید چرب',
    composeFormulaFromPlacement({ rightOperand: '\\frac{X}{2}', operator: '=', leftOperand: 'اسید چرب' }),
    '\\frac{X}{2} = اسید چرب');

check('reaction arrow',
    composeFormulaFromPlacement({ rightOperand: 'B', operator: '\u2192', leftOperand: 'A' }),
    'B \u2192 A');

check('missing left operand -> null', composeFormulaFromPlacement({ rightOperand: 'A', operator: '\u2212' }), null);
check('null placement -> null', composeFormulaFromPlacement(null), null);
check('unknown operator -> null (never corrupts a plain node)',
    composeFormulaFromPlacement({ rightOperand: 'A', operator: 'ابر', leftOperand: 'B' }), null);
check('no denominator -> plain expression',
    composeFormulaFromPlacement({ rightOperand: 'A', operator: '\u2212', leftOperand: 'B' }), 'A - B');

/* ------------------------------------------------------------------ *
 * 2. The flip button must always change something (no dead clicks)
 * ------------------------------------------------------------------ */
console.log('\n--- 2. flipNodeDirections ---');
const original = '\\frac{C_3H_2 - استر}{3} = اسید چرب';
const node = { text: original };
const seen = [];
for (let i = 0; i < 4; i++) {
    node.text = flipNodeDirections(node);
    seen.push(node.text);
}
seen.forEach((s, i) => console.log('  state ' + (i + 1) + ': ' + s));
check('4 distinct states reachable', new Set(seen).size, 4);
check('no dead click — every click changes the text',
    seen.filter((s, i) => s !== (i === 0 ? original : seen[i - 1])).length, 4);
check('cycle returns to the original after 4 clicks', seen[3], original);

check('plain subtraction swaps sides',
    flipNodeDirections({ text: 'C_3H_2 - استر' }), 'استر - C_3H_2');
check('unflippable text is left untouched',
    flipNodeDirections({ text: 'نکته درسی' }), 'نکته درسی');
check('chemical hyphens are not treated as minus',
    flipNodeDirections({ text: 'CH_3-C(=O)-CH_3' }), 'CH_3-C(=O)-CH_3');

/* ------------------------------------------------------------------ *
 * 3. Structure crop box (x is measured from the RIGHT edge — RTL)
 * ------------------------------------------------------------------ */
console.log('\n--- 3. structureBoxToSourceRect ---');
const snap = { cropW: 1000, cropH: 1000 };

check('full box -> whole picture',
    structureBoxToSourceRect(snap, { xmin: 0, ymin: 0, xmax: 1000, ymax: 1000 }),
    { sx: 0, sy: 0, sw: 1000, sh: 1000 });

const rightSide = structureBoxToSourceRect(snap, { xmin: 0, ymin: 0, xmax: 500, ymax: 1000 });
ok('right-edge box maps to the right half', rightSide.sx > 400 && rightSide.sw <= 600);

const leftSide = structureBoxToSourceRect(snap, { xmin: 500, ymin: 0, xmax: 1000, ymax: 1000 });
ok('left-edge box maps to the left half', leftSide.sx === 0 && leftSide.sw <= 600);

check('zero width -> null', structureBoxToSourceRect(snap, { xmin: 500, ymin: 0, xmax: 500, ymax: 1000 }), null);
check('missing field -> null', structureBoxToSourceRect(snap, { xmin: 0, ymin: 0, xmax: 1000 }), null);
check('non-numeric -> null', structureBoxToSourceRect(snap, { xmin: 'abc', ymin: 0, xmax: 1000, ymax: 1000 }), null);
check('null box -> null', structureBoxToSourceRect(snap, null), null);
check('out of range is clamped, never negative',
    structureBoxToSourceRect(snap, { xmin: -900, ymin: -900, xmax: 5000, ymax: 5000 }),
    { sx: 0, sy: 0, sw: 1000, sh: 1000 });

const tall = structureBoxToSourceRect(snap, { xmin: 0, ymin: 100, xmax: 1000, ymax: 200 });
ok('vertical box starts above ymin and covers past ymax',
    tall.sy < 100 && tall.sy >= 0 && (tall.sy + tall.sh) > 200);

// The crop must add a generous margin on ALL four sides, so a slightly-off box from
// the model never clips the drawing ("the right side of the Lewis picture was cut off").
const tight = structureBoxToSourceRect(snap, { xmin: 300, ymin: 300, xmax: 700, ymax: 700 });
ok('generous margin on all four sides',
    tight.sx < 300 && (tight.sx + tight.sw) > 700 &&
    tight.sy < 300 && (tight.sy + tight.sh) > 700);

/* ------------------------------------------------------------------ *
 * 4. Formula tokenizer — the bidi regression
 *
 * The tokenizer used to split "CO(NH_2)_2" into loose fragments ("CO(" ... ")2").
 * Inside a right-to-left paragraph those fragments got reordered, so a formula that
 * sat next to Persian text rendered completely reversed. Every formula below must be
 * matched as ONE token, which is what keeps it a single left-to-right isolate.
 * ------------------------------------------------------------------ */
console.log('\n--- 4. formula tokenizer matches whole formulas (bidi fix) ---');
const chemMatch = html.match(/const chemPattern = (\/.+\/g);/);
if (!chemMatch) throw new Error('chemPattern not found in index.html');
const chemPattern = new Function('return ' + chemMatch[1])();

function firstMatch(re, s) {
    re.lastIndex = 0;
    const m = re.exec(s);
    return m ? m[0] : null;
}

const wholeFormulas = [
    'CO(NH_2)_2', 'CO(NH2)2', '(NH2)2CO', 'Ca(OH)2', 'Al2(SO4)3', '(NH4)2SO4',
    'C6H12O6', 'CH3-C(=O)-CH3', '3H2O', 'C_8H_{18}', 'C_{57}H_{104}O_6',
    'KMnO4', 'Fe2(SO4)3', 'CH3CH2OH', 'H2SO4', 'Na2CO3', 'C6H5COOH'
];
wholeFormulas.forEach(f => {
    check('tokenizer keeps "' + f + '" as one token', firstMatch(chemPattern, f), f);
});

// ...and it must not swallow ordinary Persian prose
['سلام', 'نکته درسی', 'جمع و تفریق'].forEach(t => {
    check('tokenizer ignores plain text "' + t + '"', firstMatch(chemPattern, t), null);
});

/* ------------------------------------------------------------------ *
 * 5. Offline / PWA integrity
 *
 * sw.js precaches an explicit file list. If any entry is missing the whole install can
 * fail, and if an asset is forgotten the app breaks when there is no network — exactly
 * the scenario this section guards.
 * ------------------------------------------------------------------ */
console.log('\n--- 5. offline / PWA integrity ---');
const swSource = fs.readFileSync(SW, 'utf8');

function walk(dir, base) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? base + '/' + entry.name : entry.name;
        if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
        else out.push(rel);
    }
    return out;
}

const precacheBlock = swSource.match(/const PRECACHE = \[([\s\S]*?)\];/);
if (!precacheBlock) throw new Error('PRECACHE list not found in sw.js');
const precache = [...precacheBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

ok('sw.js precaches a sane number of files', precache.length > 20);

const precacheMissing = precache
    .map(u => u.replace(/^\.\//, ''))
    .filter(u => u && !fs.existsSync(path.join(ROOT, u)));
check('every PRECACHE entry exists on disk', precacheMissing, []);

const assetFiles = walk(path.join(ROOT, 'assets'), 'assets');
const notPrecached = assetFiles.filter(f => !precache.includes(f));
check('every file under assets/ is listed in PRECACHE', notPrecached, []);

ok('sw.js has a CACHE_VERSION to bump', /const CACHE_VERSION = '/.test(swSource));
ok('sw.js falls back to the cache when the network answers with an error',
    swSource.includes('captive portal'));
ok('sw.js serves navigations network-first', swSource.includes("req.mode === 'navigate'"));

/* ------------------------------------------------------------------ *
 * 6. No CDN left, and every local reference resolves
 * ------------------------------------------------------------------ */
console.log('\n--- 6. local assets + manifest ---');
ok('index.html registers the service worker', html.includes("register('sw.js')"));
ok('index.html links the manifest', html.includes('rel="manifest"'));
ok('index.html has no Tailwind CDN', !html.includes('cdn.tailwindcss.com'));
ok('index.html has no cdnjs / jsdelivr dependency',
    !/(?:src|href)="https?:\/\/(?:cdnjs\.cloudflare|cdn\.jsdelivr)/.test(html));

const localRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(m => m[1])
    .filter(u => !/^(?:https?:|#|data:|mailto:|blob:|javascript:|\/\/)/.test(u));
ok('index.html references local files at all', localRefs.length > 0);
const brokenRefs = localRefs.filter(u => !fs.existsSync(path.join(ROOT, u.split('?')[0])));
check('every local file referenced by index.html exists', brokenRefs, []);

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
check('manifest language', manifest.lang, 'fa');
check('manifest direction', manifest.dir, 'rtl');
ok('manifest has a 192px icon', manifest.icons.some(i => i.sizes === '192x192'));
ok('manifest has a 512px icon', manifest.icons.some(i => i.sizes === '512x512'));
ok('manifest has a maskable icon', manifest.icons.some(i => (i.purpose || '').includes('maskable')));
manifest.icons.forEach(icon => {
    ok('manifest icon exists: ' + icon.src, fs.existsSync(path.join(ROOT, icon.src)));
});

/* ------------------------------------------------------------------ */
console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
    console.log('\nFailed checks:');
    failures.forEach(f => console.log('  - ' + f));
}
process.exit(failures.length === 0 ? 0 : 1);
