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

/**
 * A barcode's guard bars are often read as quote marks inside its digits (290019"603498). In a word
 * of at least 4 digits, quote marks are dropped.
 */
export function cleanDigits(text: string): string {
  return text
    .split(' ')
    .map((w) => ((w.match(/[0-9]/g) ?? []).length >= 4 ? w.replace(/["'`\u2018\u2019\u201c\u201d]/g, '') : w))
    .join(' ')
}
