# Chromograph Web

Encodes text into a colour-graded spline over a 5×6 character grid, rendered as an isometric
plot, and decodes it back out of the exported file. Everything runs in the browser; there is
no backend.

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # node --test, no framework
npm run build
```

## Encoding

The 30 grid cells map to `A–Z`, space, `.`, `,`, `?`. Each character becomes a knot at its
cell's centre, and a centripetal Catmull-Rom spline is drawn through the knots in order.
Re-visiting a cell pushes the knot onto a small orbit around the centre (golden-angle
spacing), so `LL` is two distinguishable points rather than one.

Two things then say *where in the message* a knot sits:

- **Hue** advances uniformly per character step — with N characters, knot *k* is at exactly
  hue `k × 300 / (N − 1)`. Not per unit of arc length: uniform steps are what let a decoder
  sample N specific hues and ignore everything between them as transit.
- **Height** rises with the character index, `z = (k + 1) / N`, lifting the path into a third
  dimension over a wireframe base plane.

Hue runs 0°–300° rather than a full 360°, so red never appears at both ends and the direction
of the message is never ambiguous.

## Formats, and what each can actually promise

|  | Order comes from | Exact? | Measured |
|---|---|---|---|
| **GIF** | frame index | yes | 29 characters, exact, roundtripped |
| **Sheet PNG** | frame index | yes | 120 characters, zero errors |
| **WebM** | frame index | yes | unverified — needs a browser video encoder |
| **PNG / SVG still** | hue | best effort | reliable to ~60 characters |

Colour is optional. A frame's order comes from its header, and the header plate and the marker
are both black and white, so a greyscale export decodes exactly like any other — verified on a
Grayscale GIF whose 11.2 million pixels contain **no saturated pixel at all**. Only stills need
hue, because a still has no frame index to read instead.

### GIF, sheet and WebM: the frame index *is* the channel

One frame per character. On frame *k*, character *k*'s knot is marked, and the scene has
turned to yaw `2πk/N`. Every frame carries a small binary header stating **"I am character k
of n"**, with a parity bit.

That header is what makes it exact. Nothing analog is measured anywhere: *k* comes from the
header, and from *k* follow both the marked knot's height and the camera angle — and with
height and angle known the axonometric projection inverts exactly, so the marker's position
gives the grid cell outright. Frames are therefore fully independent. They can arrive out of
order, be duplicated, or go missing; a lost frame costs exactly one character and says so.

The marker is achromatic — whichever of black or white the background is not — and is found by
luminance, with the header plate excluded by its known position rather than by hoping it looks
different. That is deliberate on two counts: it leaves frames carrying no colour information
whatsoever, and luminance survives compression better than chroma does.

**GIF** is the rotating one, and the format to reach for. `lib/gif.ts` is a GIF89a encoder and
decoder written out by hand, no dependency, so neither direction needs anything from the
browser and the whole path is testable in Node. GIF is 8-bit, so frames are quantised to 256
colours — which costs nothing here, because the decode reads a black-and-white header plate
and the position of one saturated square, and the palette is built to hold both exactly.
Quantisation goes through a 32768-entry nearest-colour table so it stays one array read per
pixel rather than 256 comparisons. The cube is equal on all three axes on purpose: give blue a
different number of levels and no mid grey is representable, so every grey picks up a colour
cast — conspicuous on a greyscale palette, where the whole image is greys. Black, white and the
background have their buckets pinned outright, since nearest-neighbour does not guarantee them
and the decode reads all three by exact value.

**Sheet PNG** is the same frames tiled into one lossless image. Largest files, but nothing can
go wrong reading it.

**WebM** is the same frames in a video container. It needs a working VP8/VP9 encoder in the
browser, which not every environment has — the one this was built in produced empty files, so
it is wired up but unverified.

### Stills: honest limits

A single frame has no frame index, so order has to come from hue, and hue is a *photometric*
channel — it degrades. The isometric projection still contributes something real: knot *k*'s
height follows from *k*, so once hue supplies the ordering the position is recovered exactly
rather than approximated.

- **≤ 60 characters.** Past that the per-character hue step drops under the noise floor of
  antialiasing and compression. The UI says so and points at the sheet.
- **PNG only.** JPEG chroma subsampling damages hue before anything else.
- **Uncropped.** The scene is placed from the image's dimensions alone.
- **Neutral backgrounds only.** A saturated background leaks its own hue into the antialiased
  edge of every stroke, and those blends land in the hue bin belonging to a real character.
  Black, silver and white have no hue to leak — which is why there is no navy palette, even
  though the UI chrome is navy.
- **Not the Grayscale palette**, which has no hue to order by. It decodes fine as frames.

Stems — the drop lines from each knot to the base plane — are structure for the eye. They are
drawn in a hue range past the end of the payload ramp so they cannot pollute the hue bins, but
the decode does not depend on them.

## What did not work, and why

Both failures were the same mistake, and the record is more useful than the fix.

**Stem length as an order channel.** Encode *k* as the height of the drop line, then measure
it back. It tested perfectly against a synthetic fixture and collapsed on the real renderer:
antialiasing. A curve edge fading into the background is that colour scaled by coverage, and
scaling RGB leaves hue and saturation untouched while sweeping HSV *value* continuously from 1
to 0 — straight through any brightness band reserved for stems. Moving stems to a reserved
*hue* fixed the masking, but the measurement itself stayed fragile: stems occlude each other,
and curve self-crossings blend red over magenta into that same reserved range.

**The lesson:** hue and stem length are both *analog* channels. They crowd as N grows, errors
compound, and neither can check itself. Every fix was another filter, which is the signature of
a wrong representation rather than a missing filter. The frame header replaced measurement with
**counting**, and the failure class disappeared.

## Equation export

The path fits as a truncated Fourier series in x and y. z needs no fit at all — it is exactly
linear in the curve parameter — so the whole 3D figure is a 2D Fourier series plus a straight
line.

The path is open, and a series on an open path rings badly at the seam where the end fails to
meet the start, so it is mirrored first: forwards then backwards makes one continuous loop with
no seam. The harmonics then sit at half-integer frequency, `cos(πkt)`, and `t` in 0..1 traces
the path once. Exports report their real RMS error rather than leaving it to be assumed.

**Fourier** saves the coefficients as text. **Desmos** copies a paste-ready parametric block.

## Interface

Deliberately Windows 95: `#c0c0c0` faces, `#000080` title bar, 1px bevels built from
white/silver/grey/black, MS Sans Serif at 11px, zero border radius (enforced globally in
`app/globals.css`), and no transitions — pressed controls invert their bevel instantly. Group
boxes, trackbars, checkboxes and scrollbars are restyled native elements, not custom widgets.
The title bar's minimise/maximise/close boxes are chrome only: a browser tab has no such
actions, so they are rendered but inert rather than faked.

