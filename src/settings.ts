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
  /** Chosen camera; empty: the back camera that focuses closest (see probeCameras). */
  cameraId: string
  /** Search for the sharpest focus when a scan starts (phones that let the site move the lens). */
  focusSweep: boolean
  /** Camera frames to wait after moving the lens before measuring (one frame is about 33 ms). */
  focusSettleFrames: number
  /** The app's own magnification of the picture (1-4): only the middle is shown and read. */
  viewZoom: number
  /** single: one scan, then the report. continuous: keeps reading and writes down every new text. */
  mode: 'single' | 'continuous'
}

export const defaults: Settings = {
  scriptUrl: '',
  scriptKey: '',
  preprocess: true,
  hardware: true,
  voting: true,
  voteFrames: 3,
  blurThreshold: 20,
  exposureComp: 0,
  detLimit: 960,
  minConfidence: 0.5,
  timeoutSec: 12,
  tester: '',
  aimBox: true,
  cameraHeight: 2160,
  cameraId: '',
  focusSweep: true,
  focusSettleFrames: 1,
  viewZoom: 2,
  mode: 'single',
}

const KEY = 'scanner-settings'
/**
 * Raised when a default changes that saved settings should take: values saved by an older version
 * for the keys below are replaced by the new defaults once.
 */
const VERSION = 2
const RESET_IN: Record<number, (keyof Settings)[]> = { 2: ['blurThreshold', 'cameraHeight'] }

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const from = saved.version ?? 1
    for (let v = from + 1; v <= VERSION; v++) for (const k of RESET_IN[v] ?? []) delete saved[k]
    delete saved.version
    return { ...defaults, ...saved }
  } catch {
    return defaults
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify({ ...s, version: VERSION }))
}

/** Short name of the active combination, e.g. "P1 H0 V1 F1 T1". Torch is part of it. */
export function setupName(s: Pick<Settings, 'preprocess' | 'hardware' | 'voting' | 'focusSweep'>, torch: boolean): string {
  return `P${+s.preprocess} H${+s.hardware} V${+s.voting} F${+s.focusSweep} T${+torch}`
}
