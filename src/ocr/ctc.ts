// Greedy CTC decoding of the recognition model's output.

export interface Decoded {
  text: string
  confidence: number
  /** Probability of each kept character, in order. */
  charConf: number[]
}

/**
 * probs: T x C row-major, class 0 is the CTC blank, class i maps to dict[i - 1].
 */
export function ctcDecode(probs: Float32Array | number[], steps: number, classes: number, dict: string[]): Decoded {
  let text = ''
  const charConf: number[] = []
  let prev = -1
  for (let t = 0; t < steps; t++) {
    let best = 0
    let bestP = -Infinity
    const row = t * classes
    for (let c = 0; c < classes; c++) {
      const p = probs[row + c]
      if (p > bestP) {
        bestP = p
        best = c
      }
    }
    if (best !== 0 && best !== prev) {
      text += dict[best - 1] ?? ''
      charConf.push(bestP)
    }
    prev = best
  }
  const confidence = charConf.length ? charConf.reduce((a, b) => a + b, 0) / charConf.length : 0
  return { text: text.trim(), confidence, charConf }
}
