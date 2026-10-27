// One scan: take frames from the camera until there is a result or time runs out.
import type { Engine, TextRead } from './ocr/engine'
import { laplacianVariance, preprocess, toGray } from './ocr/imageops'
import { inReadingOrder, vote, type FrameRead, type VotedRead } from './ocr/vote'
import type { Settings } from './settings'

export interface ScanProgress {
  sharpness: number
  framesRead: number
  framesBlurry: number
  lastReads: TextRead[]
}

export interface ScanResult {
  reads: VotedRead[]
  original: HTMLCanvasElement
  processed: HTMLCanvasElement | null
  frameReads: TextRead[]
  framesRead: number
  framesBlurry: number
  sharpness: number
  timeToResultMs: number | null
}

const MAX_SIDE = 1280

function grab(video: HTMLVideoElement): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight))
  const c = document.createElement('canvas')
  c.width = Math.round(video.videoWidth * scale)
  c.height = Math.round(video.videoHeight * scale)
  c.getContext('2d', { willReadFrequently: true })!.drawImage(video, 0, 0, c.width, c.height)
  return c
}

/** Sharpness of the middle of the frame, measured on a 320-pixel-wide copy. */
export function sharpnessOf(frame: HTMLCanvasElement): number {
  const w = 320
  const h = Math.round((frame.height / frame.width) * w)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(frame, frame.width * 0.15, frame.height * 0.15, frame.width * 0.7, frame.height * 0.7, 0, 0, w, h)
  return laplacianVariance(toGray(ctx.getImageData(0, 0, w, h)), w, h)
}

function processedCopy(frame: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = frame.width
  c.height = frame.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(frame, 0, 0)
  const img = ctx.getImageData(0, 0, c.width, c.height)
  preprocess(img)
  ctx.putImageData(img, 0, 0)
  return c
}

const nextFrame = () => new Promise((r) => setTimeout(r, 30))

export async function runScan(
  video: HTMLVideoElement,
  engine: Engine,
  s: Settings,
  onProgress: (p: ScanProgress) => void,
  signal: { stopped: boolean },
): Promise<ScanResult> {
  const start = performance.now()
  const reads: FrameRead[] = []
  let framesRead = 0
  let framesBlurry = 0
  let framesWithText = 0
  let sharpSum = 0
  let best: { score: number; original: HTMLCanvasElement; processed: HTMLCanvasElement | null; reads: TextRead[] } | null = null
  let last: HTMLCanvasElement | null = null
  let doneAt: number | null = null

  while (!signal.stopped && performance.now() - start < s.timeoutSec * 1000) {
    const frame = grab(video)
    last = frame
    const sharp = sharpnessOf(frame)
    if (sharp < s.blurThreshold) {
      framesBlurry++
      onProgress({ sharpness: sharp, framesRead, framesBlurry, lastReads: [] })
      await nextFrame()
      continue
    }
    const processed = s.preprocess ? processedCopy(frame) : null
    const frameReads = await engine.read(processed ?? frame, {
      detLimit: s.detLimit,
      minConfidence: s.minConfidence,
      maxBoxes: 12,
    })
    framesRead++
    sharpSum += sharp
    onProgress({ sharpness: sharp, framesRead, framesBlurry, lastReads: frameReads })
    if (frameReads.length) {
      framesWithText++
      const weight = sharp / (sharp + s.blurThreshold)
      for (const r of frameReads) {
        reads.push({
          text: r.text,
          confidence: r.confidence,
          weight,
          frame: framesRead,
          x: (r.box.x + r.box.w / 2) / frame.width,
          y: (r.box.y + r.box.h / 2) / frame.height,
          h: r.box.h / frame.height,
        })
      }
      const score = frameReads.reduce((a, r) => a + r.confidence, 0) * weight
      if (!best || score > best.score) best = { score, original: frame, processed, reads: frameReads }
      if (!s.voting || framesWithText >= s.voteFrames) {
        doneAt = performance.now()
        break
      }
    }
    await nextFrame()
  }

  let voted = vote(reads)
  // With voting, a text seen in only one frame is noise, unless only one frame had any text.
  if (s.voting && framesWithText >= 2) voted = voted.filter((v) => v.frames >= 2)
  const original = best?.original ?? last ?? grab(video)
  if (voted.length && doneAt === null) doneAt = performance.now()
  return {
    reads: inReadingOrder(voted),
    original,
    processed: best ? best.processed : s.preprocess ? processedCopy(original) : null,
    frameReads: best?.reads ?? [],
    framesRead,
    framesBlurry,
    sharpness: framesRead ? Math.round(sharpSum / framesRead) : 0,
    timeToResultMs: doneAt === null ? null : Math.round(doneAt - start),
  }
}
