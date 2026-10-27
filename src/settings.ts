export interface Settings {
  scriptUrl: string
  scriptKey: string
  preprocess: boolean
  hardware: boolean
  voting: boolean
  /** Sharp frames collected before voting gives a result. */
  voteFrames: number
  /** Laplacian variance below this: the frame is too blurred to read. */
  blurThreshold: number
  exposureComp: number
  detLimit: number
  minConfidence: number
  timeoutSec: number
  tester: string
  /** Read only the aiming box in the middle of the screen, at full camera resolution. */
  aimBox: boolean
  /** Short side of the camera picture asked for: 1080, 1440 or 2160. */
  cameraHeight: number
  /** Chosen camera; empty: the default back camera. */
  cameraId: string
}

export const defaults: Settings = {
  scriptUrl: '',
  scriptKey: '',
  preprocess: true,
  hardware: true,
  voting: true,
  voteFrames: 3,
  blurThreshold: 40,
  exposureComp: 0,
  detLimit: 960,
  minConfidence: 0.5,
  timeoutSec: 12,
  tester: '',
  aimBox: true,
  cameraHeight: 1080,
  cameraId: '',
}

const KEY = 'scanner-settings'

export function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return defaults
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s))
}

/** Short name of the active combination, e.g. "P1 H0 V1 T1". Torch is part of it. */
export function setupName(s: Pick<Settings, 'preprocess' | 'hardware' | 'voting'>, torch: boolean): string {
  return `P${+s.preprocess} H${+s.hardware} V${+s.voting} T${+torch}`
}
