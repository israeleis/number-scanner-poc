import { useCallback, useEffect, useRef, useState } from 'react'
import {
  canScan,
  cachedProbe,
  capabilities,
  closestFocusing,
  openCamera,
  probeCameras,
  saveProbe,
  canSweepFocus,
  FocusSearch,
  setFocus,
  setHardware,
  setTorch,
  supportedList,
  trackResolution,
  type CameraCaps,
  type CameraChoice,
  type FocusSweep,
} from './camera'
import { boxCorners, hasWebGpu, loadEngine, type Engine } from './ocr/engine'
import { runContinuous, signal, words, type Capture } from './continuous'
import { startMotion } from './motion'
import {
  AIM_H,
  AIM_W,
  displayScale,
  grab,
  frameRegion,
  runScan,
  type Precision,
  type ScanProgress,
  type ScanResult,
} from './scanner'
import { loadSettings, saveSettings, setupName, type Settings } from './settings'
import { allScans, putScan, syncPending, testConnection, type Line, type Outcome, type StoredScan } from './store'

declare const __BUILD__: string
/** Served by `npm run lab` from the computer: scans go to the computer unless a script URL is set. */
declare const __LAB__: boolean
const LAB_URL = `${import.meta.env.BASE_URL}api/scans`

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
  const [cameras, setCameras] = useState<CameraChoice[]>(() => cachedProbe() ?? [])
  /** Bumped to open the camera again after it failed. */
  const [cameraRetry, setCameraRetry] = useState(0)
  /** Bumped to look at the cameras again. */
  const [probeRun, setProbeRun] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [result, setResult] = useState<ScanResult | null>(null)
  /** Texts written down so far in a continuous run, newest first. */
  const [live, setLive] = useState<Capture[]>([])
  const audioRef = useRef<AudioContext | null>(null)
  /** After a scan sent without marking: how many lines it had (shown until the next scan). */
  const [saved, setSaved] = useState<number | null>(null)
  /** Precision while held (button or finger on the picture): the point, shared with the scan loops. */
  const precisionRef = useRef<Precision>({ point: null, only: false })
  const [aim, setAim] = useState<{ fx: number; fy: number; only: boolean } | null>(null)
  /** The point a touch on the picture chose (results ordered from it until the scan ends). */
  const chosenRef = useRef<{ fx: number; fy: number } | null>(null)
  const setPoint = (p: { fx: number; fy: number } | null, only = false) => {
    precisionRef.current.point = p
    precisionRef.current.only = only
    setAim(p && { ...p, only })
  }
  /** A touch on the picture moves the cross there; it stays after the finger lifts. */
  const choosePoint = (p: { fx: number; fy: number } | null) => {
    chosenRef.current = p
    setPoint(p)
  }
  /** The precision button: the cross in the middle, only the line under it, while held. */
  const holdPrecision = (held: boolean) =>
    held ? setPoint({ fx: 0.5, fy: 0.5 }, true) : setPoint(chosenRef.current)
  const pointIn = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return {
      fx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      fy: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }
  /** While scanning: is the phone steady enough to read? (The aiming box is grey while it moves.) */
  const [steady, setSteady] = useState(true)
  const setSteadyNow = useCallback((v: boolean) => setSteady((old) => (old === v ? old : v)), [])
  /** The last focus search of the running scan, shown to the tester. */
  const [focusNow, setFocusNow] = useState<FocusSweep | null>(null)
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
    await syncPending(settings.scriptUrl || (__LAB__ ? LAB_URL : ''), settings.scriptKey)
    await refreshScans()
  }, [settings.scriptUrl, settings.scriptKey, refreshScans])

  useEffect(() => {
    refreshScans()
  }, [refreshScans])

  // The app starts on the main processor, which loads quickly. With the switch on, and only if the
  // browser offers WebGPU, the graphics processor's runtime is then downloaded and prepared in the
  // background; the next scan after it is ready uses it. A scan already running keeps its engine.
  // Only a device with a touch screen and a camera scans; anywhere else nothing is downloaded.
  const [device, setDevice] = useState<{ touch: boolean; camera: boolean } | null>(null)
  useEffect(() => {
    canScan().then(setDevice)
  }, [])
  const scannable = !!device?.touch && !!device.camera
  const [gpuState, setGpuState] = useState<'off' | 'checking' | 'unsupported' | 'preparing' | 'ready' | 'failed'>('off')
  useEffect(() => {
    if (!scannable) return
    let cancelled = false
    setEngineError('')
    loadEngine(false).then(
      async (main) => {
        if (cancelled) return
        setEngine(main)
        if (!settings.gpu) return setGpuState('off')
        setGpuState('checking')
        if (!(await hasWebGpu())) return !cancelled && setGpuState('unsupported')
        if (cancelled) return
        setGpuState('preparing')
        loadEngine(true).then(
          (gpu) => {
            if (cancelled) return
            setEngine(gpu)
            setGpuState(gpu.backend === 'webgpu' ? 'ready' : 'failed')
          },
          () => !cancelled && setGpuState('failed'),
        )
      },
      (e) => !cancelled && setEngineError(String(e)),
    )
    return () => {
      cancelled = true
    }
  }, [settings.gpu, scannable])

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
    if (screen !== 'scan' || !videoRef.current || !scannable) return
    let cancelled = false
    let opened: MediaStreamTrack | null = null
    const video = videoRef.current
    ;(async () => {
      // Learn the cameras once; the choice "automatic" is the back camera that focuses closest.
      let probe = cachedProbe()
      if (!probe) {
        probe = await probeCameras()
        saveProbe(probe)
      }
      if (cancelled) return
      setCameras(probe)
      const id = settings.cameraId || closestFocusing(probe)
      let t: MediaStreamTrack
      try {
        t = await openCamera(video, id, settings.cameraHeight)
      } catch (e) {
        if (!id) throw e
        // The chosen camera is gone (ids can change): forget what was learnt and use the default.
        saveProbe(null)
        t = await openCamera(video, '', settings.cameraHeight)
      }
      if (cancelled) return t.stop()
      opened = t
      setTrack(t)
      setCaps(capabilities(t))
      setCameraError('')
    })().catch((e) => setCameraError(String(e)))
    return () => {
      cancelled = true
      opened?.stop()
      setTrack(null)
      setTorchState(false)
    }
  }, [screen, settings.cameraId, settings.cameraHeight, probeRun, cameraRetry, scannable])

  useEffect(() => {
    if (track) setHardware(track, settings.hardware, settings.exposureComp).then(setHwApplied)
  }, [track, settings.hardware, settings.exposureComp])

  // Focus search counts only where the phone lets the site move the lens.
  const sweeping = settings.focusSweep && canSweepFocus(caps)
  // G1 only when the graphics processor is really in use (the phone may not offer WebGPU).
  const setup = setupName({ ...settings, focusSweep: sweeping, gpu: engine?.backend === 'webgpu' }, torch)
  const setupCount = scans.filter((s) => s.record.setup === setup).length

  /** One focus search per open camera, so it remembers the last good focus between scans. */
  const focusRef = useRef<{ track: MediaStreamTrack; frames: number; search: FocusSearch } | null>(null)
  function focusSearch(): FocusSearch | null {
    const video = videoRef.current
    if (!track || !video || !canSweepFocus(caps)) return null
    const frames = settings.focusSettleFrames
    if (focusRef.current?.track !== track || focusRef.current.frames !== frames) {
      const waitFrame = () =>
        new Promise<void>((r) =>
          'requestVideoFrameCallback' in video ? video.requestVideoFrameCallback(() => r()) : setTimeout(r, 33),
        )
      focusRef.current = { track, frames, search: new FocusSearch(track, waitFrame, frames) }
    }
    return focusRef.current.search
  }

  async function startScan() {
    if (!engine || !videoRef.current || scanning) return
    stopRef.current = { stopped: false }
    setScanning(true)
    setProgress(null)
    setSaved(null)
    let scanned: ScanResult
    try {
      // The gyroscope (iPhone asks permission, which needs this tap).
      await startMotion()
      const search = focusSearch()
      const focuser = search ? (measure: () => number, force?: boolean) => search.find(measure, force) : null
      setFocusNow(null)
      if (settings.mode === 'continuous') {
        // Sound may only start from a tap, so the audio is set up here.
        audioRef.current ??= new AudioContext()
        audioRef.current.resume()
        setLive([])
        const video = videoRef.current
        const run = await runContinuous(
          video,
          engine,
          settings,
          (c, started) => {
            if (started) {
              signal(audioRef.current)
              setLive((l) => [c, ...l])
            } else {
              // Lines added to the current label: show them (same object, new array to re-render).
              setLive((l) => [...l])
            }
          },
          setProgress,
          stopRef.current,
          focuser,
          setFocusNow,
          setSteadyNow,
          precisionRef.current,
        )
        scanned = {
          reads: run.captures.flatMap((c) =>
            c.lines.map((text, i) => ({
              text,
              confidence: c.conf[i] ?? c.confidence,
              frames: 0,
              agreement: 1,
              x: 0,
              y: 0,
              h: 0,
              d: c.dist[i] ?? undefined,
            })),
          ),
          original: run.last ?? grab(video, frameRegion(video, settings)),
          processed: null,
          frameReads: [],
          framesRead: run.framesRead,
          framesBlurry: run.framesBlurry,
          sharpness: run.sharpness,
          timeToResultMs: null,
          sweeps: run.sweeps,
          frameLog: run.frameLog,
          captures: run.captures.flatMap((c, item) => c.lines.map((_, i) => ({ crop: c.crop, atMs: c.atMs, item, fast: c.fast[i] }))),
          durationMs: run.durationMs,
          merged: run.merged,
        }
      } else {
        scanned = await runScan(
          videoRef.current,
          engine,
          settings,
          setProgress,
          stopRef.current,
          focuser,
          setFocusNow,
          setSteadyNow,
          precisionRef.current,
        )
      }
      if (settings.review) {
        setResult(scanned)
        setScreen('report')
      } else {
        // No marking on the phone: everything is sent as it is and checked later from the pictures.
        await saveReport(uncheckedFields(scanned), scanned)
        setSaved(scanned.reads.length)
      }
    } finally {
      setScanning(false)
      // The next scan starts with the cross back in the middle.
      choosePoint(null)
      // Back to the phone's own autofocus between scans.
      if (track && canSweepFocus(caps)) setFocus(track, null)
    }
  }

  async function saveReport(fields: ReportFields, scanned: ScanResult | null = result) {
    const result = scanned
    if (!result) return
    const toBlob = (c: HTMLCanvasElement) =>
      new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.9))
    const record = {
      id: crypto.randomUUID(),
      mode: result.captures ? ('continuous' as const) : ('single' as const),
      durationMs: result.durationMs ?? null,
      merged: result.merged ?? null,
      createdAt: new Date().toISOString(),
      tester: settings.tester,
      setup,
      preprocess: settings.preprocess,
      hardware: settings.hardware,
      voting: settings.voting,
      torch,
      zoom: settings.viewZoom,
      voteFrames: settings.voteFrames,
      blurThreshold: settings.blurThreshold,
      detLimit: settings.detLimit,
      minConfidence: settings.minConfidence,
      ...fields,
      frameReads: result.frameReads.map((r) => ({
        text: r.text,
        confidence: round(r.confidence),
        box: {
          cx: Math.round(r.box.cx),
          cy: Math.round(r.box.cy),
          length: Math.round(r.box.length),
          thickness: Math.round(r.box.thickness),
        },
        rotation: r.rotation,
      })),
      framesRead: result.framesRead,
      framesBlurry: result.framesBlurry,
      sharpness: result.sharpness,
      timeToResultMs: result.timeToResultMs,
      modelLoadMs: engine?.loadMs ?? 0,
      backend: engine?.backend ?? 'wasm',
      gpuWarmMs: engine?.warmMs ?? 0,
      device: navigator.userAgent,
      resolution: track ? trackResolution(track) : '',
      aimBox: settings.aimBox,
      camera: track?.label ?? '',
      cameraMinFocus: caps.focusDistance?.min ?? null,
      cameraFocusRange: caps.focusDistance ?? null,
      cameraId: track?.getSettings().deviceId ?? '',
      cameraChoice: settings.cameraId ? ('manual' as const) : ('automatic' as const),
      cameras,
      focusSweep: sweeping,
      waitSteady: settings.waitSteady,
      gyroThreshold: settings.gyroThreshold,
      diffThreshold: settings.diffThreshold,
      steadyMs: settings.steadyMs,
      focusSweeps: result.sweeps,
      frameLog: result.frameLog,
      cameraSupports: supportedList(caps),
      hardwareApplied: hwApplied,
      appVersion: __BUILD__,
    }
    await putScan({
      record,
      original: await toBlob(result.original),
      processed: result.processed ? await toBlob(result.processed) : null,
      // One picture per label (the lines of a label share it).
      crops: result.captures
        ? await Promise.all(
            result.captures.filter((c, i, all) => all.findIndex((x) => x.item === c.item) === i).map((c) => toBlob(c.crop)),
          )
        : undefined,
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
          {device && !scannable && (
            <p className="error">
              סריקה זמינה רק בטלפון או בטאבלט עם מסך מגע ומצלמה.{' '}
              {!device.touch && 'אין כאן מסך מגע.'} {!device.camera && 'אין כאן מצלמה.'} לא הורד שום מודל.
            </p>
          )}
          <div className="tabs" role="tablist">
            {(['single', 'continuous'] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={settings.mode === m}
                className={settings.mode === m ? 'tab on' : 'tab'}
                disabled={scanning}
                onClick={() => setSettings({ ...settings, mode: m })}
              >
                {m === 'single' ? 'סריקה בודדת' : 'סריקה רציפה'}
              </button>
            ))}
          </div>
          <div
            className={settings.aimBox ? 'viewfinder strip' : 'viewfinder'}
            // A touch on the picture moves the cross there (it can be dragged); results are ordered from
            // it until the scan ends.
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              choosePoint(pointIn(e))
            }}
            onPointerMove={(e) => e.buttons && choosePoint(pointIn(e))}
          >
            <video ref={videoRef} playsInline muted style={{ transform: `scale(${settings.viewZoom})` }} />
            {settings.aimBox && (
              <div
                className={scanning && !steady ? 'aim moving' : 'aim'}
                style={{ width: `${AIM_W * 100}%`, height: `${AIM_H * 100}%` }}
              />
            )}
            {aim && (
              <div
                className={aim.only ? 'crosshair' : 'crosshair finger'}
                aria-hidden="true"
                style={{ left: `${aim.fx * 100}%`, top: `${aim.fy * 100}%` }}
              />
            )}
            {scanning && progress && <LiveBoxes video={videoRef.current} progress={progress} zoom={settings.viewZoom} />}
            {scanning && settings.mode === 'continuous' && live.length > 0 && (
              <div className="last-capture aimed" key={live.length}>
                <span className="count">{live.length}</span>
                <Lines lines={live[0].lines} />
              </div>
            )}
          </div>
          {cameraError && (
            <p className="error">
              המצלמה לא נפתחה: {cameraError}
              {/NotReadable/.test(cameraError) && ' (מצלמה תפוסה: סגור טאבים אחרים של האפליקציה)'}{' '}
              <button onClick={() => setCameraRetry((n) => n + 1)}>פתח מצלמה שוב</button>
            </p>
          )}
          {engineError && <p className="error">המודל לא נטען: {engineError}</p>}
          {!engine && !engineError && (
            <p className="hint">טוען את מודל הזיהוי… (רק בפעם הראשונה זה לוקח זמן)</p>
          )}
          {settings.gpu && gpuState !== 'ready' && gpuState !== 'off' && (
            <p className="hint">
              {
                {
                  checking: 'בודק אם יש מעבד גרפי…',
                  preparing: 'מכין את המעבד הגרפי ברקע; בינתיים הזיהוי רץ על המעבד הרגיל.',
                  unsupported: 'הטלפון לא מאפשר מעבד גרפי לאתרים: הזיהוי רץ על המעבד הרגיל.',
                  failed: 'המעבד הגרפי לא עלה: הזיהוי רץ על המעבד הרגיל.',
                }[gpuState]
              }
            </p>
          )}

          <button
            className={aim?.only ? 'precision on' : 'precision'}
            // Precision while held: the crosshair in the middle, only the line under it is read.
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              holdPrecision(true)
            }}
            onPointerUp={() => holdPrecision(false)}
            onPointerCancel={() => holdPrecision(false)}
            onContextMenu={(e) => e.preventDefault()}
          >
            {aim?.only ? 'דיוק: רק מה שמתחת לצלב' : 'החזק לדיוק'}
          </button>

          <div className="toggles">
            <Toggle label="עיבוד תמונה" on={settings.preprocess} set={(v) => setSettings({ ...settings, preprocess: v })} />
            <Toggle label="בקרת מצלמה" on={settings.hardware} set={(v) => setSettings({ ...settings, hardware: v })} />
            <Toggle label="הצבעה" on={settings.voting} set={(v) => setSettings({ ...settings, voting: v })} />
            <Toggle label="מעבד גרפי" on={settings.gpu} set={(v) => setSettings({ ...settings, gpu: v })} />
            {canSweepFocus(caps) && (
              <Toggle label="חיפוש פוקוס" on={settings.focusSweep} set={(v) => setSettings({ ...settings, focusSweep: v })} />
            )}
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

          <div className="quick">
            <span className="hint">הגדלה</span>
            {[1, 1.5, 2, 3, 4].map((z) => (
              <button
                key={z}
                className={settings.viewZoom === z ? 'chip on' : 'chip'}
                onClick={() => setSettings({ ...settings, viewZoom: z })}
              >
                ×{z}
              </button>
            ))}
          </div>

          {scanning ? (
            <>
              <p className="hint">
                {!progress && sweeping ? 'מחפש פוקוס… ' : ''}חדות {Math.round(progress?.sharpness ?? 0)} · נקראו {progress?.framesRead ?? 0} פריימים · מטושטשים{' '}
                {progress?.framesBlurry ?? 0}
              </p>
              {focusNow && (
                <p className={focusNow.distance <= focusNow.near * 1.03 && focusNow.sharpness < 10 ? 'error' : 'hint'}>
                  פוקוס {(focusNow.distance * 100).toFixed(1)} ס״מ (המצלמה הזו: {(focusNow.near * 100).toFixed(0)}–
                  {(focusNow.far * 100).toFixed(0)} ס״מ)
                  {focusNow.distance <= focusNow.near * 1.03 && focusNow.sharpness < 10 ? ' · קרוב מדי: תרחיק את הטלפון' : ''}
                </p>
              )}
              <button className="big stop" onClick={() => (stopRef.current.stopped = true)}>
                {settings.mode === 'continuous' ? `${settings.review ? 'סיים ובדוק' : 'סיים ושלח'} (${live.length})` : 'עצור'}
              </button>
              {settings.mode === 'continuous' && (
                <ol className="live" reversed>
                  {live.map((c, i) => (
                    <li key={live.length - i} className={i === 0 ? 'newest' : ''}>
                      <Lines lines={c.lines} />
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : (
            <>
              <button className="big" disabled={!engine || !track} onClick={startScan}>
                {settings.mode === 'continuous' ? 'התחל סריקה רציפה' : 'סרוק'}
              </button>
              {saved !== null && <p className="saved">✓ נשמר ונשלח ({saved} שורות)</p>}
            </>
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
          activeCamera={track?.label ?? ''}
          onProbeAgain={() => {
            saveProbe(null)
            setProbeRun(probeRun + 1)
          }}
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

/** A scan saved without marking: every line "unchecked", to be checked later from the pictures. */
function uncheckedFields(r: ScanResult): ReportFields {
  const lines: Line[] = r.reads.map((read, i) => ({
    line: i + 1,
    read: read.text,
    actual: '',
    outcome: 'unchecked',
    confidence: round(read.confidence),
    frames: r.captures ? null : read.frames,
    agreement: r.captures ? null : round(read.agreement),
    words: words(read.text),
    fast: r.captures?.[i].fast ?? null,
    dist: read.d ?? null,
    item: r.captures ? r.captures[i].item + 1 : null,
    atMs: r.captures?.[i].atMs ?? null,
    crop: r.captures?.[i].item ?? null,
  }))
  return {
    outcome: lines.length ? 'unchecked' : 'not_read',
    summary: lines.map((l) => l.read).join(' | '),
    lines,
    scene: JSON.parse(localStorage.getItem('last-scene') ?? '[]'),
    notes: '',
  }
}

/** Lines top to bottom, each line's words as separate chips. */
function Lines({ lines }: { lines: string[] }) {
  return (
    <div className="lines" dir="ltr">
      {lines.map((l, i) => (
        <div key={i} className="words">
          {words(l).map((w, j) => (
            <span key={j} className="word">
              {w}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button className={on ? 'chip on' : 'chip'} aria-pressed={on} onClick={() => set(!on)}>
      {label} {on ? 'פועל' : 'כבוי'}
    </button>
  )
}

/** Boxes of the last frame read, drawn over the live video (which is shown with object-fit: cover). */
function LiveBoxes({ video, progress, zoom }: { video: HTMLVideoElement | null; progress: ScanProgress; zoom: number }) {
  if (!video || !video.videoWidth) return null
  const { region, scale } = progress
  const vw = video.clientWidth
  const vh = video.clientHeight
  const s = displayScale(video.videoWidth, video.videoHeight, vw, vh, zoom)
  const ox = (vw - video.videoWidth * s) / 2
  const oy = (vh - video.videoHeight * s) / 2
  return (
    <div className="overlay">
      {progress.lastReads.map((r, i) => (
        <div
          key={i}
          className="livebox"
          style={{
            left: ox + (region.x + r.box.cx / scale) * s,
            top: oy + (region.y + r.box.cy / scale) * s,
            width: (r.box.length / scale) * s,
            height: (r.box.thickness / scale) * s,
            transform: `translate(-50%, -50%) rotate(${r.box.angle}rad)`,
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
  atMs: number | null
  item: number | null
  fast: boolean | null
  /** With the crosshair: pixels from it. */
  dist: number | null
  thumb: string | null
}

let nextKey = 0

function Report({ result, onSave, onCancel }: { result: ScanResult; onSave: (f: ReportFields) => void; onCancel: () => void }) {
  const [lines, setLines] = useState<DraftLine[]>(() =>
    result.reads.map((r, i) => ({
      key: nextKey++,
      read: r.text,
      actual: '',
      mark: null,
      missed: false,
      confidence: round(r.confidence),
      frames: r.frames,
      agreement: round(r.agreement),
      atMs: result.captures?.[i].atMs ?? null,
      item: result.captures?.[i].item ?? null,
      fast: result.captures?.[i].fast ?? null,
      dist: r.d ?? null,
      // The label's picture is shown once, above its first line.
      thumb:
        result.captures && (i === 0 || result.captures[i - 1].item !== result.captures[i].item)
          ? result.captures[i].crop.toDataURL('image/jpeg', 0.8)
          : null,
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
    for (const r of result.frameReads) {
      const corners = boxCorners(r.box)
      ctx.beginPath()
      corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.closePath()
      ctx.stroke()
    }
    return c.toDataURL('image/jpeg', 0.8)
  })()

  const update = (key: number, patch: Partial<DraftLine>) =>
    setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  /** Adds an empty "missed" line after position `at` (-1: at the top). */
  const addMissed = (at: number) => {
    const blank: DraftLine = {
      key: nextKey++,
      read: '',
      actual: '',
      mark: null,
      missed: true,
      confidence: null,
      frames: null,
      agreement: null,
      atMs: null,
      fast: null,
      dist: null,
      // A missed line belongs to the label of the line above it.
      item: at >= 0 ? lines[at].item : (lines[0]?.item ?? null),
      thumb: null,
    }
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
      words: words(l.missed ? l.actual.trim() : l.read),
      fast: l.fast,
      dist: l.dist,
      item: l.item === null ? null : l.item + 1,
      atMs: l.atMs,
      crop: l.item,
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
        {result.captures
          ? `${new Set(result.captures.map((c) => c.item)).size} תוויות נקלטו ב־${((result.durationMs ?? 0) / 1000).toFixed(0)} שניות`
          : result.timeToResultMs === null
            ? 'לא זוהה בזמן'
            : `תוצאה אחרי ${(result.timeToResultMs / 1000).toFixed(1)} שניות`}{' '}
        ·{' '}
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
          {l.thumb && (
            <div className="label-head">
              <b>תווית {(l.item ?? 0) + 1}</b>
              {l.atMs !== null && <span className="meta"> · אחרי {(l.atMs / 1000).toFixed(1)} שנ׳</span>}
              <img className="thumb" src={l.thumb} alt="" />
            </div>
          )}
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
              <Lines lines={[l.read]} />
              <span className="meta">
                {Math.round((l.confidence ?? 0) * 100)}%
                {l.atMs === null ? ` · ${l.frames} פריימים · הסכמה ${Math.round((l.agreement ?? 0) * 100)}%` : ''}
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
  activeCamera,
  onProbeAgain,
  resolution,
  hwApplied,
  loadMs,
  onBack,
}: {
  settings: Settings
  setSettings: (s: Settings) => void
  supports: string[]
  cameras: CameraChoice[]
  activeCamera: string
  onProbeAgain: () => void
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
      {__LAB__ && <p className="hint">רץ מהמחשב: כשהכתובת ריקה, הסריקות נשמרות במחשב.</p>}
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
            setStatus(await testConnection(s.scriptUrl || (__LAB__ ? LAB_URL : ''), s.scriptKey))
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
        איזו מצלמה
        <select value={s.cameraId} onChange={(e) => setSettings({ ...s, cameraId: e.target.value })}>
          <option value="">אוטומטי: האחורית שמתמקדת הכי קרוב</option>
          {cameras.map((c) => (
            <option key={c.deviceId} value={c.deviceId}>
              {c.label}
              {c.back ? '' : ' (קדמית)'}
              {c.minFocus === null ? '' : ` · מתמקדת מ־${Math.round(c.minFocus * 100)} ס״מ`}
            </option>
          ))}
        </select>
      </label>
      <p className="hint" dir="auto">פתוחה עכשיו: {activeCamera || '…'}</p>
      <button onClick={onProbeAgain}>בדוק את המצלמות שוב</button>
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

      <label className="check">
        <input type="checkbox" checked={s.review} onChange={(e) => setSettings({ ...s, review: e.target.checked })} />
        לסמן ✓/✗ בטלפון אחרי כל סריקה (כבוי: הכל נשלח כמו שהוא ונבדק אחר כך מהתמונות)
      </label>

      <h2>זיהוי</h2>
      <NumberField label="פריימים להצבעה" value={s.voteFrames} set={(n) => setSettings({ ...s, voteFrames: n })} />
      <NumberField label="סף טשטוש (פריים מתחת לזה לא נקרא)" value={s.blurThreshold} set={(n) => setSettings({ ...s, blurThreshold: n })} />
      <NumberField label="גודל התמונה לאיתור טקסט (פיקסלים)" value={s.detLimit} step={32} set={(n) => setSettings({ ...s, detLimit: n })} />
      <NumberField label="ביטחון מינימלי (0-1)" value={s.minConfidence} step={0.05} set={(n) => setSettings({ ...s, minConfidence: n })} />
 <NumberField
        label="פריימים להמתנה אחרי הזזת העדשה (פריים ≈ 33ms)"
        value={s.focusSettleFrames}
        set={(n) => setSettings({ ...s, focusSettleFrames: Math.max(1, Math.round(n)) })}
      />
      <NumberField
        label="סריקה רציפה: ביטחון שמספיק לפריים אחד (0-1; 1 = תמיד לחכות לפריים שני)"
        value={s.fastConfidence}
        step={0.01}
        set={(n) => setSettings({ ...s, fastConfidence: n })}
      />
      <NumberField
        label="סריקה רציפה: ביטחון מינימלי לשורה (0-1; מתחת לזה לא נקלטת, כמו לוגו)"
        value={s.minLineConfidence}
        step={0.05}
        set={(n) => setSettings({ ...s, minLineConfidence: n })}
      />
      <label className="check">
        <input type="checkbox" checked={s.waitSteady} onChange={(e) => setSettings({ ...s, waitSteady: e.target.checked })} />
        לקרוא רק כשהטלפון יציב (לא בזמן תנועה)
      </label>
      <NumberField label="תנועה: מהירות סיבוב (מעלות לשנייה) שמעליה הטלפון זז" value={s.gyroThreshold} set={(n) => setSettings({ ...s, gyroThreshold: n })} />
      <NumberField label="תנועה: שינוי בתמונה (0-255) שמעליו הטלפון זז" value={s.diffThreshold} set={(n) => setSettings({ ...s, diffThreshold: n })} />
      <NumberField label="תנועה: כמה זמן יציב לפני קריאה (ms)" value={s.steadyMs} step={50} set={(n) => setSettings({ ...s, steadyMs: n })} />
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
  const label: Record<Outcome, string> = { correct: '✓', wrong: '✗', not_read: '—', unchecked: '·' }
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
