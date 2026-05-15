import type MyGraph from 'src/MyGraph'
import type {
  BootstrapAggregate,
  BootstrapHITSResult,
  BootstrapOptions,
  BootstrapScalarMap,
  CoCitationMap,
  Communities,
  HITSResult,
  ResultMap,
  Subtype,
} from 'src/Interfaces'

// Seedable PRNG (mulberry32) — fast, good enough for Monte Carlo and reproducible.
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type ProgressCB = (done: number, total: number) => void

async function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function aggregateScalar(
  samples: number[],
  topTenHits: number,
  n: number,
): BootstrapAggregate {
  if (samples.length === 0) {
    return { median: NaN, mean: NaN, ci_lo: NaN, ci_hi: NaN, stability: 0, n: 0 }
  }
  const sorted = samples.slice().sort((a, b) => a - b)
  const len = sorted.length
  const pct = (p: number) => {
    const idx = Math.min(len - 1, Math.max(0, Math.floor(p * (len - 1))))
    return sorted[idx]
  }
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    median: pct(0.5),
    mean: sum / len,
    ci_lo: pct(0.025),
    ci_hi: pct(0.975),
    stability: n > 0 ? topTenHits / n : 0,
    n,
  }
}

// Run the existing algs[subtype] on each subsample and collect per-node scalar
// `measure` values into per-node arrays. Then aggregate to {median, ci, stability}.
//
// For ResultMap-returning analyses, `focalNode` is the source. For HITS, pass
// undefined and use bootstrapHITS instead — HITS returns two metrics per node.
export async function bootstrapScalar(
  graph: MyGraph,
  subtype: Subtype,
  focalNode: string,
  options: BootstrapOptions,
  onProgress: ProgressCB,
): Promise<BootstrapScalarMap> {
  const { iterations, fraction, seed, yieldEvery } = options
  const rng = mulberry32(seed)

  const perNodeSamples: { [node: string]: number[] } = {}
  const perNodeTopTenCount: { [node: string]: number } = {}
  const perNodeN: { [node: string]: number } = {}

  for (let b = 0; b < iterations; b++) {
    const sample = graph.subsample(fraction, rng)
    const raw = (await sample.algs[subtype](focalNode)) as ResultMap
    const top10: string[] = topKByMeasure(raw, 10)
    for (const top of top10) {
      perNodeTopTenCount[top] = (perNodeTopTenCount[top] ?? 0) + 1
    }
    for (const to in raw) {
      const m = raw[to].measure
      if (m === Infinity || !Number.isFinite(m)) continue
      ;(perNodeSamples[to] ??= []).push(m)
      perNodeN[to] = (perNodeN[to] ?? 0) + 1
    }
    if ((b + 1) % yieldEvery === 0) {
      onProgress(b + 1, iterations)
      await yieldToMainThread()
    }
  }
  onProgress(iterations, iterations)

  const out: BootstrapScalarMap = {}
  for (const node in perNodeSamples) {
    out[node] = aggregateScalar(
      perNodeSamples[node],
      perNodeTopTenCount[node] ?? 0,
      perNodeN[node] ?? 0,
    )
  }
  return out
}

