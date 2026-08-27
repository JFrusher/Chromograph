# Chromograph Web

Encodes text into a continuous colour-graded spline across a 5×6 character grid, and decodes
it back out of the resulting image. Everything runs in the browser; there is no backend.

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # node --test, no framework
npm run build
```

## How the encoding works

The 30 grid cells map to `A–Z`, space, `.`, `,`, `?`. Each character becomes a knot at its
cell's centre, and a centripetal Catmull-Rom spline is drawn through the knots in order.
Re-visiting a cell pushes the knot onto a small orbit around the centre (golden-angle
spacing), so `LL` is two distinguishable points rather than one.

**Hue advances uniformly per character step, not per unit of arc length.** With N characters,
knot *k* sits at exactly hue `k × 300 / (N − 1)`.

That detail is the whole decoder. A curve with no markers on it cannot be read geometrically:
a spline from `A` to `Z` sweeps over cells that were never part of the message, and nothing in
the shape says which crossings were characters. But if hue steps uniformly, the decoder only
has to sample the curve at N known hues — everything between them is transit, and gets ignored.

Hue runs 0°–300° (red → magenta) rather than a full 360°, so red does not appear at both ends
and message direction is never ambiguous.

## How the decoding works

1. Mask pixels tightly by saturation and value, keeping the stroke core and dropping the
   background and antialiased edges.
2. Read the **calibration bar** along the footer — one flat swatch per character. Counting the
   swatches gives N directly, and their hues confirm the ramp survived.
3. No bar? Fit N instead: for each candidate, sample the implied knot hues and score how close
   they land to cell centres. The true N puts every sample on a centre; a wrong one puts samples
   mid-transit. Ties go to the largest N that fits, since sampling every *other* knot also fits
   perfectly while silently dropping half the message.
4. Bin every masked pixel by hue and take the **median** position per bin. Median rather than
   mean on purpose: where the curve crosses itself the antialiased boundary between two strands
   blends their colours into a hue belonging to neither, and those pixels land in some third bin
   at the crossing point. A mean gets dragged by them; a median ignores them.
5. Snap each sampled knot to the nearest cell and emit the character, with a confidence score.

Confidence is measured against the nearest *legal* knot position — cell centre or orbit ring —
so repeated letters do not read as doubtful.

### Limits, honestly

- **≤ 60 characters.** N characters share a 300° ramp. Past 60, the per-character hue step drops
  under the noise floor of compression and antialiasing. The UI refuses to go further.
- **PNG only.** JPEG chroma subsampling damages hue before anything else, and hue is the only
  thing carrying the message. JPEGs often still decode, but the app says so and drops to the
  fitting fallback when the bar is too smeared to read.
- **Uncropped exports only.** The grid's position is derived from the image dimensions, so a
  cropped screenshot has no frame of reference.
- **Grayscale is not decodable.** It has no hue, so there is no order to recover. It ramps
  lightness instead, which reads as direction to a human but not to the decoder. The UI labels
  it, and the status bar says "Art only".
- **Backgrounds are neutral on purpose.** A saturated background leaks its own hue into the
  antialiased edge of every stroke, and those blends land in the hue bin belonging to a real
  character. Black, silver and white have no hue to leak. This is why there is no navy preset,
  even though the UI chrome is navy.

## Interface

The UI is deliberately Windows 95: `#c0c0c0` faces, `#000080` title bar, 1px bevels built from
white/silver/grey/black, MS Sans Serif at 11px, zero border radius (enforced globally in
`app/globals.css`), and no transitions — pressed controls invert their bevel instantly. Group
boxes, trackbars, checkboxes and scrollbars are all restyled native elements rather than custom
widgets. The title bar's minimise/maximise/close boxes are chrome only: a browser tab has no
such actions, so they are rendered but inert rather than faked.

The one thing that is *not* flat is the curve itself. Its colour gradient is the payload, not
decoration — removing it would delete the message.

## Layout

```
app/         shell, studio page, all UI state
components/  Sidebar (controls), CanvasView (canvas), Decoder (upload + debug view)
lib/grid     charset, cell coordinates, text -> knots
lib/spline   centripetal Catmull-Rom sampling
lib/palette  hue mapping, presets, RGB->HSV
lib/render   Canvas2D renderer and the shared plot geometry
lib/svg      vector export, built from the same curve as the canvas
lib/decode   image -> text
```

The renderer strokes the polyline segment by segment because Canvas2D has no gradient along an
arbitrary path. There is no glow, no bloom and no animation: flat colour on a flat background.
That is not only an aesthetic choice — soft light was actively hostile to decoding, because
additive halos of two differently-hued strands sum into a saturated third hue that belongs to
neither.

`lib/render.ts` owns `plotRect(W, H)`, the single definition of where the grid sits inside an
image. The renderer, the SVG exporter and the decoder all go through it, which is what lets a
decoder work on any export size. The calibration bar's slot is reserved whether or not the bar
is drawn, so toggling it never shifts the grid.

## Deploy

Import the repo on Vercel. There is nothing to configure: no API routes, no `vercel.json`, no
environment variables. `next build` is the entire deployment.
