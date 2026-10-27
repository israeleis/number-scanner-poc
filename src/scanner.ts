// One scan: take frames from the camera until there is a result or time runs out.
import type { Engine, TextRead } from './ocr/engine'
import { laplacianVariance, preprocess, toGray } from './ocr/imageops'
import { inReadingOrder, vote, type FrameRead, type VotedRead } from './ocr/vote'
import type { Settings } from './settings'

/** A rectangle in video pixels. */
export interface Region {
  x: number
  y: number
  w: number
  h: number
}

/** Share of the visible picture's width and height the aiming box covers. */
export const AIM_W = 0.8
export const AIM_H = 0.3

/**
 * The part of the video that is visible in an element of `elW` x `elH` shown with object-fit: cover,
 * reduced to its middle `fw` x `fh` share.
 */
export function aimRegion(videoW: number, videoH: number, elW: number, elH: number, fw: number, fh: number): Region {
  const s = Math.max(elW / videoW, elH / videoH)
  const visW = elW / s
  const visH = elH / s
  const w = visW * fw
  const h = visH * fh
  return { x: (videoW - w) / 2, y: (videoH - h) / 2, w, h }
}

export interface ScanProgress {
  sharpness: number
  framesRead: number
  framesBlurry: number
  lastReads: TextRead[]
  /** The part of the video that was read, and how much it was scaled down. */
  region: Region
  scale: number
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

export function frameScale(r: Region) {
  return Math.min(1, MAX_SIDE / Math.max(r.w, r.h))
}

function grab(video: HTMLVideoElement, r: Region): HTMLCanvasElement {
  const scale = frameScale(r)
  const c = document.createElement('canvas')
  c.width = Math.round(r.w * scale)
  c.height = Math.round(r.h * scale)
  c.getContext('2d', { willReadFrequently: true })!.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height)
  return c
}

function regionOf(video: HTMLVideoElement, aimBox: boolean): Region {
  const full = { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight }
  if (!aimBox || !video.clientWidth) return full
  return aimRegion(video.videoWidth, video.videoHeight, video.clientWidth, video.clientHeight, AIM_W, AIM_H)
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
    const region = regionOf(video, s.aimBox)
    const scale = frameScale(region)
    const frame = grab(video, region)
    last = frame
    const sharp = sharpnessOf(frame)
    if (sharp < s.blurThreshold) {
      framesBlurry++
      onProgress({ sharpness: sharp, framesRead, framesBlurry, lastReads: [], region, scale })
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
    onProgress({ sharpness: sharp, framesRead, framesBlurry, lastReads: frameReads, region, scale })
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
  const original = best?.original ?? last ?? grab(video, regionOf(video, s.aimBox))
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
