// PaddleOCR in the browser: PP-OCRv4 text detection (DB), the direction model and PP-OCRv3 English
// recognition (CTC), run with ONNX Runtime Web on WebAssembly, or on the graphics processor (WebGPU).
import type * as Ort from 'onnxruntime-web'
import { cleanDigits, ctcDecode } from './ctc'

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

const loading = new Map<boolean, Promise<Engine>>()

/** `gpu`: run the models on the graphics processor where the browser offers WebGPU. */
export function loadEngine(gpu = false): Promise<Engine> {
  if (!loading.has(gpu)) loading.set(gpu, Engine.create(gpu))
  return loading.get(gpu)!
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  try {
    return !!gpu && !!(await gpu.requestAdapter())
  } catch {
    return false
  }
}

/** Where the time of the last `read` went, for studying speed. */
export interface ReadStats {
  detMs: number
  recMs: number
  /** Text boxes found, and recognitions run (a doubtful box is read twice). */
  boxes: number
  recs: number
}

type OrtModule = typeof Ort

export class Engine {
  loadMs = 0
  /** Where the models run: 'webgpu' (graphics processor) or 'wasm' (main processor). */
  backend: 'webgpu' | 'wasm' = 'wasm'
  /** On the graphics processor: time of the first run of each model (building its programs). */
  warmMs = 0
  last: ReadStats = { detMs: 0, recMs: 0, boxes: 0, recs: 0 }
  private ort: OrtModule
  private det: Ort.InferenceSession
  private rec: Ort.InferenceSession
  private dict: string[]
  private cls: Ort.InferenceSession | null

  private constructor(
    ort: OrtModule,
    det: Ort.InferenceSession,
    rec: Ort.InferenceSession,
    dict: string[],
    cls: Ort.InferenceSession | null,
  ) {
    this.ort = ort
    this.det = det
    this.rec = rec
    this.dict = dict
    this.cls = cls
  }