The one thing that is not flat is the curve. Its colour gradient is the payload, not
decoration — removing it would delete the message.

## Layout

```
app/          shell, studio page, all UI state
components/   Sidebar (controls), CanvasView (canvas), Decoder (upload + debug view)
lib/grid      charset, cell coordinates, text -> knots
lib/spline    centripetal Catmull-Rom sampling
lib/palette   hue mapping, palettes, RGB->HSV
lib/iso       the fixed axonometric projection and its exact inverse
lib/render    Canvas2D renderer, flat and isometric, stills and frames
lib/frame     per-frame header barcode, and sprite sheet slicing
lib/gif       GIF89a encoder and decoder, LZW both ways
lib/anim      WebM recording and frame capture, both native browser APIs
lib/svg       vector export, built from the same curve as the canvas
lib/equation  Fourier fit, text and Desmos serialisations
lib/decode    image -> text, for stills and for frames
```

The camera is fixed on purpose. The projection has to be known to the decoder for a still to
be readable at all, so it is a constant, not a setting — and in the animated format the yaw is
a function of the frame index, which the frame states.

`lib/render.ts` and `lib/iso.ts` own the scene's placement inside an image, as a pure function
of the image's dimensions. The renderer, the SVG exporter and the decoder all go through it,
which is what lets a decode work at any export size. The calibration bar's slot is reserved
whether or not the bar is drawn, so toggling it never shifts anything.

## Deploy

Import the repo on Vercel. There is nothing to configure: no API routes, no `vercel.json`, no
environment variables. `next build` is the entire deployment.
