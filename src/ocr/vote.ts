// Multi-frame voting: the same text read in several frames is aligned character by character
// against a reference read, and each position takes the character with the most weight.

export interface FrameRead {
  text: string
  confidence: number
  /** Weight of the frame the read came from (sharper frames count more). */
  weight: number
  /** Which frame of the scan it came from. */
  frame: number
  /** Centre of the text in the frame, 0-1 from the left and from the top. */
  x?: number
  y?: number
  /** Height of the text as a share of the frame height. */
  h?: number
  /** With a crosshair: pixels from it. */
  d?: number
}

export interface VotedRead {
  text: string
  /** Average share of the weight that agreed on each position, 0-1. */
  agreement: number
  /** In how many frames this text was seen. */
  frames: number
  confidence: number
  x: number
  y: number
  h: number
  /** With a crosshair: the nearest any frame read this text from it. */
  d?: number
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1))
      prevDiag = tmp
    }
  }
  return dp[b.length]
}

export function similar(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  if (len === 0) return true
  return levenshtein(a, b) / len <= 0.4
}

/** For each position of `ref`, the character of `s` aligned to it ('' when `s` skips it). */
export function alignTo(ref: string, s: string): string[] {
  const n = ref.length
  const m = s.length
  const dp: number[][] = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (ref[i - 1] === s[j - 1] ? 0 : 1),
      )
    }
  }
  const out: string[] = new Array(n).fill('')
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (dp[i][j] === dp[i - 1][j - 1] + (ref[i - 1] === s[j - 1] ? 0 : 1)) {
      out[i - 1] = s[j - 1]
      i--
      j--
    } else if (dp[i][j] === dp[i - 1][j] + 1) {
      i--
    } else {
      j--
    }
  }
  return out
}

/** Groups reads of the same text and votes each group into one string. */
export function vote(reads: FrameRead[]): VotedRead[] {
  const groups: FrameRead[][] = []
  for (const r of reads) {
    if (!r.text) continue
    const g = groups.find((grp) => similar(grp[0].text, r.text))
    if (g) g.push(r)
    else groups.push([r])
  }
  return groups
    .map((g) => voteGroup(g))
    .sort((a, b) => b.frames - a.frames || b.agreement * b.confidence - a.agreement * a.confidence)
}

function voteGroup(group: FrameRead[]): VotedRead {
  // Reference: the most common length (by weight), and within it the read with the most weight.
  const byLen = new Map<number, number>()
  for (const r of group) byLen.set(r.text.length, (byLen.get(r.text.length) ?? 0) + r.weight * r.confidence)
  const refLen = [...byLen.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const ref = group
    .filter((r) => r.text.length === refLen)
    .sort((a, b) => b.weight * b.confidence - a.weight * a.confidence)[0].text

  const aligned = group.map((r) => alignTo(ref, r.text))
  let text = ''
  let agreementSum = 0
  for (let pos = 0; pos < ref.length; pos++) {
    const tally = new Map<string, number>()
    let total = 0
    for (const [k, r] of group.entries()) {
      const ch = aligned[k][pos]
      const w = r.weight * r.confidence
      tally.set(ch, (tally.get(ch) ?? 0) + w)
      total += w
    }
    const [bestCh, bestW] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
    text += bestCh
    agreementSum += total ? bestW / total : 0
  }
  const avg = (f: (r: FrameRead) => number) => group.reduce((a, r) => a + f(r), 0) / group.length
  return {
    text,
    agreement: ref.length ? agreementSum / ref.length : 0,
    frames: new Set(group.map((r) => r.frame)).size,
    confidence: avg((r) => r.confidence),
    x: avg((r) => r.x ?? 0),
    y: avg((r) => r.y ?? 0),
    h: avg((r) => r.h ?? 0),
    d: group.some((r) => r.d !== undefined) ? Math.min(...group.map((r) => r.d ?? Infinity)) : undefined,
  }
}

/** Top to bottom; texts on the same row (centres closer than half a text height) left to right. */
export function inReadingOrder<T extends { x: number; y: number; h: number }>(reads: T[]): T[] {
  return [...reads].sort((a, b) => {
    const sameRow = Math.abs(a.y - b.y) < Math.max(a.h, b.h) / 2
    return sameRow ? a.x - b.x : a.y - b.y
  })
}
