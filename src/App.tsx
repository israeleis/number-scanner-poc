import { useCallback, useEffect, useRef, useState } from 'react'
import {
  capabilities,
  listCameras,
  openCamera,
  setFocus,
  setHardware,
  setTorch,
  setZoom,
  supportedList,
  trackResolution,
  type CameraCaps,
  type CameraChoice,
} from './camera'
import { loadEngine, type Engine } from './ocr/engine'
import { AIM_H, AIM_W, runScan, type ScanProgress, type ScanResult } from './scanner'
import { loadSettings, saveSettings, setupName, type Settings } from './settings'
import { allScans, putScan, syncPending, testConnection, type Line, type Outcome, type StoredScan } from './store'

declare const __BUILD__: string

const SCENES = ['יום', 'שמש ישירה', 'צל', 'ערב', 'לילה', 'תאורה פנימית', 'סנוור', 'רחוק', 'קרוב', 'זווית', 'תנועה', 'מסך']

type Screen = 'scan' | 'report' | 'settings' | 'log'

export default function App() {
  const [settings, setSettingsState] = useState<Settings>(loadSettings)
  const [screen, setScreen] = useState<Screen>('scan')
  const [engine, setEngine] = useState<Engine | null>(null)
  const [engineError, setEngineError] = useState('')
  const [track, setTrack] = useState<MediaStreamTrack | null>(null)
  const [caps, setCaps] = useState<CameraCaps>({})
  const [cameraError, setCameraError] = useState('')
  const [hwApplied, setHwApplied] = useState<string[]>([])
  const [torch, setTorchState] = useState(false)
  const [zoom, setZoomState] = useState<number | null>(null)
  /** Manual focus distance; null: continuous autofocus. */
  const [focus, setFocusState] = useState<number | null>(null)
  const [cameras, setCameras] = useState<CameraChoice[]>([])
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [scans, setScans] = useState<StoredScan[]>([])
  const [pending, setPending] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const stopRef = useRef({ stopped: false })

  const setSettings = (s: Settings) => {
    setSettingsState(s)
    saveSettings(s)
  }

  const refreshScans = useCallback(async () => {
    const all = await allScans()
    setScans(all.sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt)))
    setPending(all.filter((s) => !s.synced).length)
  }, [])

  const sync = useCallback(async () => {
    await syncPending(settings.scriptUrl, settings.scriptKey)
    await refreshScans()
  }, [settings.scriptUrl, settings.scriptKey, refreshScans])

  useEffect(() => {
    loadEngine().then(setEngine, (e) => setEngineError(String(e)))
    refreshScans()
  }, [refreshScans])

  // Retry sending every 30 seconds and when the network comes back.
  useEffect(() => {
    sync()
    const t = setInterval(sync, 30000)
    window.addEventListener('online', sync)
    return () => {
      clearInterval(t)
      window.removeEventListener('online', sync)
    }
  }, [sync])

  // The camera stays open while the app is open; the video element lives on the scan screen only.
  useEffect(() => {
    if (screen !== 'scan' || !videoRef.current) return
    let cancelled = false
    let opened: MediaStreamTrack | null = null
    openCamera(videoRef.current, settings.cameraId, settings.cameraHeight).then(
      async (t) => {
        if (cancelled) return t.stop()
        opened = t
        setTrack(t)
        const c = capabilities(t)
        setCaps(c)
        setZoomState(c.zoom ? (t.getSettings() as { zoom?: number }).zoom ?? c.zoom.min : null)
        setCameraError('')
        setCameras(await listCameras())
      },
      (e) => setCameraError(String(e)),
    )
    return () => {
      cancelled = true
      opened?.stop()
      setTrack(null)
      setTorchState(false)
      setFocusState(null)
    }
  }, [screen, settings.cameraId, settings.cameraHeight])

  useEffect(() => {
    if (track) setHardware(track, settings.hardware, settings.exposureComp).then(setHwApplied)
  }, [track, settings.hardware, settings.exposureComp])

  const setup = setupName(settings, torch)
  const setupCount = scans.filter((s) => s.record.setup === setup).length

  async function startScan() {
    if (!engine || !videoRef.current || scanning) return
    stopRef.current = { stopped: false }
    setScanning(true)
    setProgress(null)
    try {
      const r = await runScan(videoRef.current, engine, settings, setProgress, stopRef.current)
      setResult(r)
      setScreen('report')
    } finally {
      setScanning(false)
    }
  }

  async function saveReport(fields: ReportFields) {
    if (!result) return
    const toBlob = (c: HTMLCanvasElement) =>
      new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.9))
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      tester: settings.tester,
      setup,
      preprocess: settings.preprocess,
      hardware: settings.hardware,
      voting: settings.voting,
      torch,
      zoom,
      voteFrames: settings.voteFrames,
      blurThreshold: settings.blurThreshold,
      detLimit: settings.detLimit,
      minConfidence: settings.minConfidence,
      ...fields,
      frameReads: result.frameReads.map((r) => ({
        text: r.text,
        confidence: round(r.confidence),
        box: { x: Math.round(r.box.x), y: Math.round(r.box.y), w: Math.round(r.box.w), h: Math.round(r.box.h) },
        rotation: r.rotation,
      })),
      framesRead: result.framesRead,
      framesBlurry: result.framesBlurry,
      sharpness: result.sharpness,
      timeToResultMs: result.timeToResultMs,
      modelLoadMs: engine?.loadMs ?? 0,
      device: navigator.userAgent,
      resolution: track ? trackResolution(track) : '',
      aimBox: settings.aimBox,
      camera: track?.label ?? '',
      focusDistance: focus,
      cameraSupports: supportedList(caps),
      hardwareApplied: hwApplied,
      appVersion: __BUILD__,
    }
    await putScan({
      record,
      original: await toBlob(result.original),
      processed: result.processed ? await toBlob(result.processed) : null,
      synced: false,
    })
    setResult(null)
    setScreen('scan')
    await refreshScans()
    sync()
  }

  return (
    <div className="app">
      <header className="bar">
        <button onClick={() => setScreen('settings')} aria-label="הגדרות">⚙</button>
        <button onClick={() => setScreen('log')} className="pill">
          {pending ? `${pending} ממתינות לשליחה` : 'הכל נשלח'}
        </button>
        <span className="setup">
          הגדרה <b dir="ltr">{setup}</b> · {setupCount} סריקות
        </span>
      </header>

      {screen === 'scan' && (
        <main className="scan">
          <div className="viewfinder">
            <video ref={videoRef} playsInline muted />
            {settings.aimBox && (
              <div className="aim" style={{ width: `${AIM_W * 100}%`, height: `${AIM_H * 100}%` }} />
            )}
            {scanning && progress && <LiveBoxes video={videoRef.current} progress={progress} />}
          </div>
          {cameraError && <p className="error">המצלמה לא נפתחה: {cameraError}</p>}
          {engineError && <p className="error">המודל לא נטען: {engineError}</p>}
          {!engine && !engineError && <p className="hint">טוען את מודל הזיהוי… (רק בפעם הראשונה זה לוקח זמן)</p>}

          <div className="toggles">
            <Toggle label="עיבוד תמונה" on={settings.preprocess} set={(v) => setSettings({ ...settings, preprocess: v })} />
            <Toggle label="בקרת מצלמה" on={settings.hardware} set={(v) => setSettings({ ...settings, hardware: v })} />
            <Toggle label="הצבעה" on={settings.voting} set={(v) => setSettings({ ...settings, voting: v })} />
            {caps.torch && (
              <Toggle
                label="פנס"
                on={torch}
                set={async (v) => {
                  if (track && (await setTorch(track, v))) setTorchState(v)
                }}
              />
            )}
          </div>

          {caps.zoom && zoom !== null && (
            <div className="quick">
              {[1, 2, 3, 4, 6]
                .filter((z) => z >= caps.zoom!.min && z <= caps.zoom!.max)
                .map((z) => (
                  <button
                    key={z}
                    className={Math.abs(zoom - z) < 0.05 ? 'chip on' : 'chip'}
                    onClick={() => {
                      setZoomState(z)
                      if (track) setZoom(track, z)
                    }}
                  >
                    ×{z}
                  </button>
                ))}
            </div>
          )}

          {caps.focusDistance && caps.focusMode?.includes('manual') && (
            <div className="quick">
              <button
                className={focus === null ? 'chip on' : 'chip'}
                onClick={async () => {
                  if (track && (await setFocus(track, null))) setFocusState(null)
                }}
              >
                פוקוס אוטו
              </button>
              <label className="zoom">
                פוקוס {focus === null ? 'אוטו' : `${Math.round(focus * 100)} ס״מ`}
                <input
                  type="range"
                  min={caps.focusDistance.min}
                  max={Math.min(caps.focusDistance.max, 1)}
                  step={caps.focusDistance.step || 0.01}
                  value={focus ?? caps.focusDistance.min}
                  onChange={(e) => {
                    const d = Number(e.target.value)
                    setFocusState(d)
                    if (track) setFocus(track, d)
                  }}
                />
              </label>
            </div>
          )}

          {caps.zoom && zoom !== null && (
            <label className="zoom">
              זום {zoom.toFixed(1)}
              <input
                type="range"
                min={caps.zoom.min}
                max={caps.zoom.max}
                step={caps.zoom.step || 0.1}
                value={zoom}
                onChange={(e) => {
                  const z = Number(e.target.value)
                  setZoomState(z)
                  if (track) setZoom(track, z)
                }}
              />
            </label>
          )}

          {scanning ? (
            <>
              <p className="hint">
                חדות {Math.round(progress?.sharpness ?? 0)} · נקראו {progress?.framesRead ?? 0} פריימים · מטושטשים{' '}
                {progress?.framesBlurry ?? 0}
              </p>
              <button className="big stop" onClick={() => (stopRef.current.stopped = true)}>
                עצור
              </button>
            </>
          ) : (
            <button className="big" disabled={!engine || !track} onClick={startScan}>
              סרוק
            </button>
          )}
        </main>
      )}

      {screen === 'report' && result && (
        <Report result={result} onSave={saveReport} onCancel={() => { setResult(null); setScreen('scan') }} />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          settings={settings}
          setSettings={setSettings}
          supports={supportedList(caps)}
          cameras={cameras}
          resolution={track ? trackResolution(track) : ''}
          hwApplied={hwApplied}
          loadMs={engine?.loadMs ?? null}
          onBack={() => setScreen('scan')}
        />
      )}

      {screen === 'log' && <Log scans={scans} onSync={sync} onBack={() => setScreen('scan')} />}
    </div>
  )
}

