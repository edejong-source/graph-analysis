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

// Per-graph cache for bootstrap results. WeakMap key means a refreshGraph()
// that swaps plugin.g auto-invalidates: the old graph (and its cache entry)
// becomes unreachable and gets GC'd.
const bootstrapCache = new WeakMap<MyGraph, Map<string, unknown>>()

function getCache(graph: MyGraph): Map<string, unknown> {
  let m = bootstrapCache.get(graph)
  if (!m) {
    m = new Map()
    bootstrapCache.set(graph, m)
  }
  return m
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
  const cache = getCache(graph)
  const cacheKey = `scalar|${subtype}|${focalNode}|${iterations}|${fraction}|${seed}`
  const hit = cache.get(cacheKey) as BootstrapScalarMap | undefined
  if (hit) {
    onProgress(iterations, iterations)
    return hit
  }
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
  cache.set(cacheKey, out)
  return out
}

export async function bootstrapHITS(
  graph: MyGraph,
  options: BootstrapOptions,
  onProgress: ProgressCB,
): Promise<BootstrapHITSResult> {
  const { iterations, fraction, seed, yieldEvery } = options
  const cache = getCache(graph)
  const cacheKey = `hits|${iterations}|${fraction}|${seed}`
  const hit = cache.get(cacheKey) as BootstrapHITSResult | undefined
  if (hit) {
    onProgress(iterations, iterations)
    return hit
  }
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
  const result: BootstrapHITSResult = { authorities, hubs }
  cache.set(cacheKey, result)
  return result
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
  const cache = getCache(graph)
  const cacheKey = `comm|${subtype}|${focalNode}|${iterations}|${fraction}|${seed}`
  const hit = cache.get(cacheKey) as
    | { [node: string]: { prob: number; n: number } }
    | undefined
  if (hit) {
    onProgress(iterations, iterations)
    return hit
  }
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
  cache.set(cacheKey, out)
  return out
}

// Degree-preserving rewiring (configuration model). Same N nodes and same
// degree sequence as `graph`, but edges shuffled via double-edge swaps:
//   pick edges (a,b) and (c,d), if it's safe, replace with (a,d) and (c,b).
// Result is a uniform draw from graphs sharing the original degree sequence
// (asymptotically — after ~3*|E| accepted swaps).
function rewireDegreePreserving(
  graph: MyGraph,
  rng: () => number,
  swapsPerEdge = 3,
): MyGraph {
  const fresh = new MyGraph(graph.app, graph.settings)
  graph.forEachNode((node, attrs) => {
    fresh.addNode(node, { ...attrs })
  })

  type EdgeRec = { s: string; t: string; attrs: Record<string, unknown>; key: string }
  const edges: EdgeRec[] = []
  graph.forEachEdge((_key, attrs, s, t) => {
    if (s === t) return
    if (fresh.hasEdge(s, t)) return
    const newKey = fresh.addEdge(s, t, { ...attrs })
    edges.push({ s, t, attrs: { ...attrs }, key: newKey })
  })

  const target = edges.length * swapsPerEdge
  const maxAttempts = target * 10
  let done = 0
  let attempts = 0
  while (done < target && attempts < maxAttempts) {
    attempts++
    const i = Math.floor(rng() * edges.length)
    const j = Math.floor(rng() * edges.length)
    if (i === j) continue
    const eI = edges[i]
    const eJ = edges[j]
    if (eI.s === eJ.s || eI.s === eJ.t || eI.t === eJ.s || eI.t === eJ.t) continue
    if (fresh.hasEdge(eI.s, eJ.t) || fresh.hasEdge(eJ.s, eI.t)) continue
    fresh.dropEdge(eI.key)
    fresh.dropEdge(eJ.key)
    const newKeyI = fresh.addEdge(eI.s, eJ.t, { ...eI.attrs })
    const newKeyJ = fresh.addEdge(eJ.s, eI.t, { ...eJ.attrs })
    edges[i] = { s: eI.s, t: eJ.t, attrs: eI.attrs, key: newKeyI }
    edges[j] = { s: eJ.s, t: eI.t, attrs: eJ.attrs, key: newKeyJ }
    done++
  }
  return fresh
}

// Bootstrap against the configuration-model null: each iteration runs the
// metric on a fresh degree-preserving rewiring of `graph`. The resulting CI
// answers "what would this node's metric look like under chance, given the
// graph's degree sequence?" — observed CI clearing the null CI's upper bound
// is evidence the rank isn't a degree artifact.
export async function bootstrapScalarNull(
  graph: MyGraph,
  subtype: Subtype,
  focalNode: string,
  options: BootstrapOptions,
  onProgress: ProgressCB,
): Promise<BootstrapScalarMap> {
  const { iterations, fraction, seed, yieldEvery } = options
  const cache = getCache(graph)
  const cacheKey = `nullScalar|${subtype}|${focalNode}|${iterations}|${seed}`
  const hit = cache.get(cacheKey) as BootstrapScalarMap | undefined
  if (hit) {
    onProgress(iterations, iterations)
    return hit
  }
  const rng = mulberry32(seed ^ 0x9e3779b9)

  const perNodeSamples: { [node: string]: number[] } = {}
  const perNodeTopTenCount: { [node: string]: number } = {}
  const perNodeN: { [node: string]: number } = {}

  for (let b = 0; b < iterations; b++) {
    const nullGraph = rewireDegreePreserving(graph, rng)
    const raw = (await nullGraph.algs[subtype](focalNode)) as ResultMap
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
  cache.set(cacheKey, out)
  return out
  // Note: `fraction` is intentionally unused — null is full-edge rewiring,
  // not subsampling. It stays in the key for cache symmetry with the
  // observed bootstrap.
}

export async function bootstrapHITSNull(
  graph: MyGraph,
  options: BootstrapOptions,
  onProgress: ProgressCB,
): Promise<BootstrapHITSResult> {
  const { iterations, seed, yieldEvery } = options
  const cache = getCache(graph)
  const cacheKey = `nullHits|${iterations}|${seed}`
  const hit = cache.get(cacheKey) as BootstrapHITSResult | undefined
  if (hit) {
    onProgress(iterations, iterations)
    return hit
  }
  const rng = mulberry32(seed ^ 0x9e3779b9)

  const authSamples: { [node: string]: number[] } = {}
  const hubSamples: { [node: string]: number[] } = {}
  const authTopTen: { [node: string]: number } = {}
  const hubTopTen: { [node: string]: number } = {}
  const authN: { [node: string]: number } = {}
  const hubN: { [node: string]: number } = {}

  for (let b = 0; b < iterations; b++) {
    const nullGraph = rewireDegreePreserving(graph, rng)
    const res = (await nullGraph.algs.HITS('')) as HITSResult
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
  const result: BootstrapHITSResult = { authorities, hubs }
  cache.set(cacheKey, result)
  return result
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
