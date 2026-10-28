# Number scanner: findings and plan for bringing it into MICMS

This proof of concept (POC) answers one question for MICMS Task 13 (scanning an item's serial number with
the phone camera): **can a phone read the text on a label, on the phone itself, quickly and reliably?**
It reads *all* the text in the aiming box. It does not know any serial numbers, so it does not match
reads against items. Matching, the scan modes and the item pages are left for MICMS (see
[What MICMS adds](#what-micms-adds)).

Everything below comes from scans made on the owner's phone (Samsung Galaxy S25, Chrome, Android) on
2026-10-27. The scans were saved by the lab server (`npm run lab`), and each one was checked against its
pictures on the development computer. Decisions and evidence are on
[issue #1](https://github.com/israeleis/number-scanner-poc/issues/1). Engraved and stamped metal is
[issue #2](https://github.com/israeleis/number-scanner-poc/issues/2).

## Contents

1. [The result in short](#the-result-in-short)
2. [How it reads](#how-it-reads)
3. [Settings that were decided, and why](#settings-that-were-decided-and-why)
4. [What the scans showed, batch by batch](#what-the-scans-showed-batch-by-batch)
5. [Known problems that are still open](#known-problems-that-are-still-open)
6. [What to bring into MICMS](#what-to-bring-into-micms)
7. [What MICMS adds](#what-micms-adds)
8. [Samples from production](#samples-from-production)
9. [How to run the lab](#how-to-run-the-lab)

## The result in short

- **Yes, it works on the phone.** Printed labels (laptop and adapter labels, barcode digits, food
  packaging, appliance buttons) are read correctly in most frames. Text at any angle, upside down and
  vertical is read.
- **Speed on the S25:** about **0.55 s per read frame** on the graphics processor (WebGPU): detection
  85 ms, about 22 ms per text line. On the main processor (WebAssembly) it is about 0.8 s
  (detection 265–300 ms, 42–59 ms per line). A label with a confident read is written down from a single
  frame, so a label takes about 0.5–1 s once the picture is sharp.
- **The slowest part now is blur, not computing.** Without the torch, 20–60% of frames were too blurred
  to read (hand movement, magnification). With the torch, 0–15%.
- **Closest focus:** the browser sees two back cameras. The main one focuses from **10 cm**. The other
  offers no focus control. The macro lens is not reachable from a web page. Hold the phone 12–20 cm
  away and use the app's magnification.
- **Engraved or stamped metal has not been tested.** There are no samples yet. See issue #2 and
  [Samples from production](#samples-from-production).

## How it reads

All of it runs in the browser, with no server call per frame.

```
camera (4K, back camera that focuses closest)
  → aiming box: only the middle of the picture is cut out, at full camera resolution
  → blur gate: frames with Laplacian variance under 20 are skipped
  → preprocessing: contrast stretch, brightening of dark frames, sharpening
  → text detection: PaddleOCR PP-OCRv4 (DB), image scaled to 640 px
  → boxes: each text region gets its own slant; pieces of one line split at a hyphen are joined;
           reads cut by the side of the box are left out
  → direction: PaddleOCR direction model says whether each line is upside down (one run per frame)
  → recognition: PaddleOCR PP-OCRv3 English (CTC), each line straightened to 48 px high
  → clean-up: quote marks inside runs of 4+ digits are dropped (barcode guard bars)
  → order: nearest the middle of the box first (the number aimed at is most likely there)
  → single scan: reads of 3 sharp frames are voted character by character
    continuous scan: lines become a label (see below), with a beep and a vibration
```

**Models** (in `public/models`, about 14 MB together, downloaded once and cached):

| File | Model | Size |
|---|---|---|
| `det.onnx` | PP-OCRv4 text detection (`ch_PP-OCRv4_det_infer`) | 4.7 MB |
| `cls.onnx` | Direction 0°/180° (`ch_ppocr_mobile_v2.0_cls`) | 0.6 MB |
| `rec.onnx` | PP-OCRv3 English recognition (`en_PP-OCRv3_rec_infer`) | 9.0 MB |
| `en_dict.txt` | The 95 characters of the English model, plus space | |

They are the ONNX exports published by [RapidOCR](https://huggingface.co/SWHL/RapidOCR) (PaddleOCR is
Apache-2.0). The runtime is [ONNX Runtime Web](https://onnxruntime.ai) (MIT), single-threaded, because
GitHub Pages cannot send the cross-origin isolation headers threads need. MICMS serves its own pages, so
it **can** send those headers and try several threads on the main processor.

**Graphics processor.** The app always starts on the main processor (ready in about 1.2 s). It then
checks whether the browser offers WebGPU, which needs no download. Only if it does is the WebGPU runtime
downloaded (about 29 MB, once) and prepared in the background. The next scan after that uses it. Without
WebGPU nothing more is downloaded. Two details that matter: the WebGPU build needs its own WebAssembly
file (`ort-wasm-simd-threaded.asyncify.wasm`), and WebGPU models must be created one at a time.

**Continuous scanning: lines into labels** (`src/continuous.ts`, `LabelTracker`). This is the part with
the most real-world fixes:

- A line counts once it was read the same way in 2 of the last 4 frames, or in one frame with ≥ 97%
  confidence.
- "The same way" ignores case, spaces, letter O / digit 0 and I / l / 1. The serial
  `SN:R4N0LP028239165` was read with O in one frame and 0 in the next, and was never counted before this.
- A line that is a piece of a known line (`:R4N0LP028239165`), or a longer read of one, is the same line.
- Lines under 75% confidence are not counted. These are logos and marks (`CEFC`, `CORH`, `CeAH`).
- A new label starts when the camera has left the text for 3 frames, when most lines change, or when a
  new number of 4+ digits appears that has the **same shape** as the label's own number (same run of
  letters and digits) while that number is gone. So a neighbouring serial starts a new label, but a date
  coming into view as the phone moves along the label does not.
- A label that starts within 1.5 s of the previous one, nearly the same (each line within 2 characters)
  and where the differing lines came from a single frame, is merged into it.

## Settings that were decided, and why

| Setting | Value | Why (from the scans) |
|---|---|---|
| Aiming box | on, 90% × 85% of a 1.3 : 1 viewfinder | Small text reaches the model about twice as big. The owner wanted only the scanned part on screen, tall enough for a square label. |
| Camera | back camera with the closest focus, 4K | On the S25 that is the main camera (10 cm). 4K keeps pixels when magnified. |
| Magnification | ×2 (×1, ×1.5, ×3, ×4 available) | Open question: ×2 had 62% blurred frames against 20% at ×1, and ×1 at 4K still read well. |
| Site's own focus search | **off** | Moving the lens from the browser took about 210 ms per step (not 33), the phone refused 71 of 124 searches, and searches took 78 of 147 s of a scan. The phone's own autofocus is better at 12–20 cm. The code stays for phones that do better (`FocusSearch`, 3–10 cm, climbing from the last good focus). |
| Torch | off, a switch | It removes blur (0 of 17 frames blurred against 28 of 66). But most scanning is in daylight, it drains the battery, and it will glare on steel (issue #2). |
| Detection size | 640 px | The same text as at 960 px, 2.6 times faster on a full frame. |
| One-frame threshold | 97% | 3 of the 4 one-frame misreads at 95% were under 97%. One misread still passed at 98.6% (`K1404ZA-NK101`). |
| Line confidence floor (continuous) | 75% | Logos and marks came in at 56–83%. Real lines were mostly 87–99%. |
| Blur threshold | 20 | 40 threw away soft frames that still read well. |
| Graphics processor | on, prepared in the background | 3.3 times faster detection, 2 times faster recognition, same reads. |
| Marking on the phone | off | The owner scans quickly and the results are checked on the computer from the pictures. |

## What the scans showed, batch by batch

Each batch was analysed with `scripts/analyze.mjs`, and every label picture was checked by eye.

1. **First phone test (single scans).** A pen label was not read: the text was small and upside down,
   and the camera did not focus that close. This led to the aiming box, reading at any angle, the zoom
   and focus work, and the camera choice.
2. **First continuous scan, 107 s, 6 labels.** The lines of a slanted label came out in the wrong order
   (sorted by screen height). 117 of 145 frames were blurred, because the phone was closer than the
   camera can focus. Detection at 960 px took 0.88 s. **Fixed:** order along the text's own slant, a
   blurred frame forces a real focus search, the focus distance and a "too close" warning are shown,
   detection is at 640 px.
3. **21 labels (food, appliances, a shipping label).** 13 fully right, 3 more right except a stray `"`
   from barcode guard bars. Misreads were on blurred frames (`T00%` for 100%, `1290…` for `7290…`,
   `HHSO` for QSHH read upside down). The same label was taken 2–3 times. The site's focus search was
   slow and often refused. **Fixed:** the phone's autofocus by default, quote marks dropped in digit
   runs, the one-frame threshold raised to 97%, near-identical retakes merged.
4. **Laptop and adapter labels.** The reads were right, but the serial line was never counted (O and 0
   differed between frames). Each label was split when a date line came into view, and words cut by the
   box edge came in as fragments. **Fixed:** O/0 and I/1 tolerant comparison, the split rule, cut words
   left out, and the direction model instead of reading doubtful lines twice (−34% recognition time on a
   busy frame).
5. **Same labels with and without the torch.** The torch removed blur. Large sharp text was split into
   pieces at hyphens (`X1404ZA-` + `-NK101`). **Fixed:** touching pieces of a line are joined, and a
   piece of a known line counts as that line. A looser join merged two columns that sat half a line
   apart, so it was narrowed.
6. **Main processor against graphics processor.** WebGPU was clearly faster with the same reads (table
   above). Logos still made labels, and moving along one label still split it. **Fixed:** the 75% line
   floor and the "same shape" rule for new labels.

## Known problems that are still open

- **Blur is the main delay.** Ideas: lower magnification, read a soft frame anyway when nothing sharper
  came for a while, a short torch pulse only when frames stay blurred.
- **Confident misreads from one frame** (`K1404ZA-NK101` at 98.6%). Once the matching cascade (below)
  exists, a one-frame read that matches no item should wait for a second frame.
- **Spaces between words** can be lost when words are tight and blurred (`PARTNO4471X`). A gap-based
  rule broke normal text (`www.pentel .com`, `MADE I N`) and was dropped. With matching against known
  serials, spaces matter less: compare without spaces.
- **Joined columns:** two fields that touch on one row can come out as one line
  (`ASUS Vivobook 14T:X1404Z`). The words are still separate for searching.
- **Hebrew is not read** (the model is Latin and digits). Serials do not need it. A Hebrew line becomes
  noise, usually under the 75% floor.
- **Engraved and stamped metal, glare:** untested (issue #2).
- **iPhone:** not tested. Safari offers almost no camera controls (no torch, no focus control).
  WebGPU depends on the iOS version. The app falls back to the main processor.

## What to bring into MICMS

MICMS's frontend is React 19, Vite and `vite-plugin-pwa`, the same as the POC, so the code moves
almost as it is.

**Take as they are** (they have no knowledge of the POC's screens):

| POC file | What it does |
|---|---|
| `src/ocr/engine.ts` | Loads the models (main processor or WebGPU), detection, boxes, direction, recognition, reading order |
| `src/ocr/ctc.ts` | Decoding of the recognition output, quote clean-up in digit runs |
| `src/ocr/vote.ts` | Voting a line over several frames |
| `src/ocr/imageops.ts` | Sharpness measure, preprocessing |
| `src/camera.ts` | Opening the camera, camera list and choice, torch, focus search |
| `src/scanner.ts` | Aiming box geometry, one scan with voting, frame log |
| `src/continuous.ts` | Continuous scanning: lines into labels, retakes, beep and vibration |
| `public/models/*`, `scripts/copy-ort.mjs` | Models, and copying the runtime's WebAssembly files |

With them come their unit tests (`*.test.ts`, 61 tests).

**Rewrite in MICMS's style:**

- The screens (`src/App.tsx`): the scanner becomes a MICMS component with MICMS's header, i18next texts
  in English and Hebrew, and the phone layout. Keep: the aiming box viewfinder, magnification buttons,
  the newest label shown over the picture as lines of word chips, and a beep with vibration per label.
- Settings: most POC settings become fixed values (table above). Only the torch, magnification and
  perhaps the graphics processor stay as user switches. The rest become admin or developer settings.
- Storage and sending (`src/store.ts`, the lab server, the Apps Script): replaced by the sample feature
  ([below](#samples-from-production)).

**Serving:**

- Serve the models and the runtime's WebAssembly files from MICMS, cache them on first use, and keep
  them out of the up-front install cache (they are 15–45 MB).
- Send cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`) on the scanner's pages and measure whether several
  threads speed up the main processor. Check that nothing else in MICMS breaks under them.
- The camera needs HTTPS (production already has it).

**Load order:** start the main processor engine only when the scanner opens, not when MICMS starts.
Then prepare WebGPU in the background, as in the POC.

## Waiting for a steady phone

In continuous scanning the phone moves from item to item, and a number entering the box during the move
was already being read (cut off or blurred). Now nothing is read while the phone moves: motion comes from
the gyroscope (rotation speed, where the browser gives it; iPhone asks permission) and from the change
between consecutive small frames (works everywhere). Reading starts after 150 ms of steadiness, a moving
phone ends the current label, and the aiming box turns grey and dashed while moving. The thresholds
(25 °/s, a mean picture change of 12 out of 255) are first guesses: every frame logs rotation speed and
picture change, so they are set from real scans. In the test browser a sliding picture measured 38–44 and
a still one 0.

## Centre-out order and the precision button

**By default all the text in the box is read, and the results always come centre-out:** the line nearest
the middle of the aiming box first. The tester aims the middle at the number they want, so it is most
likely first, and that is the order for matching against the database in MICMS. Each line saves its
distance from the middle (0 when the middle is on it), so the lab data shows which number was aimed at.
(The label's own reading order, along its slant, is still in the code, `inTextOrder`, for showing a
whole label.)

**Precision, while held.** For a label with a lot of text where the default did not get the number:
- **Hold the precision button:** a crosshair shows in the middle, and only the line under it (or within
  one line's height) is read. Let go and everything is read again.
- **Hold a finger on the picture:** the point under the finger is the precision point, wherever it is in
  the box; the crosshair follows the finger, and only the line nearest it is read.

It works during a running scan (natural in continuous scanning). Nothing else is read, so it is also
quicker (one line instead of 5–12). Frames read with precision log the point (`aim`). Where the
button finally sits is for MICMS's screen design.

## What MICMS adds

This is what the POC skipped on purpose, because it read all the text without knowing any serial:

- **Matching cascade against the unit's real serials** (Task 13): exact, then suffix (last N
  characters), then fuzzy, weighted for the confusions seen here (O/0, I/1, B/8, S/5, X/K, Z/2, Q/O),
  over every line and every word of the label. Spaces and punctuation are ignored when comparing.
  Results are ranked, never a silent guess.
- **Use matching to decide when to stop:** a label is done as soon as one of its lines matches an item
  strongly, even from one frame. A line that matches nothing waits for a second frame. This removes most
  one-frame misreads and makes the common case faster.
- **The scan modes** from Task 13: search, daily count, move items, shared sweep, storage-place check.
  They all share the scanner component. The continuous scanner here is the base for count, sweep and
  place check.
- **Offline:** the unit's serial list must be on the phone for matching without network. MICMS already
  syncs data for offline use.

## Samples from production

Real weapons are not available before production, so the scanner should go in with a feature that
sends samples from the first day:

- Per scan: the picture of the aiming box (and the label crops), every line read with its confidence,
  the frame log (timings, sharpness, glare), the camera, settings and backend. Then whether the user
  accepted a match, and which item. That gives ground truth without anyone marking ✓ or ✗.
- Switched on or off per unit by an admin. Stored where only developers and admins can reach it, kept
  for a limited time, and deleted on request. **Serials and pictures of weapons are sensitive:** never
  in issues, chat or screenshots.
- A summary for the first days: share matched, time to match, blur and glare, per setup and per
  phone. `scripts/analyze.mjs` is the starting point.

## How to run the lab

```
npm install
npm run lab        # https://<computer>:5443/number-scanner-poc/ (accept the certificate once)
node scripts/analyze.mjs                 # summary of every saved scan
node scripts/analyze.mjs data/scans/<dir> # one scan
```

The phone opens the lab address (same Wi-Fi, or through Tailscale). Every saved scan is written to
`data/scans/<time>_<id>/` with `record.json`, `original.jpg`, `processed.jpg` and `label-N.jpg`. The
`data/` folder is not committed. The app on GitHub Pages can send to the lab too: set its script URL in
the settings to `https://<computer>:5443/number-scanner-poc/api/scans`.
