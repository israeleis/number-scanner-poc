// PaddleOCR in the browser: PP-OCRv4 text detection (DB) and PP-OCRv3 English recognition (CTC),
// both run with ONNX Runtime Web on WebAssembly.
import * as ort from 'onnxruntime-web/wasm'
import { ctcDecode } from './ctc'

const BASE = import.meta.env.BASE_URL

/**
 * A text region: a rectangle turned by `angle` (radians, clockwise in screen coordinates) around
 * its centre, `length` along the text and `thickness` across it; x, y, w, h bound it upright.
 */
export interface Box {
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
  length: number
  thickness: number
  angle: number
  score: number
}

/** The four corners of a box, in order around it. */
export function boxCorners(b: Pick<Box, 'cx' | 'cy' | 'length' | 'thickness' | 'angle'>): [number, number][] {
  const ux = Math.cos(b.angle), uy = Math.sin(b.angle)
  const hl = b.length / 2, ht = b.thickness / 2
  return [
    [-hl, -ht],
    [hl, -ht],
    [hl, ht],
    [-hl, ht],
  ].map(([a, c]) => [b.cx + a * ux - c * uy, b.cy + a * uy + c * ux])
}

export interface TextRead {
  text: string
  confidence: number
  box: Box
  /** Degrees the text was turned to read it (its slant, plus 180 when it was upside down). */
  rotation: number
}

export interface OcrOptions {
  /** Longest side of the image given to the detector, in pixels. */
  detLimit: number
  /** Reads below this confidence are dropped. */
  minConfidence: number
  /** At most this many text boxes are read per frame. */
  maxBoxes: number
}

let loading: Promise<Engine> | null = null

export function loadEngine(): Promise<Engine> {
  if (!loading) loading = Engine.create()
  return loading
}

/** Where the time of the last `read` went, for studying speed. */
export interface ReadStats {
  detMs: number
  recMs: number
  /** Text boxes found, and recognitions run (a doubtful box is read twice). */
  boxes: number
  recs: number
}

export class Engine {
  loadMs = 0
  last: ReadStats = { detMs: 0, recMs: 0, boxes: 0, recs: 0 }
  private det: ort.InferenceSession
  private rec: ort.InferenceSession
  private dict: string[]

  private constructor(det: ort.InferenceSession, rec: ort.InferenceSession, dict: string[]) {
    this.det = det
    this.rec = rec
    this.dict = dict
  }

  static async create(): Promise<Engine> {
    const t0 = performance.now()
    ort.env.wasm.wasmPaths = { wasm: `${BASE}ort/ort-wasm-simd-threaded.wasm` }
    // GitHub Pages cannot send the cross-origin isolation headers threads need.
    ort.env.wasm.numThreads = 1
    const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }
    const [det, rec, dictText] = await Promise.all([
      ort.InferenceSession.create(`${BASE}models/det.onnx`, opts),
      ort.InferenceSession.create(`${BASE}models/rec.onnx`, opts),
      fetch(`${BASE}models/en_dict.txt`).then((r) => r.text()),
    ])
    // The English model's classes: blank, the dictionary, then a space.
    const dict = [...dictText.split('\n').filter((l) => l.length > 0), ' ']
    const engine = new Engine(det, rec, dict)
    engine.loadMs = Math.round(performance.now() - t0)
    return engine
  }

  async read(canvas: HTMLCanvasElement, options: OcrOptions): Promise<TextRead[]> {
    const t0 = performance.now()
    const boxes = (await this.detect(canvas, options.detLimit))
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, options.maxBoxes)
    const t1 = performance.now()
    let recs = 0
    const reads: TextRead[] = []
    for (const box of boxes) {
      // The box is straightened along its own slant, so text at any angle reaches the model level.
      // The slant does not tell which end is the start: a doubtful read is tried upside down too.
      let best = { ...(await this.recognize(canvas, box, false)), flipped: false }
      recs++
      if (best.confidence < 0.9) {
        recs++
        const r = await this.recognize(canvas, box, true)
        if (r.confidence > best.confidence) best = { ...r, flipped: true }
      }
      const rotation = Math.round((box.angle * 180) / Math.PI + (best.flipped ? 180 : 0))
      if (best.text && best.confidence >= options.minConfidence) {
        reads.push({ text: best.text, confidence: best.confidence, box, rotation })
      }
    }
    this.last = { detMs: Math.round(t1 - t0), recMs: Math.round(performance.now() - t1), boxes: boxes.length, recs }
    return reads.sort((a, b) => (Math.abs(a.box.cy - b.box.cy) < a.box.h / 2 ? a.box.cx - b.box.cx : a.box.cy - b.box.cy))
  }

  private async detect(canvas: HTMLCanvasElement, limit: number): Promise<Box[]> {
    const scale = Math.min(1, limit / Math.max(canvas.width, canvas.height))
    const w = Math.max(32, Math.round((canvas.width * scale) / 32) * 32)
    const h = Math.max(32, Math.round((canvas.height * scale) / 32) * 32)
    const px = drawScaled(canvas, 0, 0, canvas.width, canvas.height, w, h)
    const mean = [0.485, 0.456, 0.406]
    const std = [0.229, 0.224, 0.225]
    const input = new Float32Array(3 * w * h)
    // Paddle models are trained on BGR images.
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) {
        input[c * w * h + i] = (px[i * 4 + (2 - c)] / 255 - mean[c]) / std[c]
      }
    }
    const out = await this.det.run({ [this.det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) })
    const prob = out[this.det.outputNames[0]].data as Float32Array
    return dbBoxes(prob, w, h, canvas.width / w, canvas.height / h)
  }

  private async recognize(canvas: HTMLCanvasElement, box: Box, flipped: boolean) {
    const H = 48
    const W = Math.min(640, Math.max(16, Math.ceil((H * box.length) / box.thickness)))
    const px = drawStraightened(canvas, box, W, H, flipped)
    const input = new Float32Array(3 * W * H)
    for (let i = 0; i < W * H; i++) {
      for (let c = 0; c < 3; c++) input[c * W * H + i] = (px[i * 4 + (2 - c)] / 255 - 0.5) / 0.5
    }
    const out = await this.rec.run({ [this.rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, H, W]) })
    const t = out[this.rec.outputNames[0]]
    const [, steps, classes] = t.dims
    return ctcDecode(t.data as Float32Array, steps, classes, this.dict)
  }
}

