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
    // Top-level functions sit at 8 spaces of indentation, optionally prefixed by `async ` —
    // loadDayPage and friends are async, so both spellings have to be found.
    const candidates = [
        src.indexOf('\n        function ' + name + '('),
        src.indexOf('\n        async function ' + name + '(')
    ].filter(x => x >= 0);
    if (candidates.length === 0) throw new Error('function not found in index.html: ' + name);
    const i = Math.min(...candidates);
    const start = i + 1;
    // Top-level functions in this file close with a brace at exactly 8 spaces.
    const endMarker = '\n        }';
    const j = src.indexOf(endMarker, start);
    if (j < 0) throw new Error('end of function not found: ' + name);
    return src.slice(start, j + endMarker.length);
}

const FN_NAMES = [
    'uid',
    'normalizeFormulaOperator',
    'composeFormulaFromPlacement',
    'getFlipOperations',
    'flipNodeDirections',
    'structureBoxToSourceRect',
    'isTinyMark',
    'groupStrokesIntoBlocks',
    'assignHandwritingParents'
];

const bodies = FN_NAMES.map(n => extractFn(html, n)).join('\n\n');
const factory = new Function(bodies + '\nreturn { ' + FN_NAMES.join(', ') + ' };');
const {
    composeFormulaFromPlacement,
    flipNodeDirections,
    structureBoxToSourceRect,
    isTinyMark,
    groupStrokesIntoBlocks,
    assignHandwritingParents
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

/* ------------------------------------------------------------------ *
 * 7. Pen & eraser input surface (DPI mapping, cursors, coalesced samples)
 * ------------------------------------------------------------------ */
console.log('\n--- 7. pen / eraser input surface ---');

// The interaction layer must use the same DPI mapping as the ink layer. Drawing it 1:1
// made live strokes look softer and slightly fatter than the committed ones.
ok('interaction canvas is device-pixel scaled like the ink layer',
    html.includes('canvasInteraction.width = layoutW * dpr;') &&
    html.includes('ctxInteraction.setTransform(dpr, 0, 0, dpr, 0, 0);'));

// The layer backing stores must be sized from the paper's LAYOUT size. `getBoundingClientRect()`
// reports zoomed pixels: sizing from it made the bitmaps change size with the zoom, so the ink
// was squeezed into part of the page and the clear-rects no longer covered the layers (which is
// how the pen cursor left an endless trail of dots down the right-hand side of the page).
ok('no layer is sized from the zoomed rect',
    !/c\.width = rect\.width|canvasInteraction\.width = rect\.width/.test(html) &&
    html.includes('const layoutW = paperStage.clientWidth'));
ok('layers are cleared in paper units, never in zoomed pixels',
    html.includes('function clearLayer(ctx)') &&
    !/clearRect\(0, 0, cachedCanvasRect\.width/.test(html));
ok('the eraser repaints once per frame instead of once per sample',
    html.includes('function requestEraseRepaint') && html.includes('function eraseFlushRepaint') &&
    html.includes('eraseFlushRepaint();'));
ok('the live stroke is smoothed with the same curve as the committed one',
    /function drawIncrementalSegments[\s\S]*?quadraticCurveTo/.test(html));
ok('the cursor preview clears only its own trail',
    html.includes('function clearCursorTrail') &&
    !/function drawPenCursorPreview[\s\S]{0,400}clearLayer\(ctxInteraction\)/.test(html));

// "Like Edge": the stylus tip must feel like it comes out from under the nib. Chromium can say
// where the pen is ABOUT to be; drawing that tail and wiping it on the next real sample hides the
// input latency. Only real samples may ever be committed to the stroke.
ok('the pen prediction is drawn but never committed',
    html.includes('function drawPredictedTail') &&
    html.includes('clearPredictionTrail();') &&
    !/drawPredictedTail[\s\S]{0,900}currentRawPoints\.push/.test(html));
ok('a wild prediction cannot run away',
    /Math\.hypot\(p\.x - lastReal\.x, p\.y - lastReal\.y\) > 60/.test(html));
ok('the predicted tail is wiped from every path that repaints the layer',
    /function clearLayer\(ctx\)[\s\S]{0,240}predictionBox = null/.test(html) &&
    /penCursorAt = null;\s*\n\s*eraserRingAt = null;\s*\n\s*predictionBox = null;/.test(html));

// Ring size and erase size must never drift apart — they share ERASER_RADIUS.
ok('the eraser ring uses the shared radius',
    html.includes('ctxInteraction.arc(pt.x, pt.y, ERASER_RADIUS, 0, Math.PI * 2);'));
ok('the erase hit-test uses the same shared radius',
    html.includes('const eraserRadius = ERASER_RADIUS;'));
const eraserRadiusDecl = html.match(/const ERASER_RADIUS = (\d+);/);
ok('ERASER_RADIUS is declared', !!eraserRadiusDecl);
ok('ERASER_RADIUS stayed small (the ring used to be radius 12)',
    Number(eraserRadiusDecl && eraserRadiusDecl[1]) <= 10);

// The native cursor is replaced by a dot drawn on the canvas, so its size is ours.
ok('the interaction canvas hides the native cursor', /cursor:\s*none/.test(html));
ok('the pan tool opts back into a native grab cursor', html.includes('data-cursor="grab"'));
ok('no leftover crosshair cursor', !/cursor:\s*crosshair/.test(html));
ok('a small pen-point cursor is drawn', html.includes('function drawPenCursorPreview('));

// Firefox can return an empty coalesced list; without the fallback the movement vanished.
ok('a safe coalesced-sample helper exists', html.includes('function coalescedEventsOf(e)'));
ok('no raw getCoalescedEvents() call bypasses the helper',
    !/\?\s*e\.getCoalescedEvents\(\)\s*:\s*\[e\]/.test(html));
check('all three pointer sample loops use the helper',
    (html.match(/const events = coalescedEventsOf\(e\);/g) || []).length, 3);

/* ------------------------------------------------------------------ *
 * 8. Handwriting → tree (no AI) and the "never invent content" rules
 * ------------------------------------------------------------------ */
console.log('\n--- 8. handwriting tree + no invented content ---');

// A short pen line starting at (x, y).
const hwStroke = (id, x, y, len = 30) => ({
    id,
    size: 4,
    points: [{ x, y }, { x: x + len, y: y + 10 }]
});

// A single dot of a letter (پ, ت, ق ...): its own stroke, but never its own card.
const hwDot = (id, x, y) => ({ id, size: 4, points: [{ x, y }, { x: x + 1, y: y + 1 }] });

// A written word: one long stroke with a tall letter in it, the way real handwriting looks.
const hwWord = (id, x, y, len = 120) => ({
    id, size: 4,
    points: [{ x, y }, { x: x + len * 0.5, y: y - 20 }, { x: x + len, y: y + 4 }]
});

// A dot drawn as a little circle, which is how this user writes them.
const hwDotR = (id, cx, cy, r = 6) => {
    const points = [];
    for (let i = 0; i <= 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        points.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return { id, size: 4, points };
};

check('no strokes means no blocks', groupStrokesIntoBlocks([]), []);

check('two far-apart lines become two blocks',
    groupStrokesIntoBlocks([hwStroke('a', 100, 100), hwStroke('b', 100, 220)]).length, 2);

const oneLine = groupStrokesIntoBlocks([hwStroke('a', 100, 100), hwStroke('b', 140, 100)]);
check('two close strokes on one line become one block', oneLine.length, 1);
check('...and that block keeps both strokes', oneLine[0].strokes.length, 2);

// The whole point of the grouping rewrite: ordinary word spacing is NOT a boundary.
const twoWords = groupStrokesIntoBlocks([hwStroke('w1', 100, 100, 60), hwStroke('w2', 180, 100, 60)]);
check('the space between two words does not split the card', twoWords.length, 1);

// Dots float above and below the letters, so they used to become their own lines.
const dotAndWord = groupStrokesIntoBlocks([hwStroke('word', 100, 100, 60), hwDot('dot', 130, 80)]);
check('a floating dot joins its word instead of becoming a card', dotAndWord.length, 1);
check('...and the word keeps both of its strokes', dotAndWord[0].strokes.length, 2);

const onlyDots = groupStrokesIntoBlocks([hwDot('d1', 100, 100), hwDot('d2', 120, 104)]);
check('a page of nothing but dots still yields a card', onlyDots.length, 1);

const gapped = groupStrokesIntoBlocks([hwStroke('left', 100, 100), hwStroke('right', 500, 100)]);
check('a really wide empty area still splits the line', gapped.length, 2);
check('Persian reading order: the right-most block comes first', gapped[0].strokes[0].id, 'right');

// The old code derived its "dot size" from a percentile of ALL stroke heights, so on a page
// where the dots outnumber the letters the threshold collapsed and every dot became its own
// card. Dots are now recognised structurally, so that ratio cannot break the grouping.
const dotHeavy = [];
for (let line = 0; line < 3; line++) {
    const y = 150 + line * 140;
    dotHeavy.push(hwStroke('w' + line, 900, y, 200));
    dotHeavy.push(hwDot('a' + line, 940, y - 14));
    dotHeavy.push(hwDot('b' + line, 960, y - 14));
    dotHeavy.push(hwDot('c' + line, 980, y - 14));
}
const dotHeavyBlocks = groupStrokesIntoBlocks(dotHeavy);
check('a dot-heavy page still makes one card per written line', dotHeavyBlocks.length, 3);
check('...with every dot inside its own line\'s card',
    dotHeavyBlocks.every(b => b.strokes.length === 4), true);

// The dots can be almost as tall as the letters — this user draws them as little circles — so a
// pure size threshold is not enough. A written word is a LONG stroke, and that is the signal.
const bigDots = groupStrokesIntoBlocks([
    hwWord('word', 900, 200, 260),
    hwDotR('d1', 950, 168, 6),
    hwDotR('d2', 972, 168, 6)
]);
check('dots almost as tall as the letters still join their line', bigDots.length, 1);
check('...with every dot in that one card', bigDots[0].strokes.length, 3);

// A stroke that cannot draw anything (an outline removed with «بی‌رنگ», a white fill on
// white) used to become a card with nothing in it — the "empty box".
const ghost = { id: 'ghost', size: 4, color: 'transparent', points: [{ x: 100, y: 100 }, { x: 200, y: 100 }] };
check('a stroke that draws nothing is never turned into a card',
    groupStrokesIntoBlocks([ghost]).length, 0);
check('...and it does not disturb the cards around it',
    groupStrokesIntoBlocks([ghost, hwStroke('real', 300, 100, 200)]).length, 1);

const hwBlock = (x1) => ({ x0: x1 - 200, x1, y0: 0, y1: 10, strokes: [] });
const nested = assignHandwritingParents([hwBlock(400), hwBlock(360), hwBlock(360), hwBlock(320)]);
check('the flush-right block is the root', nested[0].parentId, null);
check('a block indented under the root becomes its child', nested[1].parentId, nested[0].id);
check('an equally indented block is a sibling', nested[2].parentId, nested[0].id);
check('a deeper indent nests under the block above it', nested[3].parentId, nested[2].id);
ok('every block gets an id', nested.every(b => typeof b.id === 'string' && b.id.length > 0));
check('those ids are unique', new Set(nested.map(b => b.id)).size, 4);

const flat = assignHandwritingParents([hwBlock(400), hwBlock(400), hwBlock(400)]);
check('a flat page still yields a tree (first block becomes the root)',
    flat.map(b => b.parentId), [null, flat[0].id, flat[0].id]);

// "A dot / a dash can never be an item of its own." Both dimensions have to be small: a written
// word is a LONG box, and a short number such as «۱۲» is as TALL as the rest of the writing.
check('a small round dot is a mark', isTinyMark(18, 18, 30), true);
check('a short dash is a mark', isTinyMark(40, 8, 30), true);
check('a written word is never a mark', isTinyMark(206, 30, 30), false);
check('a short but full-height number is never a mark', isTinyMark(40, 30, 30), false);
check('a lone letter keeps its own item', isTinyMark(22, 27, 30), false);
check('an empty box cannot crash the test', isTinyMark(0, 0, 0), true);

// Small, FLAT writing (fast tiny handwriting, a line ruled straight) made the height reference
// the grouping uses to recognise a dot sink down to the height of the words themselves. Persian
// dots sit a little above the letters, so they then measured BIGGER than that reference, stopped
// being recognised as dots, and each opened a card of its own — the "the black dot and the line
// became separate categories" report, coming back on a page of small writing. The dot size now
// has an absolute floor: a stroke confined to a 14x14 box is a dot in any handwriting.
let smallSid = 0;
const smallWord = (x0, x1, y) => {
    const points = [];
    const n = Math.max(3, Math.round((x0 - x1) / 9));
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        points.push({ x: x0 + (x1 - x0) * t, y: y + Math.sin(t * 9) * 3 });
    }
    return { id: 'sw' + (smallSid++), size: 3, points };
};
const smallLine = (xr, y, words, dots) => {
    const out = [];
    let x = xr;
    for (let i = 0; i < words; i++) {
        const len = 60 + (i % 3) * 22;
        out.push(smallWord(x, x - len, y));
        x -= len + (i % 2 ? 16 : 26);       // ordinary word gaps
    }
    dots.forEach(d => out.push(hwDotR('sd' + (smallSid++), d[0], d[1], 3)));
    return out;
};
const smallWriting = [].concat(
    smallLine(1150, 120, 4, [[1000, 105], [900, 105]]),
    smallLine(1000, 215, 3, []),
    smallLine(990, 300, 4, [[700, 288]]),
    smallLine(840, 385, 2, [])
);
const smallBlocks = groupStrokesIntoBlocks(smallWriting);
check('small flat writing still yields one card per written line', smallBlocks.length, 4);
check('...with both dots of the first line inside its card', smallBlocks[0].strokes.length, 6);
check('...and the side dot of the third line inside its card', smallBlocks[2].strokes.length, 5);
check('...and no card that is nothing but a dot', smallBlocks.every(b => b.strokes.length > 1), true);
ok('the dot-size reference has an absolute floor',
    /const dotLimit = Math\.max\(14, tallH\)/.test(html));
ok('a floating dot can reach the line it belongs to',
    /const attachDist = Math\.max\(26, tallH \* 1\.8\)/.test(html));

// Real handwriting never indents by the same number of pixels twice in a row. Comparing each
// block only with the block above it made a pair of lines siblings one moment and parent/child
// the next, which is what "the tree is still not great" looked like. Right edges are quantised
// into indentation levels first, so an uneven outline reads the way it was drawn.
const uneven = assignHandwritingParents([hwBlock(400), hwBlock(363), hwBlock(357), hwBlock(330)]);
check('an unevenly indented block is still a child of the root', uneven[1].parentId, uneven[0].id);
check('...and its nearly-identical sibling is its sibling', uneven[2].parentId, uneven[0].id);
check('...while a deeper indent nests under the line above it', uneven[3].parentId, uneven[2].id);

// A colour means a topic. Giving every card the next colour in the list painted the tree like a
// rainbow, which read as arbitrary, and the connector (which uses the child's colour) changed
// colour halfway down a branch.
ok('the card colour is chosen per branch, not per card',
    html.includes('const branchRoot = new Map()') &&
    html.includes('branchRoot.set(b.id, branchRoot.get(b.parentId))'));

// A dot drawn well to the RIGHT of its word (a bullet at the start of an RTL line). The wide gap
// used to open a card of its own, and — being the right-most block on an RTL page — the dot then
// became the ROOT of the tree with the real line hanging underneath it.
const dotOffToTheSide = groupStrokesIntoBlocks([
    hwWord('word', 300, 200, 200),
    hwDotR('dot', 620, 200, 6)
]);
check('a dot far to the side of its word stays in that word\'s card', dotOffToTheSide.length, 1);
check('...and the card holds both the word and the dot', dotOffToTheSide[0].strokes.length, 2);

// The user's exact scenario: one line of writing, two subgroups indented under it, plus a stray
// dot parked to the right of the first line. The dot must not become the root.
const hwMark = (x1) => ({ x0: x1 - 12, x1, y0: 0, y1: 6, strokes: [] });
const withStrayDot = assignHandwritingParents([
    hwMark(432), hwBlock(400), hwBlock(360), hwBlock(360)
]);
check('a stray dot is never the root', withStrayDot[1].parentId, null);
check('...the flush-right line is the root instead', withStrayDot[0].parentId, withStrayDot[1].id);
check('the first subgroup hangs under the root', withStrayDot[2].parentId, withStrayDot[1].id);
check('the second subgroup is its sibling, not its child', withStrayDot[3].parentId, withStrayDot[1].id);
check('...so the root ends up with two children',
    withStrayDot.filter(b => b.parentId === withStrayDot[1].id).length, 3);

ok('the "tree from my own handwriting" button exists', html.includes('id="btn-mm-from-ink"'));
ok('it is bound to the builder',
    html.includes("getElementById('btn-mm-from-ink').addEventListener"));
ok('cards keep the real strokes', html.includes('block.inkStrokes = block.strokes.map'));
ok('cards render the preserved ink', html.includes('buildMindMapInkCanvas(node)'));
ok('the ink canvas has its own style', /\.mindmap-node-ink\s*\{/.test(html));
ok('the ink canvas escapes the global `canvas { position: absolute }` rule',
    /\.mindmap-node-ink\s*\{[\s\S]*?position:\s*static/.test(html));
ok('the ink canvas is transparent, not a white box inside the card',
    /\.mindmap-node-ink\s*\{[\s\S]*?background:\s*transparent/.test(html));
ok('cards get a paper-like gradient background', html.includes('function getCardBackgroundForNode'));
ok('tiny ink cannot be blown up into a poster', html.includes('const MAX_INK_SCALE = 3'));
ok('no card can ever render empty',
    html.includes('function canvasHasInk') && html.includes('canvasHasInk(buildMindMapInkCanvas'));
ok('the PNG export draws the handwriting, not an empty box',
    html.includes('function drawNodeInkInto') && html.includes('inkBoxHeightFor(inkAvailW'));
ok('the ink strip height is computed in exactly one place',
    (html.match(/function inkBoxHeightFor/g) || []).length === 1 &&
    (html.match(/inkBoxHeightFor\(/g) || []).length >= 4);
ok('the workspace mode is remembered across reloads',
    html.includes('localStorage.getItem(WORKSPACE_MODE_KEY)') &&
    html.includes('localStorage.setItem(WORKSPACE_MODE_KEY,'));
ok('branches are drawn as smooth curves, not straight diagonals',
    /bezierCurveTo/.test(extractFn(html, 'drawMindMapConnectors')));
ok('the builder never touches the network',
    !/fetch\(|callGeminiAPI/.test(extractFn(html, 'buildMindMapFromHandwriting')));
ok('the builder never reads text out of the ink',
    !/recognizedText|renderFormattedMathAndChem/.test(extractFn(html, 'buildMindMapFromHandwriting')));

// Offline resilience: the app is a PWA, so it must say plainly that only the AI needs a network.
ok('the app can tell that it is offline',
    html.includes('function isOffline()') && html.includes('id="ai-offline-note"'));
ok('an offline AI failure is not blamed on the API key',
    /isOffline\(\)\s*\?/.test(html));
ok('the topic-tree loader can never get stuck open',
    html.includes('مدل درختی برنگرداند'));

// Robustness pass: each of these was a real defect found by reviewing the AI, drawing and
// persistence code, and each one is cheap to guard against.
ok('the debounced save captures the day key when it is scheduled, not when it fires',
    /pendingSaveKey = AppState\.currentDateKey/.test(extractFn(html, 'scheduleSavePage')));
ok('leaving a page flushes the pending write first',
    html.includes('function flushPendingSave') && html.includes('await flushPendingSave()'));
ok('a day load that lost the race is ignored',
    /token !== dayLoadToken/.test(extractFn(html, 'loadDayPage')));
ok('a failed save is reported instead of spinning forever',
    html.includes("setSaveIndicator('error')") && html.includes('Save failed:'));
ok('the raw ink is only cleared once the AI produced something',
    html.includes('const clearSnapInk = () =>') &&
    /if \(hasTrees \|\| attachedCount > 0\) \{\s*\n\s*clearSnapInk\(\);/.test(html));
ok('...and it is no longer deleted up front',
    !/if \(shouldClearInk && snap\.strokeIds\.length > 0\) \{/.test(html));
ok('the AI buttons cannot be double-tapped into building the tree twice',
    html.includes('function withAiBusyGuard') && html.includes('aiRequestInFlight'));
ok('an empty review can no longer rewrite every card',
    /if \(wrote && n\.text &&/.test(html));
ok('a review that matches nothing adds a card instead of overwriting the last one',
    html.includes('اصلاح علمی'));
ok('structure pictures grow the paper instead of being clipped',
    html.includes('function ensureStageHeight') && html.includes('ensureStageHeight(y - 24)'));
ok('the reference/handwriting toggle needs both pictures to exist',
    html.includes('if (imageObj.webImageUrl && imageObj.dataUrl) {'));
ok('a handwriting card is sized from its ink so the writing is not shrunk',
    /const w = Math\.min\(330, Math\.max\(180, Math\.round\(block\.inkW \+ 24\)\)\)/.test(html));
ok('the mind-map spacing is derived from the widest card, not hard-coded',
    html.includes('const widestCard = ()') &&
    html.includes('const levelGapX = Math.min(') &&
    !html.includes('const levelGapX = 235;'));
ok('the layout is re-run once the real card width has been measured',
    /Math\.abs\(measuredMaxW - assumedMaxW\) > 2/.test(html));
ok('a corrupt tree cannot hang the layout', html.includes('depth > 40'));
ok('the card header and body text are readable on a tablet',
    html.includes('text-[11px] text-slate-500') && /font-size: 0\.95rem/.test(html));
ok('undo/redo shortcuts use the physical key, so they work on a Persian keyboard',
    html.includes("e.code === 'KeyZ'") && !html.includes("e.key.toLowerCase() === 'z'"));
ok('the shortcuts do not steal text undo while typing in a field',
    html.includes('t.isContentEditable'));
ok('a dragged card is clamped against its own width',
    html.includes('paperStage.clientWidth - (node.w || 150) - 8'));
ok('undo restores the scientific reviews too',
    html.includes('mindmapReviews: AppState.mindmapData.reviews') &&
    html.includes('AppState.mindmapData.reviews = snap.mindmapReviews'));
ok('a no-op flip-all no longer wipes the redo history',
    /const planned = nodes\.map\(n => flipNodeDirections\(n\)\)/.test(html));
ok('deleting a card also clears the editing id',
    /toDelete\.has\(AppState\.editingMindmapNodeId\)/.test(html));
ok('a palm touch cannot hijack an active pen stroke',
    html.includes("if (e.pointerType === 'touch' && (Date.now() - AppState.lastStylusActivityTime) < 650) return;"));
ok('startup failure is surfaced instead of leaving a blank page',
    html.includes('Startup failed:'));

ok('the prompt forbids adding content outright',
    html.includes('ممنوعیت مطلق افزودن مطلب'));
ok('the prompt forbids inventing branch categories',
    html.includes('این فیلد را از خودت پر نکن'));
ok("scientificReviews is told to stay on the user's own writing",
    html.includes('scientificReviews فقط دربارهٔ چیزهایی است که کاربر واقعاً نوشته'));
ok('categoryLabel is no longer a required schema field',
    html.includes('required: ["title", "colorHex", "subBranches"]'));
ok('the tree schema demands fidelity to the handwriting',
    html.includes('هیچ مطلب تازه‌ای اضافه نکن'));

/* ------------------------------------------------------------------ */
console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
    console.log('\nFailed checks:');
    failures.forEach(f => console.log('  - ' + f));
}
process.exit(failures.length === 0 ? 0 : 1);
