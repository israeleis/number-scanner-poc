// PaddleOCR in the browser: PP-OCRv4 text detection (DB) and PP-OCRv3 English recognition (CTC),
// both run with ONNX Runtime Web on WebAssembly.
import * as ort from 'onnxruntime-web/wasm'
import { ctcDecode } from './ctc'

const BASE = import.meta.env.BASE_URL

export interface Box {
  x: number
  y: number
  w: number
  h: number
  score: number
}

export interface TextRead {
  text: string
  confidence: number
  box: Box
  /** How the crop was turned to read it: 0, 180, 90 (clockwise) or -90. */
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

export class Engine {
  loadMs = 0
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
    const boxes = (await this.detect(canvas, options.detLimit))
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, options.maxBoxes)
    const reads: TextRead[] = []
    for (const box of boxes) {
      // The model reads left to right only. Tall boxes are vertical text: try both quarter turns.
      // A wide box read with doubt may be upside down: try it turned half way too.
      const tall = box.h > box.w * 1.5
      let best = { ...(await this.recognize(canvas, box, tall ? 90 : 0)), rotation: tall ? 90 : 0 }
      for (const rotation of tall ? [-90] : best.confidence < 0.9 ? [180] : []) {
        const r = await this.recognize(canvas, box, rotation)
        if (r.confidence > best.confidence) best = { ...r, rotation }
      }
      if (best.text && best.confidence >= options.minConfidence) reads.push({ ...best, box })
    }
    // Top to bottom, then right to left in a row is not needed: Latin text reads left to right.
    return reads.sort((a, b) => (Math.abs(a.box.y - b.box.y) < a.box.h / 2 ? a.box.x - b.box.x : a.box.y - b.box.y))
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
    return dbBoxes(prob, w, h).map((b) => ({
      x: (b.x * canvas.width) / w,
      y: (b.y * canvas.height) / h,
      w: (b.w * canvas.width) / w,
      h: (b.h * canvas.height) / h,
      score: b.score,
    }))
  }

  private async recognize(canvas: HTMLCanvasElement, box: Box, rotation: number) {
    const H = 48
    const quarter = Math.abs(rotation) === 90
    const [bw, bh] = quarter ? [box.h, box.w] : [box.w, box.h]
    const W = Math.min(640, Math.max(16, Math.ceil((H * bw) / bh)))
    const px = drawScaled(canvas, box.x, box.y, box.w, box.h, W, H, rotation)
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

/** Draws the source rectangle into a w x h image, turned by `rotation` degrees clockwise. */
function drawScaled(
  src: HTMLCanvasElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  w: number,
  h: number,
  rotation = 0,
) {
  scratch ??= document.createElement('canvas')
  scratch.width = w
  scratch.height = h
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.translate(w / 2, h / 2)
  ctx.rotate((rotation * Math.PI) / 180)
  // After a quarter turn the drawn rectangle is h wide and w high.
  const [dw, dh] = Math.abs(rotation) === 90 ? [h, w] : [w, h]
  ctx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh)
  return ctx.getImageData(0, 0, w, h).data
}

/**
 * DB post-processing: threshold the probability map, take connected regions, keep the ones whose
 * mean probability is high enough, and grow each box (the model predicts shrunk text regions).
 * Boxes are axis-aligned; strongly rotated text is not straightened.
 */
export function dbBoxes(prob: Float32Array, w: number, h: number, thresh = 0.3, boxThresh = 0.6, unclip = 1.6): Box[] {
  const seen = new Uint8Array(w * h)
  const boxes: Box[] = []
  const stack: number[] = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= thresh) continue
    let minX = w, minY = h, maxX = 0, maxY = 0, sum = 0, count = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i / w) | 0
      sum += prob[i]
      count++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (const n of [i - 1, i + 1, i - w, i + w]) {
        if (n < 0 || n >= w * h || seen[n] || prob[n] <= thresh) continue
        if ((n === i - 1 && x === 0) || (n === i + 1 && x === w - 1)) continue
        seen[n] = 1
        stack.push(n)
      }
    }
    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    if (count < 10 || Math.min(bw, bh) < 3 || sum / count < boxThresh) continue
    const d = (bw * bh * unclip) / (2 * (bw + bh))
    const x0 = Math.max(0, minX - d)
    const y0 = Math.max(0, minY - d)
    const x1 = Math.min(w, maxX + 1 + d)
    const y1 = Math.min(h, maxY + 1 + d)
    boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: sum / count })
  }
  return boxes
}