const round = (n: number) => Math.round(n * 1000) / 1000

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button className={on ? 'chip on' : 'chip'} aria-pressed={on} onClick={() => set(!on)}>
      {label} {on ? 'פועל' : 'כבוי'}
    </button>
  )
}

/** Boxes of the last frame read, drawn over the live video (which is shown with object-fit: cover). */
function LiveBoxes({ video, progress }: { video: HTMLVideoElement | null; progress: ScanProgress }) {
  if (!video || !video.videoWidth) return null
  const { region, scale } = progress
  const vw = video.clientWidth
  const vh = video.clientHeight
  const s = Math.max(vw / video.videoWidth, vh / video.videoHeight)
  const ox = (vw - video.videoWidth * s) / 2
  const oy = (vh - video.videoHeight * s) / 2
  return (
    <div className="overlay">
      {progress.lastReads.map((r, i) => (
        <div
          key={i}
          className="livebox"
          style={{
            left: ox + (region.x + r.box.x / scale) * s,
            top: oy + (region.y + r.box.y / scale) * s,
            width: (r.box.w / scale) * s,
            height: (r.box.h / scale) * s,
          }}
        >
          <span dir="ltr">{r.text}</span>
        </div>
      ))}
    </div>
  )
}

interface ReportFields {
  outcome: Outcome
  summary: string
  lines: Line[]
  scene: string[]
  notes: string
}

