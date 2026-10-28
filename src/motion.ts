// Is the phone moving? From the gyroscope where the browser gives it (rotation speed), and from how
// much the picture changed since the last frame (works everywhere). Reading waits for a steady phone.

let gyro: { speed: number; at: number } | null = null
let listening = false

function onMotion(e: DeviceMotionEvent) {
  const r = e.rotationRate
  if (!r || r.alpha === null) return
  gyro = { speed: Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0), at: performance.now() }
}

/** Starts listening to the gyroscope. iPhone asks permission, so call it from a tap. */
export async function startMotion() {
  if (listening || typeof DeviceMotionEvent === 'undefined') return
  const ask = (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission
  if (ask) {
    try {
      if ((await ask()) !== 'granted') return
    } catch {
      return
    }
  }
  window.addEventListener('devicemotion', onMotion)
  listening = true
}

/** Rotation speed in degrees per second, or undefined when no recent reading. */
export function gyroSpeed(): number | undefined {
  return gyro && performance.now() - gyro.at < 250 ? Math.round(gyro.speed) : undefined
}

/** Mean difference (0-255) between this small grey picture and the previous one given. */
export class FrameDiff {
  private prev: Uint8Array | null = null

  next(gray: Uint8Array): number {
    const p = this.prev
    this.prev = gray
    if (!p || p.length !== gray.length) return 0
    let sum = 0
    for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - p[i])
    return sum / gray.length
  }
}

/** A 64-pixel-wide grey copy of the frame, for comparing frames. */
export function smallGray(frame: HTMLCanvasElement): Uint8Array {
  const w = 64
  const h = Math.max(1, Math.round((frame.height / frame.width) * w))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(frame, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h).data
  const g = new Uint8Array(w * h)
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000
  return g
}

export interface MotionSettings {
  waitSteady: boolean
  /** Degrees per second above which the phone is moving. */
  gyroThreshold: number
  /** Mean picture change (0-255) above which the phone is moving. */
  diffThreshold: number
  /** How long it must be steady before reading. */
  steadyMs: number
}

/** Follows frames and says whether reading may go ahead now. */
export class SteadyGate {
  private diff = new FrameDiff()
  private movedAt = -Infinity
  private s: MotionSettings

  constructor(s: MotionSettings) {
    this.s = s
  }

  /** `now` in ms. Returns the measures and whether the phone has been steady long enough. */
  check(frame: HTMLCanvasElement, now: number) {
    return this.judge(this.diff.next(smallGray(frame)), gyroSpeed(), now)
  }

  judge(diff: number, gyro: number | undefined, now: number) {
    const moving = diff > this.s.diffThreshold || (gyro !== undefined && gyro > this.s.gyroThreshold)
    if (moving) this.movedAt = now
    const steady = !this.s.waitSteady || now - this.movedAt >= this.s.steadyMs
    return { moving, steady, diff: Math.round(diff * 10) / 10, gyro }
  }
}
