import type { FrameLog } from './scanner'

// Scans are kept on the phone (IndexedDB) and sent to the Apps Script web app when it is set up
// and the network is up. A scan is marked sent only after the script confirms it.

/** correct: every line right and none missed. not_read: no text read at all. */
export type Outcome = 'correct' | 'wrong' | 'not_read'

export interface Line {
  /** 1 is the top line. */
  line: number
  /** What the scan read; empty for a line it missed. */
  read: string
  /** What is really written (optional for a right read). */
  actual: string
  outcome: 'correct' | 'wrong' | 'missed'
  confidence: number | null
  frames: number | null
  agreement: number | null
  /** The words of the line, each searchable on its own. */
  words: string[]
  /** Continuous scanning: the label it belongs to (1 is the first), when that label was written
   * down (ms from the start), and the index of the label's picture. */
  item: number | null
  atMs: number | null
  crop: number | null
}

export interface ScanRecord {
  id: string
  mode: 'single' | 'continuous'
  /** Continuous scanning: how long the run lasted. */
  durationMs: number | null
  createdAt: string
  tester: string
  setup: string
  preprocess: boolean
  hardware: boolean
  voting: boolean
  torch: boolean
  /** The app's magnification of the picture. */
  zoom: number
  voteFrames: number
  blurThreshold: number
  detLimit: number
  minConfidence: number
  outcome: Outcome
  /** Every line read, top to bottom, e.g. "6 | Gizo | Nishnianidze St." */
  summary: string
  lines: Line[]
  /** The single frame kept as the image, with each read and its box (pixels of that image). */
  frameReads: { text: string; confidence: number; box: { cx: number; cy: number; length: number; thickness: number }; rotation: number }[]
  framesRead: number
  framesBlurry: number
  sharpness: number
  timeToResultMs: number | null
  modelLoadMs: number
  scene: string[]
  notes: string
  device: string
  resolution: string
  /** Only the aiming box was read (the images are of that box only). */
  aimBox: boolean
  camera: string
  /** The closest that camera can focus, in metres (null: unknown). */
  cameraMinFocus: number | null
  focusSweep: boolean
  /** Each focus search: when it started, chosen distance (metres), sharpness, time, and every step. */
  focusSweeps: { at: number; distance: number; sharpness: number; ms: number; kind: string; samples: [number, number][] }[]
  /** Every camera frame of the scan (first 400): time, sharpness, and where the reading time went. */
  frameLog: FrameLog[]
  cameraSupports: string[]
  hardwareApplied: string[]
  appVersion: string
}

export interface StoredScan {
  record: ScanRecord
  original: Blob
  processed: Blob | null
  /** Continuous scanning: a picture of each label written down. */
  crops?: Blob[]
  synced: boolean
  syncError?: string
}

const DB = 'scanner'
const STORE = 'scans'

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'record.id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export const putScan = (s: StoredScan) => tx('readwrite', (st) => st.put(s))
export const allScans = () => tx<StoredScan[]>('readonly', (st) => st.getAll())
export const clearScans = () => tx('readwrite', (st) => st.clear())

function toBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

let syncing = false

/** Sends every scan not yet sent. Returns how many are still waiting. */
export async function syncPending(url: string, key: string): Promise<number> {
  const pending = (await allScans()).filter((s) => !s.synced)
  if (!url || syncing || !navigator.onLine) return pending.length
  syncing = true
  let left = pending.length
  try {
    for (const s of pending) {
      try {
        const body = JSON.stringify({
          key,
          record: s.record,
          original: await toBase64(s.original),
          processed: s.processed ? await toBase64(s.processed) : '',
          crops: await Promise.all((s.crops ?? []).map(toBase64)),
        })
        // text/plain keeps this a "simple" request: Apps Script cannot answer a CORS preflight.
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body })
        const out = await res.json()
        if (!out.ok) throw new Error(out.error ?? 'script error')
        await putScan({ ...s, synced: true, syncError: undefined })
        left--
      } catch (e) {
        await putScan({ ...s, syncError: String(e) })
        break
      }
    }
  } finally {
    syncing = false
  }
  return left
}

/** Checks the URL and key without saving anything. */
export async function testConnection(url: string, key: string): Promise<string> {
  const res = await fetch(`${url}?key=${encodeURIComponent(key)}`)
  const out = await res.json()
  return out.ok ? `מחובר: ${out.sheet}` : `שגיאה: ${out.error}`
}
