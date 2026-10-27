// Pixel work on RGBA ImageData: sharpness measure and the software preprocessing.

export function toGray(img: ImageData): Float32Array {
  const { data, width, height } = img
  const g = new Float32Array(width * height)
  for (let i = 0, p = 0; p < g.length; i += 4, p++) {
    g[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  return g
}

/** Variance of the Laplacian: low on blurred or shaken frames, high on sharp ones. */
export function laplacianVariance(gray: Float32Array, width: number, height: number): number {
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const v = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i]
      sum += v
      sumSq += v * v
      n++
    }
  }
  if (n === 0) return 0
  const mean = sum / n
  return sumSq / n - mean * mean
}

export function meanLuma(gray: Float32Array): number {
  let s = 0
  for (let i = 0; i < gray.length; i++) s += gray[i]
  return gray.length ? s / gray.length : 0
}

/** Luma value below which `fraction` of the pixels fall. */
export function percentile(gray: Float32Array, fraction: number): number {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[Math.max(0, Math.min(255, gray[i] | 0))]++
  const target = fraction * gray.length
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= target) return v
  }
  return 255
}

/**
 * Contrast stretch (1st-99th percentile to 0-255), brighten dark frames with a gamma curve,
 * then an unsharp mask. Changes `img` in place.
 */
export function preprocess(img: ImageData): void {
  const { data, width, height } = img
  const gray = toGray(img)
  const lo = percentile(gray, 0.01)
  const hi = Math.max(lo + 1, percentile(gray, 0.99))
  const mean = meanLuma(gray)
  // Dark frame: gamma below 1 lifts the shadows. Normal frame: no gamma.
  const gamma = mean < 90 ? Math.max(0.5, mean / 90) : 1
  const lut = new Uint8ClampedArray(256)
  for (let v = 0; v < 256; v++) {
    const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
    lut[v] = 255 * Math.pow(t, gamma)
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]]
    data[i + 1] = lut[data[i + 1]]
    data[i + 2] = lut[data[i + 2]]
  }
  unsharp(data, width, height, 0.8)
}

function unsharp(data: Uint8ClampedArray, width: number, height: number, amount: number): void {
  const src = new Uint8ClampedArray(data)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        const k = i + c
        const blur =
          (src[k - 4] + src[k + 4] + src[k - width * 4] + src[k + width * 4] + 4 * src[k]) / 8
        data[k] = src[k] + amount * (src[k] - blur)
      }
    }
  }
}
