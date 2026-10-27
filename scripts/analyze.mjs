// Summarises the scans saved by `npm run lab` (data/scans): results per line, where the time went,
// and how the focus searches went. Scans from the test runs are left out.
// Usage: node scripts/analyze.mjs [scan-dir ...]
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = 'data/scans'
const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name))
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null)

for (const dir of dirs.sort()) {
  const f = join(dir, 'record.json')
  if (!existsSync(f)) continue
  const r = JSON.parse(readFileSync(f, 'utf8'))
  // Scans from before per-line marking (one outcome, a chosen read and the reads as a list).
  r.lines ??= (r.reads ?? []).map((x, i) => ({
    line: i + 1,
    read: x.text,
    confidence: x.confidence,
    outcome: x.text === r.chosen ? r.outcome : 'unchecked',
    actual: x.text === r.chosen ? r.actual : '',
  }))
  r.scene ??= []
  // Scans from my own test runs (headless browser, or the Pixel 7 the tests pretend to be).
  if (/HeadlessChrome|Pixel 7\b/.test(r.device)) continue
  console.log(`\n=== ${r.createdAt} ${r.mode} ${r.setup} backend ${r.backend ?? 'wasm'} (load ${r.modelLoadMs} ms, gpu warm ${r.gpuWarmMs ?? '-'} ms) zoom ${r.zoom} ${r.resolution} camera "${r.camera}" minFocus ${r.cameraMinFocus}`)
  console.log(`    ${dir}`)
  console.log(`    outcome ${r.outcome}; ${r.lines.length} lines; duration ${r.durationMs ?? r.timeToResultMs} ms; frames read ${r.framesRead}, blurry ${r.framesBlurry}; merged retakes ${r.merged ?? '-'}; scene ${r.scene.join(', ')}; notes: ${r.notes}`)
  const byItem = new Map()
  for (const l of r.lines) {
    const k = l.item ?? 0
    if (!byItem.has(k)) byItem.set(k, [])
    byItem.get(k).push(l)
  }
  for (const [item, lines] of byItem) {
    console.log(`    label ${item} at ${lines[0].atMs ?? '-'} ms:`)
    for (const l of lines) {
      const fix = l.outcome === 'wrong' && l.actual ? `  -> really "${l.actual}"` : l.outcome === 'missed' ? `  (missed: "${l.actual}")` : ''
      console.log(`      ${l.outcome.padEnd(7)} ${l.fast ? "1-frame " : "        "}${JSON.stringify(l.read)} conf ${l.confidence ?? "-"}${fix}`)
    }
  }
  const read = (r.frameLog ?? []).filter((x) => !x.blurry)
  const blurry = (r.frameLog ?? []).filter((x) => x.blurry)
  if (read.length) {
    console.log(`    per read frame (median): pre ${med(read.map((x) => x.preMs))} ms, det ${med(read.map((x) => x.detMs))} ms, rec ${med(read.map((x) => x.recMs))} ms, boxes ${med(read.map((x) => x.boxes))}, recognitions ${med(read.map((x) => x.recs))}`)
    const gaps = read.slice(1).map((x, i) => x.t - read[i].t)
    console.log(`    time between read frames: median ${med(gaps)} ms; sharpness read ${med(read.map((x) => x.sharp))}, blurry ${med(blurry.map((x) => x.sharp))}`)
  }
  const sw = r.focusSweeps ?? []
  if (sw.length) {
    console.log(`    focus searches: ${sw.length} (${sw.map((s) => s.kind).join(', ')}), median ${med(sw.map((s) => s.ms))} ms, avg ${avg(sw.map((s) => s.ms))} ms, steps median ${med(sw.map((s) => s.samples.length))}`)
    console.log(`    focus distances chosen (cm): ${sw.map((s) => Math.round(s.distance * 1000) / 10).join(', ')}`)
  }
}