  static async create(gpu: boolean): Promise<Engine> {
    const t0 = performance.now()
    const useGpu = gpu && (await hasWebGpu())
    // Two builds of the runtime: the WebGPU one carries its own (larger) WebAssembly file.
    const ort: OrtModule = useGpu ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm')
    ort.env.wasm.wasmPaths = {
      wasm: `${BASE}ort/${useGpu ? 'ort-wasm-simd-threaded.jsep.wasm' : 'ort-wasm-simd-threaded.wasm'}`,
    }
    // GitHub Pages cannot send the cross-origin isolation headers threads need.
    ort.env.wasm.numThreads = 1
    const opts: Ort.InferenceSession.SessionOptions = {
      executionProviders: useGpu ? ['webgpu', 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'all',
    }
    const [det, rec, cls, dictText] = await Promise.all([
      ort.InferenceSession.create(`${BASE}models/det.onnx`, opts),
      ort.InferenceSession.create(`${BASE}models/rec.onnx`, opts),
      // Without the direction model, doubtful lines are read both ways round instead.
      ort.InferenceSession.create(`${BASE}models/cls.onnx`, opts).catch(() => null),
      fetch(`${BASE}models/en_dict.txt`).then((r) => r.text()),
    ])
    // The English model's classes: blank, the dictionary, then a space.
    const dict = [...dictText.split('\n').filter((l) => l.length > 0), ' ']
    const engine = new Engine(ort, det, rec, dict, cls)
    engine.backend = useGpu ? 'webgpu' : 'wasm'
    if (useGpu) {
      // The graphics processor builds its programs on a model's first run: do it now, not in a scan.
      const t1 = performance.now()
      const c = document.createElement('canvas')
      c.width = 640
      c.height = 448
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.fillStyle = '#000'
      ctx.font = 'bold 40px sans-serif'
      ctx.fillText('WARM 1234', 40, 200)
      await engine.read(c, { detLimit: 640, minConfidence: 0, maxBoxes: 4 })
      engine.warmMs = Math.round(performance.now() - t1)
    }
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
    // The straightened box does not tell which end of the line is the start. PaddleOCR's direction
    // model says, for all boxes in one go, whether each is upside down; only when it is unsure, and
    // the first read is doubtful too, is the line also read the other way round.
    const upsideDown = await this.directions(canvas, boxes)
    for (const [i, box] of boxes.entries()) {
      const dir = upsideDown[i]
      const first = dir === null ? false : dir.flipped
      let best = { ...(await this.recognize(canvas, box, first)), flipped: first }
      recs++
      if (best.confidence < 0.9 && (dir === null || dir.sure < 0.9)) {
        recs++
        const r = await this.recognize(canvas, box, !first)
        if (r.confidence > best.confidence) best = { ...r, flipped: !first }
      }
      const rotation = Math.round((box.angle * 180) / Math.PI + (best.flipped ? 180 : 0))
      if (best.text && best.confidence >= options.minConfidence) {
        reads.push({ text: cleanDigits(best.text), confidence: best.confidence, box, rotation })
      }
    }
    this.last = { detMs: Math.round(t1 - t0), recMs: Math.round(performance.now() - t1), boxes: boxes.length, recs }
    return inTextOrder(reads)
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
    const out = await this.det.run({ [this.det.inputNames[0]]: new this.ort.Tensor('float32', input, [1, 3, h, w]) })
    const prob = out[this.det.outputNames[0]].data as Float32Array
    return joinLineParts(dbBoxes(prob, w, h, canvas.width / w, canvas.height / h))
  }

  /**
   * For each box: upside down or not, and how sure (0.5-1). The model takes lines 48 x 192 pixels,
   * shorter ones padded. Null per box without the model.
   */
  private async directions(canvas: HTMLCanvasElement, boxes: Box[]): Promise<({ flipped: boolean; sure: number } | null)[]> {
    if (!this.cls || !boxes.length) return boxes.map(() => null)
    const H = 48
    const W = 192
    const input = new Float32Array(boxes.length * 3 * H * W)
    for (const [n, box] of boxes.entries()) {
      const w = Math.min(W, Math.max(8, Math.ceil((H * box.length) / box.thickness)))
      const px = drawStraightened(canvas, box, w, H, false)
      const base = n * 3 * H * W
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          for (let c = 0; c < 3; c++) input[base + c * H * W + y * W + x] = (px[i + (2 - c)] / 255 - 0.5) / 0.5
        }
      }
    }
    const out = await this.cls.run({ [this.cls.inputNames[0]]: new this.ort.Tensor('float32', input, [boxes.length, 3, H, W]) })
    const p = out[this.cls.outputNames[0]].data as Float32Array
    return boxes.map((_, n) => ({ flipped: p[n * 2 + 1] > p[n * 2], sure: Math.max(p[n * 2], p[n * 2 + 1]) }))
  }

  private async recognize(canvas: HTMLCanvasElement, box: Box, flipped: boolean) {
    const H = 48
    const w = Math.min(640, Math.max(16, Math.ceil((H * box.length) / box.thickness)))
    // The graphics processor builds programs per input size: widths are rounded up to steps of 64
    // (the rest left blank, as PaddleOCR pads), so a few sizes cover every line.
    const W = this.backend === 'webgpu' ? Math.min(640, Math.ceil(w / 64) * 64) : w
    const px = drawStraightened(canvas, box, w, H, flipped)
    const input = new Float32Array(3 * W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        for (let c = 0; c < 3; c++) input[c * W * H + y * W + x] = (px[i + (2 - c)] / 255 - 0.5) / 0.5
      }
    }
    const out = await this.rec.run({ [this.rec.inputNames[0]]: new this.ort.Tensor('float32', input, [1, 3, H, W]) })
    const t = out[this.rec.outputNames[0]]
    const [, steps, classes] = t.dims
    return ctcDecode(t.data as Float32Array, steps, classes, this.dict)
  }
}

/**
 * Where each read sits along its text's own lines: `along` (left to right as the text reads) and
 * `across` (top to bottom as the text reads), using the reads' middle slant. On a slanted label
 * the next line down can sit higher on the screen than the end of the line above it, so screen
 * position alone gives the wrong order; upside-down text reads from the bottom of the screen up.
 */
