// Copies the onnxruntime-web WebAssembly files (plain, and the WebGPU build) into public/ort.
import { copyFileSync, mkdirSync } from 'node:fs'

mkdirSync('public/ort', { recursive: true })
for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.wasm']) {
  copyFileSync(`node_modules/onnxruntime-web/dist/${f}`, `public/ort/${f}`)
}
