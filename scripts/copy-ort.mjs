// Copies the onnxruntime-web wasm binary into public/ort so it is served next to the app.
import { copyFileSync, mkdirSync } from 'node:fs'

mkdirSync('public/ort', { recursive: true })
copyFileSync('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'public/ort/ort-wasm-simd-threaded.wasm')
