# Number scanner POC

A React PWA that reads numbers and Latin text with the phone camera, in any size and lighting, to see whether
on-device OCR is good enough. Each scan is marked right or wrong and sent with its images and settings to a
Google Sheet, so failures can be studied. Open it on the phone: https://israeleis.github.io/number-scanner-poc/

**Findings from the phone tests, and the plan for bringing the scanner into MICMS:
[docs/INTEGRATION.md](docs/INTEGRATION.md).**

## How it reads

- **PaddleOCR in the browser:** PP-OCRv4 text detection and PP-OCRv3 English recognition (ONNX models from
  [RapidOCR](https://huggingface.co/SWHL/RapidOCR)), run with ONNX Runtime Web on WebAssembly. Nothing leaves the
  phone while scanning. About 14 MB of models are downloaded once, then cached.
- **Blur gate:** a frame whose sharpness (variance of the Laplacian) is below the threshold is not read.
- **Switches to compare** (the active combination is the "setup", e.g. `P1 H0 V1 T0`):
  - `P` software preprocessing: contrast stretch, brightening of dark frames, sharpening.
  - `H` camera controls: continuous focus and exposure, exposure compensation, sharpness and contrast, where the
    phone supports them (Android Chrome; iPhone Safari offers almost none).
  - `V` multi-frame voting: reads several sharp frames, aligns the reads character by character and takes the
    character with the most weight at each position. Off: the first frame with text is the result.
  - `T` torch (Android only).
- Zoom slider where the phone supports it.

## The report

After a scan, every line read is listed top to bottom: mark each one ✓ or ✗ (for ✗, optionally type what is really
written). "+ שורה שפוספסה" adds, at that place in the list, a line the scan missed. Tick the scene (day, night, glare,
far…) and save. A scan counts as correct only when every line is ✓ and none was missed. Scans are kept on the phone and sent when the script is set up and
the network is up; "הורד CSV" on the log screen downloads them as a file.

The `lines` tab has one row per line: scan id, position (1 is the top), what was read, what is really written,
✓/✗/missed, confidence, frames and agreement. The `scans` tab has one row per scan: the outcome, all the lines read in
one cell, the boxes of the kept frame, frames read and frames rejected as blurred, sharpness, time to result,
settings, scene, notes, camera resolution and supported controls, device, and links to the original and the
processed image.

## Setting up the Google Sheet (once, on a computer)

1. In Google Drive, open the folder you want and create a new Google Sheet in it.
2. In the sheet: **Extensions → Apps Script**. Replace the code with [`apps-script/Code.gs`](apps-script/Code.gs),
   and change `KEY` at the top to a secret word of your own.
3. **Deploy → New deployment →** type **Web app**. Execute as **Me**, who has access **Anyone**. Deploy, and allow
   access (Google warns the app is not verified: **Advanced → Go to … (unsafe)**).
4. Copy the **Web app URL**. In the app on the phone: ⚙ → paste the URL and the secret word → **בדוק חיבור**.

Images go to a `scan-images` folder next to the sheet. After changing the script, deploy a new version
(**Deploy → Manage deployments → edit → New version**) so the URL keeps working.

## Development

```
npm install
npm run dev      # http://localhost:5173/number-scanner-poc/
npm test
npm run build
```

Every push to `main` deploys to GitHub Pages.
