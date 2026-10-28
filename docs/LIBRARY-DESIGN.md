# Camera assistant for the browser: design proposal

A library that any web app (MICMS first) imports to use the phone camera for one task at a time: read the
text on a label, read a barcode, take the sharpest photo of a product, and more later. It grows out of
this POC: the parts that are not about weapons or MICMS (camera choice, steadiness, sharpness, focus,
magnification, text reading) become the library, and the POC becomes its lab app.

**Status: proposal, nothing built.** Each section ends with what the owner decides.

## 1. Two layers of settings

Every use of the camera is described by **what is being photographed** (a target preset: distance and
size) and **how the user works** (interaction options). The app picks a preset and overrides what it
needs.

```ts
const result = await camera.run({
  target: 'label',            // what: label | barcode | product | document | far
  task: 'text',               // what back: text | barcode | photo
  interaction: { aim: 'touch-moves-cross', precision: 'hold-button', continuous: true },
  match: (lines) => findItem(lines),   // optional: the app says when a result is right
})
```

## 2. Target presets ("what is being photographed")

A browser cannot measure distance. The distance range of a preset is used to:
- **choose the camera** that can focus within it (on the S25 the main camera focuses from 10 cm;
  the macro lens is not reachable from a web page),
- **limit the focus search** where the site can move the lens (otherwise the phone's autofocus is used),
- **set the starting magnification** and the aiming box,
- **warn "too close"** when the range starts nearer than the camera can focus.

| Preset | Distance | Typical use | Starting setup |
|---|---|---|---|
| `label` | 8–20 cm | Serial labels, printed or stamped text | Closest-focusing back camera, 4K, ×2, box 1.4 : 1, text reading, steadiness wait |
| `barcode` | 8–25 cm | Barcodes and QR codes | Main camera, 1080p (enough for barcodes), ×1, wide box 3 : 1, native barcode reader |
| `product` | 30–100 cm | Photo of an item for its record | Main camera, highest resolution, ×1, no box (whole picture), best-shot |
| `document` | 20–40 cm | A form or a page | Main camera, 4K, ×1, page-shaped box, best-shot (text reading optional) |
| `far` | 1–5 m | A sign, a container number | Main or zoom camera, 4K, ×2–×4, text reading |

Each value of a preset can be overridden (`{ target: 'label', distance: [5, 15], magnification: 1.5 }`).

**Owner decides:** the list of presets and their distances.

## 3. Tasks ("what comes back")

- **`text`**: all text in the box as **lines** (each with its words, confidence, box, distance from the
  aim point), **centre-out** or from the aim point. Single (stops at the first steady result or on time)
  or continuous (labels written down one after another, with beep and vibration).
- **`barcode`**: the browser's own barcode reader (`BarcodeDetector`) where it exists (Chrome on Android;
  fast, exact, no download). Without it, a small barcode library or reading the printed digits as text.
  Returns the value and its format.
- **`photo`** (best shot): waits for a steady phone and focus, takes several frames in well under a
  second, and returns the sharpest as an image (JPEG or WebP, chosen size), with its sharpness.
  No models are downloaded for this task.
- Later: `document` (straighten the page), `count` (how many items)…

Every task can also return **telemetry** (frame timings, sharpness, motion, camera, settings) to a sink
the app provides, for samples from production.

**Owner decides:** which tasks are in the first version (proposal: `text`, `photo`, `barcode`).

## 4. Interaction options ("how the user works")

| Option | Values | Default |
|---|---|---|
| `aim` | `centre` (results centre-out) · `touch-moves-cross` (a touch moves the cross until the scan ends) · `fixed-cross` (cross always in the middle) | `touch-moves-cross` |
| `precision` | `none` · `hold-button` (only the line under the cross while held) · `touch-and-hold` | `hold-button` |
| `continuous` | single scan or continuous | per task |
| `aimBox` | on/off, shape (`1.4:1`, `3:1`, `page`, custom) | per target |
| `magnification` | buttons shown, starting value | per target |
| `torch` | `button` · `auto-when-dark` · `off` | `button` |
| `waitSteady` | on/off, thresholds | on |
| `feedback` | beep, vibration, flash of the box | beep + vibration |
| `stopWhen` | `first-steady` · `match` (the app's `match` callback says yes) · `timeout` · `manual` | `match` if given, else `first-steady` |
| `gpu` | `auto` (prepare in the background where WebGPU exists) · `off` | `auto` |
| UI | full component (viewfinder, buttons) or headless (the app draws its own UI with hooks) | full component |

**Owner decides:** the defaults, and whether the component's buttons are fixed or arranged by the app.

## 5. Package layout

```
camera-assist/
  packages/core/     TypeScript, no framework: camera, steadiness, sharpness, focus, OCR engine,
                     text, barcode, best-shot, continuous labels, telemetry
  packages/react/    <CameraAssist> viewfinder component and hooks (useCameraTask)
  apps/lab/          this POC: try every option on a phone, lab server, analysis script
  models/            PaddleOCR models + copy script (the app serves them; not inside the package)
```

- **Downloads only when needed:** nothing on a device without touch or camera; models only for `text`;
  the WebGPU runtime only where WebGPU exists, in the background.
- **Install in MICMS** as a GitHub dependency pinned to a version tag; MICMS updates when it decides.
- **Tests:** the POC's 72 unit tests move with the code; the lab app is the place to measure on phones
  before a release.

**Owner decides:** the repo's name, and public or private.

## 6. What stays in MICMS

Matching against the unit's serials (whole lines first, then neighbouring words across small gaps, then
words; O/0, I/1, B/8… tolerant), the scan modes (search, count, move, sweep, place check), item pages, and
the production sample store. MICMS gives the library a `match` callback and a telemetry sink.