/** A line on the report screen before it is saved. `key` only keeps React rows stable. */
interface DraftLine {
  key: number
  read: string
  actual: string
  mark: 'correct' | 'wrong' | null
  missed: boolean
  confidence: number | null
  frames: number | null
  agreement: number | null
}

let nextKey = 0

function Report({ result, onSave, onCancel }: { result: ScanResult; onSave: (f: ReportFields) => void; onCancel: () => void }) {
  const [lines, setLines] = useState<DraftLine[]>(() =>
    result.reads.map((r) => ({
      key: nextKey++,
      read: r.text,
      actual: '',
      mark: null,
      missed: false,
      confidence: round(r.confidence),
      frames: r.frames,
      agreement: round(r.agreement),
    })),
  )
  const [scene, setScene] = useState<string[]>(() => JSON.parse(localStorage.getItem('last-scene') ?? '[]'))
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const image = (() => {
    const c = document.createElement('canvas')
    c.width = result.original.width
    c.height = result.original.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(result.original, 0, 0)
    ctx.lineWidth = Math.max(2, c.width / 400)
    ctx.strokeStyle = '#00e676'
    for (const r of result.frameReads) ctx.strokeRect(r.box.x, r.box.y, r.box.w, r.box.h)
    return c.toDataURL('image/jpeg', 0.8)
  })()

  const update = (key: number, patch: Partial<DraftLine>) =>
    setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  /** Adds an empty "missed" line after position `at` (-1: at the top). */
  const addMissed = (at: number) => {
    const blank: DraftLine = { key: nextKey++, read: '', actual: '', mark: null, missed: true, confidence: null, frames: null, agreement: null }
    setLines([...lines.slice(0, at + 1), blank, ...lines.slice(at + 1)])
  }
  const toggleScene = (s: string) => setScene(scene.includes(s) ? scene.filter((x) => x !== s) : [...scene, s])

  const readLines = lines.filter((l) => !l.missed)
  const missedLines = lines.filter((l) => l.missed && l.actual.trim())
  const ready = readLines.every((l) => l.mark)

  function save() {
    const kept = lines.filter((l) => !l.missed || l.actual.trim())
    const saved: Line[] = kept.map((l, i) => ({
      line: i + 1,
      read: l.read,
      actual: l.missed ? l.actual.trim() : l.actual.trim() || (l.mark === 'correct' ? l.read : ''),
      outcome: l.missed ? 'missed' : l.mark!,
      confidence: l.confidence,
      frames: l.frames,
      agreement: l.agreement,
    }))
    const outcome: Outcome = !readLines.length
      ? 'not_read'
      : saved.every((l) => l.outcome === 'correct')
        ? 'correct'
        : 'wrong'
    setSaving(true)
    localStorage.setItem('last-scene', JSON.stringify(scene))
    onSave({ outcome, summary: readLines.map((l) => l.read).join(' | '), lines: saved, scene, notes })
  }

  return (
    <main className="report">
      <img src={image} alt="הפריים שנקרא" />
      <p className="hint">
        {result.timeToResultMs === null ? 'לא זוהה בזמן' : `תוצאה אחרי ${(result.timeToResultMs / 1000).toFixed(1)} שניות`} ·{' '}
        {result.framesRead} פריימים נקראו · {result.framesBlurry} מטושטשים
      </p>

      {!readLines.length && <p className="big-text">לא זוהה כלום</p>}
      {readLines.length > 1 && (
        <button className="link" onClick={() => setLines(lines.map((l) => (l.missed ? l : { ...l, mark: 'correct' })))}>
          סמן את כל השורות ✓
        </button>
      )}

      <AddLine onClick={() => addMissed(-1)} />
      {lines.map((l, i) => (
        <div key={l.key}>
          {l.missed ? (
            <div className="line missed">
              <span className="tag">שורה שפוספסה</span>
              <input dir="ltr" placeholder="מה כתוב" value={l.actual} autoFocus onChange={(e) => update(l.key, { actual: e.target.value })} />
              <button className="link" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>הסר</button>
            </div>
          ) : (
            <div className={`line ${l.mark ?? ''}`}>
              <div className="line-head">
                <span dir="ltr" className="text">{l.read}</span>
                <span className="marks">
                  <button className={l.mark === 'correct' ? 'ok on' : 'ok'} onClick={() => update(l.key, { mark: 'correct' })} aria-label="נכון">✓</button>
                  <button className={l.mark === 'wrong' ? 'bad on' : 'bad'} onClick={() => update(l.key, { mark: 'wrong' })} aria-label="לא נכון">✗</button>
                </span>
              </div>
              <span className="meta">
                {Math.round((l.confidence ?? 0) * 100)}% · {l.frames} פריימים · הסכמה {Math.round((l.agreement ?? 0) * 100)}%
              </span>
              {l.mark === 'wrong' && (
                <input dir="ltr" placeholder="מה כתוב באמת (לא חובה)" value={l.actual} onChange={(e) => update(l.key, { actual: e.target.value })} />
              )}
            </div>
          )}
          <AddLine onClick={() => addMissed(i)} />
        </div>
      ))}

      <div className="scenes">
        {SCENES.map((s) => (
          <button key={s} className={scene.includes(s) ? 'chip on' : 'chip'} onClick={() => toggleScene(s)}>
            {s}
          </button>
        ))}
      </div>

      <label>
        הערות
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <div className="actions">
        {!ready && <p className="hint">סמן ✓ או ✗ בכל שורה כדי לשמור</p>}
        <button className="big" disabled={!ready || saving} onClick={save}>
          שמור וסרוק הבא
        </button>
        {!readLines.length && !missedLines.length && <p className="hint">אפשר להוסיף עם + את מה שהיה כתוב</p>}
        <button className="link" onClick={onCancel}>
          זרוק את הסריקה
        </button>
      </div>
    </main>
  )
}