let scratch: HTMLCanvasElement | null = null

function scratchContext(w: number, h: number) {
  scratch ??= document.createElement('canvas')
  scratch.width = w
  scratch.height = h
  return scratch.getContext('2d', { willReadFrequently: true })!
}

function drawScaled(src: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number, w: number, h: number) {
  const ctx = scratchContext(w, h)
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h).data
}

/** Cuts the box out as a level w x h image (text running left to right), or upside down. */
function drawStraightened(src: HTMLCanvasElement, box: Box, w: number, h: number, flipped: boolean) {
  const ctx = scratchContext(w, h)
  ctx.translate(w / 2, h / 2)
  if (flipped) ctx.rotate(Math.PI)
  ctx.scale(w / box.length, h / box.thickness)
  ctx.rotate(-box.angle)
  ctx.translate(-box.cx, -box.cy)
  ctx.drawImage(src, 0, 0)
  return ctx.getImageData(0, 0, w, h).data
}

/**
 * DB post-processing: threshold the probability map and take connected regions whose mean probability
 * is high enough. Each region's slant comes from the spread of its pixels (principal axis), so slanted
 * and vertical text gets a turned box. Boxes are grown, since the model predicts shrunk text regions.
 * `sx`, `sy` scale map pixels to image pixels.
 */
export function dbBoxes(
  prob: Float32Array,
  w: number,
  h: number,
  sx = 1,
  sy = 1,
  thresh = 0.3,
  boxThresh = 0.6,
  unclip = 1.6,
): Box[] {
  const seen = new Uint8Array(w * h)
  const boxes: Box[] = []
  const stack: number[] = []
  const pixels: number[] = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= thresh) continue
    let sum = 0
    pixels.length = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      pixels.push(i)
      sum += prob[i]
      for (const n of [i - 1, i + 1, i - w, i + w]) {
        if (n < 0 || n >= w * h || seen[n] || prob[n] <= thresh) continue
        if ((n === i - 1 && x === 0) || (n === i + 1 && x === w - 1)) continue
        seen[n] = 1
        stack.push(n)
      }
    }
    const count = pixels.length
    if (count < 10 || sum / count < boxThresh) continue

    // Centre and spread, in image pixels.
    let mx = 0, my = 0
    for (const i of pixels) {
      mx += ((i % w) + 0.5) * sx
      my += (((i / w) | 0) + 0.5) * sy
    }
    mx /= count
    my /= count
    let cxx = 0, cyy = 0, cxy = 0
    for (const i of pixels) {
      const dx = ((i % w) + 0.5) * sx - mx
      const dy = (((i / w) | 0) + 0.5) * sy - my
      cxx += dx * dx
      cyy += dy * dy
      cxy += dx * dy
    }
    let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
    // Extent along the text and across it (each map pixel covers sx by sy image pixels).
    const extent = (a: number) => {
      const ux = Math.cos(a), uy = Math.sin(a)
      let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity
      for (const i of pixels) {
        const dx = ((i % w) + 0.5) * sx - mx
        const dy = (((i / w) | 0) + 0.5) * sy - my
        const along = dx * ux + dy * uy
        const across = -dx * uy + dy * ux
        if (along < lo) lo = along
        if (along > hi) hi = along
        if (across < lo2) lo2 = across
        if (across > hi2) hi2 = across
      }
      const pad = Math.abs(ux) * sx + Math.abs(uy) * sy
      const pad2 = Math.abs(uy) * sx + Math.abs(ux) * sy
      return { lo, hi, lo2, hi2, length: hi - lo + pad, thickness: hi2 - lo2 + pad2 }
    }
    let e = extent(angle)
    if (e.thickness > e.length) {
      angle += Math.PI / 2
      e = extent(angle)
    }
    // Keep the slant within ±90°; whether the text is upside down is decided when reading.
    if (angle > Math.PI / 2) angle -= Math.PI
    if (angle <= -Math.PI / 2) angle += Math.PI
    e = extent(angle)
    if (Math.min(e.length / sx, e.thickness / sy) < 3) continue
    const ux = Math.cos(angle), uy = Math.sin(angle)
    // The middle of the extent, which is not always the pixel average.
    const midA = (e.lo + e.hi) / 2
    const midC = (e.lo2 + e.hi2) / 2
    const cx = mx + midA * ux - midC * uy
    const cy = my + midA * uy + midC * ux
    const d = (e.length * e.thickness * unclip) / (2 * (e.length + e.thickness))
    const length = e.length + 2 * d
    const thickness = e.thickness + 2 * d
    const corners = boxCorners({ cx, cy, length, thickness, angle })
    const xs = corners.map((c) => c[0])
    const ys = corners.map((c) => c[1])
    const x0 = Math.max(0, Math.min(...xs))
    const y0 = Math.max(0, Math.min(...ys))
    const x1 = Math.min(w * sx, Math.max(...xs))
    const y1 = Math.min(h * sy, Math.max(...ys))
    boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx, cy, length, thickness, angle, score: sum / count })
  }
  return boxes
}