export async function bootstrapHITS(
  graph: MyGraph,
  options: BootstrapOptions,
  onProgress: ProgressCB,
): Promise<BootstrapHITSResult> {
  const { iterations, fraction, seed, yieldEvery } = options
  const rng = mulberry32(seed)

  const authSamples: { [node: string]: number[] } = {}
  const hubSamples: { [node: string]: number[] } = {}
  const authTopTen: { [node: string]: number } = {}
  const hubTopTen: { [node: string]: number } = {}
  const authN: { [node: string]: number } = {}
  const hubN: { [node: string]: number } = {}

  for (let b = 0; b < iterations; b++) {
    const sample = graph.subsample(fraction, rng)
    const res = (await sample.algs.HITS('')) as HITSResult
    const top10Auth = topKByDict(res.authorities, 10)
    const top10Hub = topKByDict(res.hubs, 10)
    for (const t of top10Auth) authTopTen[t] = (authTopTen[t] ?? 0) + 1
    for (const t of top10Hub) hubTopTen[t] = (hubTopTen[t] ?? 0) + 1
    for (const node in res.authorities) {
      const a = res.authorities[node]
      if (Number.isFinite(a)) {
        ;(authSamples[node] ??= []).push(a)
        authN[node] = (authN[node] ?? 0) + 1
      }
    }
    for (const node in res.hubs) {
      const h = res.hubs[node]
      if (Number.isFinite(h)) {
        ;(hubSamples[node] ??= []).push(h)
        hubN[node] = (hubN[node] ?? 0) + 1
      }
    }
    if ((b + 1) % yieldEvery === 0) {
      onProgress(b + 1, iterations)
      await yieldToMainThread()
    }
  }
  onProgress(iterations, iterations)

  const authorities: BootstrapScalarMap = {}
  const hubs: BootstrapScalarMap = {}
  for (const node in authSamples) {
    authorities[node] = aggregateScalar(
      authSamples[node],
      authTopTen[node] ?? 0,
      authN[node] ?? 0,
    )
  }
  for (const node in hubSamples) {
    hubs[node] = aggregateScalar(
      hubSamples[node],
      hubTopTen[node] ?? 0,
      hubN[node] ?? 0,
    )
  }
  return { authorities, hubs }
}

// For Louvain (returns string[] of focal's community) and Label Propagation
// (returns Communities dict). In each resample, count whether each candidate
// node ended up in the same community as focalNode. Return P(co-membership).
export async function bootstrapCommunityCoMembership(
  graph: MyGraph,
  subtype: 'Louvain' | 'Label Propagation',
  focalNode: string,
  options: BootstrapOptions,
  onProgress: ProgressCB,
): Promise<{ [node: string]: { prob: number; n: number } }> {
  const { iterations, fraction, seed, yieldEvery } = options
  const rng = mulberry32(seed)

  const hits: { [node: string]: number } = {}
  let total = 0

  for (let b = 0; b < iterations; b++) {
    const sample = graph.subsample(fraction, rng)
    if (!sample.hasNode(focalNode)) {
      if ((b + 1) % yieldEvery === 0) {
        onProgress(b + 1, iterations)
        await yieldToMainThread()
      }
      continue
    }
    total++
    if (subtype === 'Louvain') {
      const members = (await sample.algs.Louvain(focalNode)) as string[]
      for (const m of members) {
        if (m === focalNode) continue
        hits[m] = (hits[m] ?? 0) + 1
      }
    } else {
      const comms = (await sample.algs['Label Propagation'](focalNode, {
        iterations: 20,
      })) as Communities
      const focalLabel = findLabelOf(comms, focalNode)
      if (focalLabel !== null) {
        for (const m of comms[focalLabel]) {
          if (m === focalNode) continue
          hits[m] = (hits[m] ?? 0) + 1
        }
      }
    }
    if ((b + 1) % yieldEvery === 0) {
      onProgress(b + 1, iterations)
      await yieldToMainThread()
    }
  }
  onProgress(iterations, iterations)

  const out: { [node: string]: { prob: number; n: number } } = {}
  for (const node in hits) {
    out[node] = { prob: total > 0 ? hits[node] / total : 0, n: total }
  }
  return out
}

function findLabelOf(comms: Communities, node: string): string | null {
  for (const label in comms) {
    if (comms[label].includes(node)) return label
  }
  return null
}

function topKByMeasure(results: ResultMap | CoCitationMap, k: number): string[] {
  const pairs: [string, number][] = []
  for (const to in results) {
    const m = (results as ResultMap)[to].measure
    if (Number.isFinite(m)) pairs.push([to, m])
  }
  pairs.sort((a, b) => b[1] - a[1])
  return pairs.slice(0, k).map(([n]) => n)
}

function topKByDict(d: { [node: string]: number }, k: number): string[] {
  const pairs: [string, number][] = []
  for (const node in d) {
    const v = d[node]
    if (Number.isFinite(v)) pairs.push([node, v])
  }
  pairs.sort((a, b) => b[1] - a[1])
  return pairs.slice(0, k).map(([n]) => n)
}
