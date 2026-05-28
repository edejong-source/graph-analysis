<script lang="ts">
  import type { App } from 'obsidian'
  import { hoverPreview, isInVault, isLinked } from 'obsidian-community-lib'
  import type AnalysisView from 'src/AnalysisView'
  import {
    ANALYSIS_TYPES,
    ICON,
    LINKED,
    MEASURE,
    NOT_LINKED,
  } from 'src/Constants'
  import type {
    BootstrapHITSResult,
    GraphAnalysisSettings,
    HITSResult,
    Subtype,
  } from 'src/Interfaces'
  import type GraphAnalysisPlugin from 'src/main'
  import { bootstrapHITS, bootstrapHITSNull } from 'src/Bootstrap'
  import {
    classExt,
    csvEscape,
    downloadCSV,
    dropPath,
    fmtNum,
    getImgBufferPromise,
    isImg,
    openMenu,
    openOrSwitch,
    presentPath,
    roundNumber,
  } from 'src/Utility'
  import { onMount } from 'svelte'
  import FaLink from 'svelte-icons/fa/FaLink.svelte'
  import InfiniteScroll from 'svelte-infinite-scroll'
  import CIBar from './CIBar.svelte'
  import ExtensionIcon from './ExtensionIcon.svelte'
  import ImgThumbnail from './ImgThumbnail.svelte'
  import SubtypeOptions from './SubtypeOptions.svelte'

  function computeCIRange(
    data: ComponentResults[],
    loKey: 'auth_ci_lo' | 'hub_ci_lo',
    hiKey: 'auth_ci_hi' | 'hub_ci_hi',
    nullLoKey: 'auth_null_ci_lo' | 'hub_null_ci_lo',
    nullHiKey: 'auth_null_ci_hi' | 'hub_null_ci_hi',
    withNull: boolean,
  ): [number, number] {
    let lo = Infinity, hi = -Infinity
    for (const r of data) {
      const l = r[loKey], h = r[hiKey]
      if (Number.isFinite(l)) lo = Math.min(lo, l as number)
      if (Number.isFinite(h)) hi = Math.max(hi, h as number)
      if (withNull) {
        const nl = r[nullLoKey], nh = r[nullHiKey]
        if (Number.isFinite(nl)) lo = Math.min(lo, nl as number)
        if (Number.isFinite(nh)) hi = Math.max(hi, nh as number)
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
    if (lo === hi) return [lo - 0.5, hi + 0.5]
    return [lo, hi]
  }

  function computeRankRange(
    data: ComponentResults[],
    hiKey: 'auth_rank_ci_hi' | 'hub_rank_ci_hi',
  ): [number, number] {
    let hi = 1
    for (const r of data) {
      const v = r[hiKey]
      if (Number.isFinite(v)) hi = Math.max(hi, v as number)
    }
    return [1, Math.max(2, hi)]
  }

  export let app: App
  export let plugin: GraphAnalysisPlugin
  export let settings: GraphAnalysisSettings
  export let view: AnalysisView
  export let currSubtype: Subtype

  $: currSubtypeInfo = ANALYSIS_TYPES.find((sub) => sub.subtype === currSubtype)

  let sortBy = true
  let ascOrder = false
  let { noInfinity, noZero } = settings
  let bootstrapEnabled = settings.bootstrapEnabledDefault
  let nullEnabled = settings.bootstrapNullEnabledDefault
  let progress = 1
  let currFile = app.workspace.getActiveFile()

  interface ComponentResults {
    authority: number
    hub: number
    to: string
    resolved: boolean
    img: Promise<ArrayBuffer> | null
    auth_ci_lo?: number
    auth_ci_hi?: number
    auth_stability?: number
    hub_ci_lo?: number
    hub_ci_hi?: number
    hub_stability?: number
    auth_null_ci_lo?: number
    auth_null_ci_hi?: number
    hub_null_ci_lo?: number
    hub_null_ci_hi?: number
    auth_sig?: boolean
    hub_sig?: boolean
    auth_rank_median?: number
    auth_rank_ci_lo?: number
    auth_rank_ci_hi?: number
    hub_rank_median?: number
    hub_rank_ci_lo?: number
    hub_rank_ci_hi?: number
  }

  $: currNode = currFile?.path
  let size = 50
  let current_component: HTMLElement
  let newBatch: ComponentResults[] = []
  let visibleData: ComponentResults[] = []
  let page = 0
  let blockSwitch = false

  $: authCIRange = computeCIRange(
    visibleData,
    'auth_ci_lo',
    'auth_ci_hi',
    'auth_null_ci_lo',
    'auth_null_ci_hi',
    nullEnabled,
  )
  $: hubCIRange = computeCIRange(
    visibleData,
    'hub_ci_lo',
    'hub_ci_hi',
    'hub_null_ci_lo',
    'hub_null_ci_hi',
    nullEnabled,
  )
  $: authRankRange = computeRankRange(visibleData, 'auth_rank_ci_hi')
  $: hubRankRange = computeRankRange(visibleData, 'hub_rank_ci_hi')

  app.workspace.on('file-open', (activeFile) => {
    blockSwitch = true
    setTimeout(() => {
      blockSwitch = false
      currFile = activeFile
    }, 100)
    newBatch = []
  })

  onMount(() => {})

  function sortAndFinalize(componentResults: ComponentResults[]): ComponentResults[] {
    const greater = ascOrder ? 1 : -1
    const lesser = ascOrder ? -1 : 1
    componentResults.sort((a, b) => {
      return sortBy
        ? a.authority > b.authority
          ? greater
          : lesser
        : a.hub > b.hub
        ? greater
        : lesser
    })
    return componentResults
  }

  $: promiseSortedResults = !plugin.g
    ? null
    : (bootstrapEnabled
        ? (progress = 0,
          (async () => {
            const opts = {
              iterations: plugin.settings.bootstrapIterations,
              fraction: plugin.settings.bootstrapFraction,
              seed: plugin.settings.bootstrapSeed,
              yieldEvery: 10,
            }
            const agg: BootstrapHITSResult = await bootstrapHITS(
              plugin.g,
              opts,
              (d, t) => (progress = d / t),
            )
            let nullAgg: BootstrapHITSResult | null = null
            if (nullEnabled) {
              progress = 0
              nullAgg = await bootstrapHITSNull(
                plugin.g,
                opts,
                (d, t) => (progress = d / t),
              )
            }
            const componentResults: ComponentResults[] = []
            plugin.g.forEachNode((to) => {
              const authAgg = agg.authorities[to]
              const hubAgg = agg.hubs[to]
              const authority = roundNumber(authAgg?.median ?? 0)
              const hub = roundNumber(hubAgg?.median ?? 0)
              if (!(authority === 0 && hub === 0)) {
                const resolved = !to.endsWith('.md') || isInVault(app, to)
                const img =
                  plugin.settings.showImgThumbnails && isImg(to)
                    ? getImgBufferPromise(app, to)
                    : null
                const authNull = nullAgg?.authorities[to]
                const hubNull = nullAgg?.hubs[to]
                const auth_sig =
                  authNull !== undefined &&
                  Number.isFinite(authAgg?.ci_lo) &&
                  Number.isFinite(authNull.ci_hi) &&
                  authAgg.ci_lo > authNull.ci_hi
                const hub_sig =
                  hubNull !== undefined &&
                  Number.isFinite(hubAgg?.ci_lo) &&
                  Number.isFinite(hubNull.ci_hi) &&
                  hubAgg.ci_lo > hubNull.ci_hi
                componentResults.push({
                  authority,
                  hub,
                  to,
                  resolved,
                  img,
                  auth_ci_lo: authAgg?.ci_lo,
                  auth_ci_hi: authAgg?.ci_hi,
                  auth_stability: authAgg?.stability,
                  hub_ci_lo: hubAgg?.ci_lo,
                  hub_ci_hi: hubAgg?.ci_hi,
                  hub_stability: hubAgg?.stability,
                  auth_null_ci_lo: authNull?.ci_lo,
                  auth_null_ci_hi: authNull?.ci_hi,
                  hub_null_ci_lo: hubNull?.ci_lo,
                  hub_null_ci_hi: hubNull?.ci_hi,
                  auth_sig,
                  hub_sig,
                  auth_rank_median: authAgg?.rank_median,
                  auth_rank_ci_lo: authAgg?.rank_ci_lo,
                  auth_rank_ci_hi: authAgg?.rank_ci_hi,
                  hub_rank_median: hubAgg?.rank_median,
                  hub_rank_ci_lo: hubAgg?.rank_ci_lo,
                  hub_rank_ci_hi: hubAgg?.rank_ci_hi,
                })
              }
            })
            return sortAndFinalize(componentResults)
          })())
        : plugin.g.algs['HITS']('').then((results: HITSResult) => {
            const componentResults: ComponentResults[] = []
            plugin.g.forEachNode((to) => {
              const authority = roundNumber(results.authorities[to])
              const hub = roundNumber(results.hubs[to])
              if (!(authority === 0 && hub === 0)) {
                const resolved = !to.endsWith('.md') || isInVault(app, to)
                const img =
                  plugin.settings.showImgThumbnails && isImg(to)
                    ? getImgBufferPromise(app, to)
                    : null
                componentResults.push({ authority, hub, to, resolved, img })
              }
            })
            return sortAndFinalize(componentResults)
          })
      ).then((res: ComponentResults[]) => {
        newBatch = res.slice(0, size)
        setTimeout(() => {
          blockSwitch = false
        }, 100)
        return res
      })

  $: visibleData = [...visibleData, ...newBatch]

  async function exportCSV() {
    if (!promiseSortedResults) return
    const data = await promiseSortedResults
    const useCI = bootstrapEnabled
    const useNull = useCI && nullEnabled
    const header = useCI
      ? [
          'note',
          'authority_median', 'auth_ci_lo', 'auth_ci_hi', 'auth_stability',
          ...(useNull ? ['auth_null_ci_lo', 'auth_null_ci_hi', 'auth_sig'] : []),
          'auth_rank_median', 'auth_rank_ci_lo', 'auth_rank_ci_hi',
          'hub_median', 'hub_ci_lo', 'hub_ci_hi', 'hub_stability',
          ...(useNull ? ['hub_null_ci_lo', 'hub_null_ci_hi', 'hub_sig'] : []),
          'hub_rank_median', 'hub_rank_ci_lo', 'hub_rank_ci_hi',
        ]
      : ['note', 'authority', 'hub']
    const lines = [header.join(',')]
    for (const r of data) {
      const fields = useCI
        ? [
            r.to,
            fmtNum(r.authority), fmtNum(r.auth_ci_lo, 3), fmtNum(r.auth_ci_hi, 3), fmtNum(r.auth_stability, 3),
            ...(useNull ? [fmtNum(r.auth_null_ci_lo, 3), fmtNum(r.auth_null_ci_hi, 3), r.auth_sig ? '1' : '0'] : []),
            fmtNum(r.auth_rank_median, 1), fmtNum(r.auth_rank_ci_lo, 1), fmtNum(r.auth_rank_ci_hi, 1),
            fmtNum(r.hub), fmtNum(r.hub_ci_lo, 3), fmtNum(r.hub_ci_hi, 3), fmtNum(r.hub_stability, 3),
            ...(useNull ? [fmtNum(r.hub_null_ci_lo, 3), fmtNum(r.hub_null_ci_hi, 3), r.hub_sig ? '1' : '0'] : []),
            fmtNum(r.hub_rank_median, 1), fmtNum(r.hub_rank_ci_lo, 1), fmtNum(r.hub_rank_ci_hi, 1),
          ]
        : [r.to, fmtNum(r.authority), fmtNum(r.hub)]
      lines.push(fields.map(csvEscape).join(','))
    }
    const stamp = new Date().toISOString().split('T')[0]
    const tag = useCI ? 'bootstrap-HITS' : 'HITS'
    downloadCSV(lines.join('\n'), `graph-analysis-${tag}-${stamp}.csv`)
  }

  onMount(() => {
    currFile = app.workspace.getActiveFile()
  })
</script>

<SubtypeOptions
  bind:currSubtypeInfo
  bind:noZero
  bind:ascOrder
  bind:sortBy
  bind:currFile
  {app}
  {plugin}
  {view}
  bind:blockSwitch
  bind:newBatch
  bind:visibleData
  bind:promiseSortedResults
  bind:page
  bind:bootstrapEnabled
  bind:nullEnabled
  {exportCSV}
/>

{#if bootstrapEnabled && progress < 1}
  <div class="GA-progress-track">
    <div class="GA-progress-bar" style="width: {(progress * 100).toFixed(1)}%" />
  </div>
{/if}

<table class="GA-table markdown-preview-view" bind:this={current_component}>
  <thead>
    <tr>
      <th scope="col">Note</th>
      <th scope="col">Authority</th>
      {#if bootstrapEnabled}
        <th scope="col" aria-label="95% bootstrap CI for authority (null overlay when enabled)">CI (A)</th>
        <th scope="col" aria-label="95% CI on authority rank across resamples (1 = highest, lower is better)">Rank (A)</th>
        <th scope="col" aria-label="Top-10 frequency for authority">Top-10 (A)</th>
      {/if}
      <th scope="col">Hub</th>
      {#if bootstrapEnabled}
        <th scope="col" aria-label="95% bootstrap CI for hub (null overlay when enabled)">CI (H)</th>
        <th scope="col" aria-label="95% CI on hub rank across resamples (1 = highest, lower is better)">Rank (H)</th>
        <th scope="col" aria-label="Top-10 frequency for hub">Top-10 (H)</th>
      {/if}
    </tr>
  </thead>
  {#if promiseSortedResults}
    {#await promiseSortedResults then sortedResults}
      {#key sortedResults}
        {#each visibleData as node}
          {#if node !== undefined}
            <!-- svelte-ignore a11y-unknown-aria-attribute -->
            <tr
              class="
              {classExt(node.to)}"
              class:GA-sig={node.auth_sig || node.hub_sig}
            >
              <td
                on:click={async (e) => await openOrSwitch(app, node.to, e)}
                on:contextmenu={(e) => openMenu(e, app)}
                on:mouseover={(e) => hoverPreview(e, view, dropPath(node.to))}
              >
                <ExtensionIcon path={node.to} />

                <span
                  class="internal-link 
                  {node.resolved ? '' : 'is-unresolved'} 
                    {currNode === node.to ? 'currNode' : ''}"
                >
                  {presentPath(node.to)}
                </span>
                {#if isImg(node.to)}
                  <ImgThumbnail img={node.img} />
                {/if}
              </td>
              <td class={MEASURE}>{node.authority}</td>
              {#if bootstrapEnabled}
                <td class={MEASURE}>
                  <CIBar
                    ciLo={node.auth_ci_lo}
                    ciHi={node.auth_ci_hi}
                    median={node.authority}
                    nullCiLo={nullEnabled ? node.auth_null_ci_lo : undefined}
                    nullCiHi={nullEnabled ? node.auth_null_ci_hi : undefined}
                    range={authCIRange}
                    sig={!!node.auth_sig}
                    label={`Authority 95% CI [${(node.auth_ci_lo ?? 0).toFixed(3)}, ${(node.auth_ci_hi ?? 0).toFixed(3)}]${nullEnabled && Number.isFinite(node.auth_null_ci_lo) ? `; null [${(node.auth_null_ci_lo ?? 0).toFixed(3)}, ${(node.auth_null_ci_hi ?? 0).toFixed(3)}]${node.auth_sig ? ' (significant)' : ''}` : ''}`}
                  />
                </td>
                <td class={MEASURE}>
                  <CIBar
                    ciLo={node.auth_rank_ci_lo}
                    ciHi={node.auth_rank_ci_hi}
                    median={node.auth_rank_median}
                    range={authRankRange}
                    label={`Authority rank 95% CI [${Number.isFinite(node.auth_rank_ci_lo) ? Math.round(node.auth_rank_ci_lo) : '—'}, ${Number.isFinite(node.auth_rank_ci_hi) ? Math.round(node.auth_rank_ci_hi) : '—'}]`}
                  />
                </td>
                <td class={MEASURE}>{((node.auth_stability ?? 0) * 100).toFixed(0)}%</td>
              {/if}
              <td class={MEASURE}>{node.hub}</td>
              {#if bootstrapEnabled}
                <td class={MEASURE}>
                  <CIBar
                    ciLo={node.hub_ci_lo}
                    ciHi={node.hub_ci_hi}
                    median={node.hub}
                    nullCiLo={nullEnabled ? node.hub_null_ci_lo : undefined}
                    nullCiHi={nullEnabled ? node.hub_null_ci_hi : undefined}
                    range={hubCIRange}
                    sig={!!node.hub_sig}
                    label={`Hub 95% CI [${(node.hub_ci_lo ?? 0).toFixed(3)}, ${(node.hub_ci_hi ?? 0).toFixed(3)}]${nullEnabled && Number.isFinite(node.hub_null_ci_lo) ? `; null [${(node.hub_null_ci_lo ?? 0).toFixed(3)}, ${(node.hub_null_ci_hi ?? 0).toFixed(3)}]${node.hub_sig ? ' (significant)' : ''}` : ''}`}
                  />
                </td>
                <td class={MEASURE}>
                  <CIBar
                    ciLo={node.hub_rank_ci_lo}
                    ciHi={node.hub_rank_ci_hi}
                    median={node.hub_rank_median}
                    range={hubRankRange}
                    label={`Hub rank 95% CI [${Number.isFinite(node.hub_rank_ci_lo) ? Math.round(node.hub_rank_ci_lo) : '—'}, ${Number.isFinite(node.hub_rank_ci_hi) ? Math.round(node.hub_rank_ci_hi) : '—'}]`}
                  />
                </td>
                <td class={MEASURE}>{((node.hub_stability ?? 0) * 100).toFixed(0)}%</td>
              {/if}
            </tr>
          {/if}
        {/each}

        <InfiniteScroll
          hasMore={sortedResults.length > visibleData.length}
          threshold={100}
          elementScroll={current_component.parentNode}
          on:loadMore={() => {
            if (!blockSwitch) {
              page++
              newBatch = sortedResults.slice(size * page, size * (page + 1) - 1)
              console.log({ newBatch })
            }
          }}
        />
        {visibleData.length} / {sortedResults.length}
      {/key}
    {/await}
  {/if}
</table>

<style>
  table.GA-table {
    border-collapse: collapse;
  }
  table.GA-table,
  table.GA-table tr,
  table.GA-table td {
    border: 1px solid var(--background-modifier-border);
  }

  table.GA-table td {
    padding: 2px;
    /* font-size: var(--font-size-secondary); */
  }

  .is-unresolved {
    color: var(--text-muted);
  }

  .GA-node {
    overflow: hidden;
  }

  .currNode {
    font-weight: bold;
  }

  .GA-progress-track {
    height: 3px;
    background-color: var(--background-modifier-border);
    margin: 4px 0;
    border-radius: 2px;
    overflow: hidden;
  }
  .GA-progress-bar {
    height: 100%;
    background-color: var(--interactive-accent);
    transition: width 0.1s linear;
  }
</style>