function AddLine({ onClick }: { onClick: () => void }) {
  return (
    <button className="add-line" onClick={onClick} aria-label="הוסף שורה שפוספסה כאן">
      + שורה שפוספסה
    </button>
  )
}

function NumberField({ label, value, set, step = 1 }: { label: string; value: number; set: (n: number) => void; step?: number }) {
  return (
    <label>
      {label}
      <input type="number" inputMode="decimal" step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
    </label>
  )
}

function SettingsScreen({
  settings: s,
  setSettings,
  supports,
  cameras,
  resolution,
  hwApplied,
  loadMs,
  onBack,
}: {
  settings: Settings
  setSettings: (s: Settings) => void
  supports: string[]
  cameras: CameraChoice[]
  resolution: string
  hwApplied: string[]
  loadMs: number | null
  onBack: () => void
}) {
  const [status, setStatus] = useState('')
  return (
    <main className="settings">
      <button className="link" onClick={onBack}>→ חזרה לסריקה</button>
      <h2>שליחה לגוגל שיטס</h2>
      <label>
        כתובת הסקריפט (Web app URL)
        <input dir="ltr" value={s.scriptUrl} onChange={(e) => setSettings({ ...s, scriptUrl: e.target.value.trim() })} />
      </label>
      <label>
        מפתח
        <input dir="ltr" value={s.scriptKey} onChange={(e) => setSettings({ ...s, scriptKey: e.target.value.trim() })} />
      </label>
      <button
        onClick={async () => {
          setStatus('בודק…')
          try {
            setStatus(await testConnection(s.scriptUrl, s.scriptKey))
          } catch (e) {
            setStatus(`שגיאה: ${e}`)
          }
        }}
      >
        בדוק חיבור
      </button>
      {status && <p className="hint">{status}</p>}
      <label>
        שם הבודק
        <input value={s.tester} onChange={(e) => setSettings({ ...s, tester: e.target.value })} />
      </label>

      <h2>מצלמה</h2>
      <label>
        איזו מצלמה (בחלק מהטלפונים מצלמה אחרת מתמקדת קרוב יותר)
        <select value={s.cameraId} onChange={(e) => setSettings({ ...s, cameraId: e.target.value })}>
          <option value="">ברירת מחדל (אחורית)</option>
          {cameras.map((c) => (
            <option key={c.deviceId} value={c.deviceId}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        רזולוציה
        <select value={s.cameraHeight} onChange={(e) => setSettings({ ...s, cameraHeight: Number(e.target.value) })}>
          <option value={1080}>1080p</option>
          <option value={1440}>1440p</option>
          <option value={2160}>4K</option>
        </select>
      </label>
      <p className="hint" dir="ltr">current: {resolution}</p>
      <label className="check">
        <input type="checkbox" checked={s.aimBox} onChange={(e) => setSettings({ ...s, aimBox: e.target.checked })} />
        לקרוא רק את המסגרת שבאמצע המסך (טקסט קטן נקרא טוב יותר)
      </label>

      <h2>זיהוי</h2>
      <NumberField label="פריימים להצבעה" value={s.voteFrames} set={(n) => setSettings({ ...s, voteFrames: n })} />
      <NumberField label="סף טשטוש (פריים מתחת לזה לא נקרא)" value={s.blurThreshold} set={(n) => setSettings({ ...s, blurThreshold: n })} />
      <NumberField label="גודל התמונה לאיתור טקסט (פיקסלים)" value={s.detLimit} step={32} set={(n) => setSettings({ ...s, detLimit: n })} />
      <NumberField label="ביטחון מינימלי (0-1)" value={s.minConfidence} step={0.05} set={(n) => setSettings({ ...s, minConfidence: n })} />
      <NumberField label="זמן מקסימלי לסריקה (שניות)" value={s.timeoutSec} set={(n) => setSettings({ ...s, timeoutSec: n })} />
      <NumberField label="תיקון חשיפה (כשבקרת מצלמה פועלת)" value={s.exposureComp} step={0.5} set={(n) => setSettings({ ...s, exposureComp: n })} />

      <h2>הטלפון הזה</h2>
      <p className="hint" dir="ltr">supports: {supports.join(', ') || 'none'}</p>
      <p className="hint" dir="ltr">applied: {hwApplied.join(', ') || 'none'}</p>
      <p className="hint">טעינת המודל: {loadMs === null ? '…' : `${loadMs} ms`}</p>
      <p className="hint" dir="ltr">build {__BUILD__}</p>
    </main>
  )
}

function Log({ scans, onSync, onBack }: { scans: StoredScan[]; onSync: () => void; onBack: () => void }) {
  const label: Record<Outcome, string> = { correct: '✓', wrong: '✗', not_read: '—' }
  return (
    <main className="log">
      <button className="link" onClick={onBack}>→ חזרה לסריקה</button>
      <button onClick={onSync}>שלח עכשיו</button>
      <button onClick={() => downloadCsv(scans)}>הורד CSV</button>
      <ul>
        {scans.map((s) => (
          <li key={s.record.id}>
            <b>{label[s.record.outcome]}</b> <span dir="ltr">{s.record.summary || '—'}</span>{' '}
            <span className="meta">
              {new Date(s.record.createdAt).toLocaleTimeString('he-IL')} · {s.record.setup} ·{' '}
              {s.synced ? 'נשלח' : s.syncError ? `לא נשלח: ${s.syncError}` : 'ממתין'}
            </span>
          </li>
        ))}
      </ul>
    </main>
  )
}

function downloadCsv(scans: StoredScan[]) {
  if (!scans.length) return
  const cols = Object.keys(scans[0].record) as (keyof StoredScan['record'])[]
  const cell = (v: unknown) => `"${(typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')).replace(/"/g, '""')}"`
  const csv = [cols.join(','), ...scans.map((s) => cols.map((c) => cell(s.record[c])).join(','))].join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }))
  a.download = `scans-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
}
