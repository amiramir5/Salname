# Stylus latency brief — Salname (single-file canvas notebook)

Written for an outside engineer/AI to diagnose. Everything below is measured or read from the
code, not guessed. Repository: <https://github.com/amiramir5/Salname> (public, `main`).

## The problem

A Persian planner/notebook web app, used on a **tablet with an active stylus**, in **Edge
(Chromium)**. Everything works, but **writing feels laggy compared to Microsoft Edge's own ink**
(the user's reference). It has survived many rounds of JavaScript optimisation and is still
"very slow". The app is installed as a PWA from GitHub Pages.

Constraint: offline-first, single `index.html` (~7,800 lines: markup + CSS + JS), no CDN, no
bundler at runtime, must keep working when the network is cut.

## Rendering architecture

All layers live inside `#canvas-viewport` (`overflow:auto; touch-action:none;
-webkit-overflow-scrolling:touch; padding:18px 16px`) and are absolutely positioned inside
`#paper-stage` (`width:1450px; min-width:100%; height:1950px; box-shadow: 0 1px 2px rgba(15,23,42,.05),
0 14px 44px rgba(15,23,42,.10)` and a CSS repeating-gradient "lined paper" background,
`background-size:100% 32px`).

Four stacked `<canvas>` elements, all `width:100%; height:100%`:

| layer | id | context | notes |
|---|---|---|---|
| PDF backdrop | `#canvas-pdf` | 2d | retired to 1×1 + `display:none` while no PDF is loaded |
| highlighter | `#canvas-highlighter` | 2d | inline `opacity: 0.38`, `pointer-events:none` |
| committed ink | `#canvas-ink` | 2d | `pointer-events:none` |
| live stroke + cursor | `#canvas-interaction` | `getContext('2d', { desynchronized: true })` | `cursor:none`, captures pointer |

Backing store = CSS layout size × `dpr`, with
`dpr = min(max(devicePixelRatio, 1), qualityCap)` and `qualityCap = AppState.penQuality === 'smooth' ? 1 : 2`
(`penQuality` defaults to `'max'`).

**At devicePixelRatio 2: each page-sized layer is 2900 × 3900 ≈ 11.3 Mpx ≈ 45 MB of RGBA.**
With PDF retired that is 3 live layers ≈ 135 MB of canvas texture, plus the paper's shadow and
gradient raster, in a scrolling container.

Zoom: CSS `zoom` on `#paper-stage` (deliberately not `transform: scale()` — layout size must
change), set back to `''` at exactly 100%.

## Input pipeline (pen)

1. `pointerdown` on `#canvas-interaction` → `setPointerCapture`, `AppState.isDrawing = true`.
2. Both `pointerrawupdate` (Chromium-only; preferred) and `pointermove` are listened to.
   `pointermove` returns early when a raw update already handled the gesture. Samples are
   expanded with `e.getCoalescedEvents()`.
3. Per sample (synchronously, inside the event handler):
   - `getCanvasPoint(e)` → paper coordinates (uses a cached `getBoundingClientRect`, refreshed
     on scroll/resize — no layout read per sample);
   - push into `AppState.currentRawPoints`;
   - `drawIncrementalSegments(prevIdx)` — draws **only the new** midpoint-quadratic segments
     straight onto the desynchronized interaction canvas (no per-sample full-canvas clear);
   - `drawPredictedTail(e)` — up to 3 `getPredictedEvents()` points, max 60 paper px ahead,
     drawn into a small box that is cleared on the next real sample and never committed.
4. `pointerup` → `pushUndoState()` (deep clone, see below) → `InkBeautifier.beautify()`
   (simplify + smooth) → render **just the one new stroke** onto `#canvas-ink` → clear the
   interaction layer → debounced save (180 ms). **No full-page repaint on pen-up.**

Eraser: repaints only the changed rectangle, coalesced to one repaint per animation frame, with a
full repaint on `pointerup` as the authoritative pass (verified pixel-identical or
anti-aliasing-only vs a full repaint).

## What has already been fixed / measured (do not re-propose these)

| change | measurement |
|---|---|
| Fast Undo clone (`cloneStrokesInto`/`cloneFlatInto`) replacing `JSON.parse(JSON.stringify(...))` on pen-up | ~6 ms → ~0.7 ms for a 120-stroke page; output byte-identical, genuinely deep |
| Low-latency interaction canvas (`desynchronized: true`) | already in place |
| `pointerrawupdate` + `getCoalescedEvents` | already in place |
| Predicted tail (`getPredictedEvents`) | already in place |
| Incremental segment drawing (no full-canvas clear per sample) | already in place |
| `CSS zoom` instead of `transform` | already in place |
| `dpr` cap (2, or 1 in «smooth») | already in place |
| PDF layer retired while unused | removes one 45 MB texture at dpr 2 |
| Eraser: region repaint + one repaint per frame | 50 erase samples ≈ 0.4 ms of JS; region vs full repaint = 0 differing pixels (pen/partial), ≤27/255 on stroke fringes elsewhere |
| Minimal pen cursor (hairline ring, clears only its own trail) | already in place |

A Chromium trace of the desktop harness shows: **0 dropped frames, ≈0.011 ms JS per sample,
Commit ≤ 0.2 ms, Paint/RasterTask ≈ 0**. A full repaint of a 9-element page ≈ 0.8 ms. So the
remainder is almost certainly **below the JavaScript layer**.

The app now contains an on-device latency meter (header gauge button): input latency
p50/p90/p99, frame rate, dropped frames (counted only while the pen is on the page), raw vs
`pointermove` sample counts, prediction hit-rate, and the real bitmap budget, plus a one-tap
«روانتر (سبکتر)» that switches `dpr` to 1.

## Open hypotheses (ranked)

- **H1 — compositor / GPU texture budget.** 3 × 45 MB page-sized layers + a 44 px-blur shadow +
  a full-page gradient raster on a tablet GPU may cause software rasterisation or memory
  thrashing. Prediction: «روانتر» improves things dramatically and «فریم افتاده» is high.
- **H2 — the desynchronized canvas is not actually taking the low-latency path** on this device.
  Candidate causes: it lives inside an `overflow:auto` scroller; it is larger than the viewport
  (overlay-plane size limits); its CSS `opacity` is changed at runtime (the highlighter path sets
  `canvasInteraction.style.opacity = '0.38'`).
- **H3 — tile rasterisation cost.** A 2900×3900 layer is many tiles; each sample dirties tiles
  whose raster cost on the tablet may dominate.
- **H4 — the scrolling container** forces an extra composited scrolling layer and may prevent the
  low-latency overlay path.
- **H5 — digitizer/refresh-rate floor.** If the panel is 60 Hz the floor is ~16 ms + display
  latency; prediction hides some of it but not all.

## Proposed restructures (to be judged, not blindly applied)

1. **Ship the live stroke on a viewport-sized canvas**, not a page-sized one: a canvas the size of
   the visible viewport (plus a margin), positioned in the scroller's coordinate space, drawn with
   a translate offset; on pen-up, copy the stroke onto the page-sized ink canvas. This cuts the
   live layer from 2900×3900 to ~2000×2400 and is the classic "ink overlay above the document"
   structure.
2. **Drop the separate interaction layer entirely**: draw the live stroke directly onto the ink
   canvas and keep a small snapshot of the last dirty rectangle to undo prediction. One less
   45 MB texture and no transparent full-page overlay.
3. Move the interaction canvas **out of the scroller** into a `position:fixed` overlay kept in sync
   with `scrollLeft/scrollTop` (RTL: `scrollLeft` is 0 at the right edge and negative going left).
4. Cap `dpr` at 1.5 instead of 2.
5. Retire the highlighter layer (`display:none`) when the page has no highlighter strokes.

## Questions for the reviewer

1. On a mid-range Android tablet in Edge, which of H1–H5 is most likely, and what is the
   **cheapest decisive test** for each?
2. Is `desynchronized: true` effective when the canvas (a) is inside an `overflow:auto` scroller,
   (b) is much larger than the viewport, (c) has its CSS `opacity` assigned at runtime? If not,
   what structure does Chromium require for the low-latency path?
3. What is the known-good architecture for a lowest-latency stylus canvas inside a scrolling,
   zoomable document (the OneNote/Edge-inking shape)? Viewport-sized overlay + scroll sync, single
   opaque canvas, or something else? What must be avoided?
4. Are we missing any Chromium capability for stylus latency (`pointerrawupdate` and
   `getPredictedEvents` are used; `desynchronized` is used)? Is drawing immediately per event
   better or worse than batching into `requestAnimationFrame` on a 120 Hz panel?
5. How should we keep ink crisp at high dpr without the memory cost — small live canvas composited
   on pen-up, `dpr` cap, or tiled rendering?
6. Any concrete reports/numbers for canvas ink latency in Android Edge, and how large is the gap to
   a native ink surface?

## The user's fallback idea

"Make Edge think our PDF/tools are native so we can write with Edge's own ink." Please assess
honestly: Edge's inking is not embeddable in a web page and there is no API that hands our canvas
to it. Realistic alternatives: (a) fix this stack, (b) ship a native shell (e.g. Android WebView
with a native ink overlay), (c) write/annotate in Edge's own PDF viewer and import the result,
(d) write in OneNote/Windows Ink and import an image/PDF. Which gives the biggest latency win per
unit of work?

## Data the user still has to collect (unknown to the code)

- Tablet model, Android/Windows version, Edge version, panel refresh rate (60/120 Hz).
- Meter numbers before and after «روانتر»: input latency p50/p90/p99, frame rate, dropped frames,
  raw sample count.
- Is the lag **during** a stroke or a **hitch after lifting the pen**?
- Is panning/zooming also slow?
- Does a page with almost nothing on it feel fast (i.e. does it degrade with the amount of
  writing)?
- **Control:** is inking inside Edge's own PDF viewer smooth on the same tablet?