export function textAxes(reads: Pick<TextRead, 'box' | 'rotation'>[]) {
  const rotations = reads.map((r) => (r.rotation * Math.PI) / 180).sort((a, b) => a - b)
  const a = rotations.length ? rotations[Math.floor(rotations.length / 2)] : 0
  const ux = Math.cos(a), uy = Math.sin(a)
  const thick = reads.map((r) => r.box.thickness).sort((x, y) => x - y)
  return {
    along: (b: Pick<Box, 'cx' | 'cy'>) => b.cx * ux + b.cy * uy,
    across: (b: Pick<Box, 'cx' | 'cy'>) => -b.cx * uy + b.cy * ux,
    /** Lines closer than this across the text are one row. */
    row: thick.length ? thick[Math.floor(thick.length / 2)] / 2 : 0,
  }
}

/** Reads in the order a person reads the label: line by line, each left to right. */
export function inTextOrder<T extends Pick<TextRead, 'box' | 'rotation'>>(reads: T[]): T[] {
  const ax = textAxes(reads)
  return [...reads].sort((p, q) => {
    const dv = ax.across(p.box) - ax.across(q.box)
    return Math.abs(dv) < ax.row ? ax.along(p.box) - ax.along(q.box) : dv
  })
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
 * Large, sharp text is sometimes found as several boxes along one line, split at a hyphen or colon
 * ("X1404ZA-" and "-NK101"), and the two pieces touch or overlap (both hold the hyphen). Boxes at
 * about the same slant and thickness, on the same line, touching or overlapping, are joined into one
 * box. A real gap is left alone: on the phone's pictures two columns of a label sat only half a line's
 * thickness apart ("RAS-MT7902" and "5.2/5.3/6GHz").
 */
export function joinLineParts(boxes: Box[]): Box[] {
  const out = [...boxes]
  let joined = true
  while (joined) {
    joined = false
    for (let i = 0; i < out.length && !joined; i++) {
      for (let j = i + 1; j < out.length && !joined; j++) {
        const a = out[i]
        const b = out[j]
        let da = Math.abs(a.angle - b.angle) % Math.PI
        if (da > Math.PI / 2) da = Math.PI - da
        const t = Math.max(a.thickness, b.thickness)
        if (da > 0.17 || Math.min(a.thickness, b.thickness) < t * 0.6) continue
        // Along and across the line of the longer box.
        const ang = a.length >= b.length ? a.angle : b.angle
        const ux = Math.cos(ang), uy = Math.sin(ang)
        const along = (x: number, y: number) => x * ux + y * uy
        const across = (x: number, y: number) => -x * uy + y * ux
        if (Math.abs(across(a.cx, a.cy) - across(b.cx, b.cy)) > t * 0.5) continue
        const [a0, a1] = [along(a.cx, a.cy) - a.length / 2, along(a.cx, a.cy) + a.length / 2]
        const [b0, b1] = [along(b.cx, b.cy) - b.length / 2, along(b.cx, b.cy) + b.length / 2]
        const gap = Math.max(a0, b0) - Math.min(a1, b1)
        if (gap > t * 0.1) continue
        const lo = Math.min(a0, b0)
        const hi = Math.max(a1, b1)
        const mid = (lo + hi) / 2
        const acr = (across(a.cx, a.cy) + across(b.cx, b.cy)) / 2
        const box = { cx: mid * ux - acr * uy, cy: mid * uy + acr * ux, length: hi - lo, thickness: t, angle: ang }
        const corners = boxCorners(box)
        const xs = corners.map((c) => c[0])
        const ys = corners.map((c) => c[1])
        const x = Math.max(0, Math.min(...xs))
        const y = Math.max(0, Math.min(...ys))
        out[i] = {
          ...box,
          x,
          y,
          w: Math.max(a.x + a.w, b.x + b.w, Math.max(...xs)) - x,
          h: Math.max(a.y + a.h, b.y + b.h, Math.max(...ys)) - y,
          score: Math.min(a.score, b.score),
        }
        out.splice(j, 1)
        joined = true
      }
    }
  }
  return out
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
