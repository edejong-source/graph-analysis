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
    GraphAnalysisSettings,
    ResultMap,
    Subtype,
  } from 'src/Interfaces'
  import type GraphAnalysisPlugin from 'src/main'
  import { bootstrapScalar, bootstrapScalarNull } from 'src/Bootstrap'
  import type { BootstrapScalarMap } from 'src/Interfaces'
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
  } from 'src/Utility'
  import { onMount } from 'svelte'
  import FaLink from 'svelte-icons/fa/FaLink.svelte'
  import InfiniteScroll from 'svelte-infinite-scroll'
  import CIBar from './CIBar.svelte'
  import ExtensionIcon from './ExtensionIcon.svelte'
  import ImgThumbnail from './ImgThumbnail.svelte'
  import SubtypeOptions from './SubtypeOptions.svelte'

  function computeCIRange(data: ComponentResults[], withNull: boolean): [number, number] {
    let lo = Infinity, hi = -Infinity
    for (const r of data) {
      if (Number.isFinite(r.ci_lo)) lo = Math.min(lo, r.ci_lo)
      if (Number.isFinite(r.ci_hi)) hi = Math.max(hi, r.ci_hi)
      if (withNull) {
        if (Number.isFinite(r.null_ci_lo)) lo = Math.min(lo, r.null_ci_lo as number)
        if (Number.isFinite(r.null_ci_hi)) hi = Math.max(hi, r.null_ci_hi as number)
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
    if (lo === hi) return [lo - 0.5, hi + 0.5]
    return [lo, hi]
  }

  function computeRankRange(data: ComponentResults[]): [number, number] {
    let hi = 1
    for (const r of data) {
      if (Number.isFinite(r.rank_ci_hi)) hi = Math.max(hi, r.rank_ci_hi as number)
    }
    return [1, Math.max(2, hi)]
  }

  export let app: App
  export let plugin: GraphAnalysisPlugin
  export let settings: GraphAnalysisSettings
  export let view: AnalysisView
  export let currSubtype: Subtype

  $: currSubtypeInfo = ANALYSIS_TYPES.find((sub) => sub.subtype === currSubtype)
  let frozen = false
  let ascOrder = false
  let { noInfinity, noZero } = settings
  let bootstrapEnabled = settings.bootstrapEnabledDefault
  let nullEnabled = settings.bootstrapNullEnabledDefault
  let progress = 1
  let currFile = app.workspace.getActiveFile()

  interface ComponentResults {
    measure: number
    linked: boolean
    to: string
    resolved: boolean
    extra: string[]
    img: Promise<ArrayBuffer> | null
    ci_lo?: number
    ci_hi?: number
    stability?: number
    n?: number
    null_ci_lo?: number
    null_ci_hi?: number
    sig?: boolean
    rank_median?: number
    rank_ci_lo?: number
    rank_ci_hi?: number
  }

  $: currNode = currFile?.path
  let size = 50
  let current_component: HTMLElement
  let newBatch: ComponentResults[] = []
  let visibleData: ComponentResults[] = []
  let page = 0
  let blockSwitch = false

  $: ciRange = computeCIRange(visibleData, nullEnabled)
  $: rankRange = computeRankRange(visibleData)

  let { resolvedLinks } = app.metadataCache

  app.workspace.on('file-open', (activeFile) => {
    if (!frozen && !currSubtypeInfo.global) {
      blockSwitch = true
      newBatch = []
      visibleData = []
      promiseSortedResults = null
      page = 0

      setTimeout(() => (currFile = activeFile), 100)
    }
  })

  onMount(() => {
    currNode = currFile?.path
  })

  function buildRowsFromPointEstimate(results: ResultMap): ComponentResults[] {
    const greater = ascOrder ? 1 : -1
    const lesser = ascOrder ? -1 : 1
    const componentResults: ComponentResults[] = []

    Object.keys(results).forEach((to) => {
      const { measure, extra } = results[to]
      if (
        !(noInfinity && measure === Infinity) &&
        !(noZero && measure === 0)
      ) {
        const resolved = !to.endsWith('.md') || isInVault(app, to)
        const linked = isLinked(resolvedLinks, currNode, to, false)
        const img =
          plugin.settings.showImgThumbnails && isImg(to)
            ? getImgBufferPromise(app, to)
            : null
        componentResults.push({ measure, linked, to, resolved, extra, img })
      }
    })
    componentResults.sort((a, b) => {
      return a.measure === b.measure
        ? a.extra?.length > b.extra?.length
          ? greater
          : lesser
        : a.measure > b.measure
        ? greater
        : lesser
    })
    return componentResults
  }

  function buildRowsFromBootstrap(
    agg: BootstrapScalarMap,
    nullAgg: BootstrapScalarMap | null,
  ): ComponentResults[] {
    const greater = ascOrder ? 1 : -1
    const lesser = ascOrder ? -1 : 1
    const componentResults: ComponentResults[] = []
    Object.keys(agg).forEach((to) => {
      const { median, ci_lo, ci_hi, stability, n, rank_median, rank_ci_lo, rank_ci_hi } = agg[to]
      if (!(noInfinity && !Number.isFinite(median)) && !(noZero && median === 0)) {
        const resolved = !to.endsWith('.md') || isInVault(app, to)
        const linked = isLinked(resolvedLinks, currNode, to, false)
        const img =
          plugin.settings.showImgThumbnails && isImg(to)
            ? getImgBufferPromise(app, to)
            : null
        const nullRec = nullAgg?.[to]
        const sig =
          nullRec !== undefined &&
          Number.isFinite(ci_lo) &&
          Number.isFinite(nullRec.ci_hi) &&
          ci_lo > nullRec.ci_hi
        componentResults.push({
          measure: median,
          linked,
          to,
          resolved,
          extra: [],
          img,
          ci_lo,
          ci_hi,
          stability,
          n,
          null_ci_lo: nullRec?.ci_lo,
          null_ci_hi: nullRec?.ci_hi,
          sig,
          rank_median,
          rank_ci_lo,
          rank_ci_hi,
        })
      }
    })
    componentResults.sort((a, b) => {
      return a.measure === b.measure ? lesser : a.measure > b.measure ? greater : lesser
    })
    return componentResults
  }

  $: promiseSortedResults =
    !plugin.g || !currNode
      ? null
      : (bootstrapEnabled && currSubtypeInfo?.supportsBootstrap
          ? (progress = 0,
            (async () => {
              const opts = {
                iterations: plugin.settings.bootstrapIterations,
                fraction: plugin.settings.bootstrapFraction,
                seed: plugin.settings.bootstrapSeed,
                yieldEvery: 20,
              }
              const obs = await bootstrapScalar(
                plugin.g,
                currSubtype,
                currNode,
                opts,
                (d, t) => (progress = d / t),
              )
              if (!nullEnabled) return buildRowsFromBootstrap(obs, null)
              progress = 0
              const nul = await bootstrapScalarNull(
                plugin.g,
                currSubtype,
                currNode,
                opts,
                (d, t) => (progress = d / t),
              )
              return buildRowsFromBootstrap(obs, nul)
            })())
          : plugin.g.algs[currSubtype](currNode).then((r) =>
              buildRowsFromPointEstimate(r as ResultMap),
            )
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
    const useCI = bootstrapEnabled && currSubtypeInfo?.supportsBootstrap
    const useNull = useCI && nullEnabled
    const header = useCI
      ? [
          'note', 'median', 'ci_lo', 'ci_hi',
          ...(useNull ? ['null_ci_lo', 'null_ci_hi', 'sig'] : []),
          'rank_median', 'rank_ci_lo', 'rank_ci_hi',
          'stability', 'n',
        ]
      : ['note', 'measure', 'extra']
    const lines = [header.join(',')]
    for (const r of data) {
      const fields = useCI
        ? [
            r.to, fmtNum(r.measure), fmtNum(r.ci_lo), fmtNum(r.ci_hi),
            ...(useNull
              ? [fmtNum(r.null_ci_lo, 3), fmtNum(r.null_ci_hi, 3), r.sig ? '1' : '0']
              : []),
            fmtNum(r.rank_median, 1), fmtNum(r.rank_ci_lo, 1), fmtNum(r.rank_ci_hi, 1),
            fmtNum(r.stability, 3), String(r.n ?? ''),
          ]
        : [r.to, fmtNum(r.measure), (r.extra ?? []).join(';')]
      lines.push(fields.map(csvEscape).join(','))
    }
    const stamp = new Date().toISOString().split('T')[0]
    const tag = useCI ? `bootstrap-${currSubtype}` : String(currSubtype)
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
  bind:currFile
  bind:frozen
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

{#if bootstrapEnabled && currSubtypeInfo?.supportsBootstrap && progress < 1}
  <div class="GA-progress-track">
    <div class="GA-progress-bar" style="width: {(progress * 100).toFixed(1)}%" />
  </div>
{/if}

<table class="GA-table markdown-preview-view" bind:this={current_component}>
  <thead>
    <tr>
      <th scope="col">Note</th>
      <th scope="col">{bootstrapEnabled && currSubtypeInfo?.supportsBootstrap ? 'Median' : 'Value'}</th>
      {#if bootstrapEnabled && currSubtypeInfo?.supportsBootstrap}
        <th scope="col" aria-label="95% bootstrap confidence interval (with configuration-model null overlay when enabled)">95% CI</th>
        <th scope="col" aria-label="95% CI on this note's rank across resamples (1 = highest measure, lower is better)">Rank 95%</th>
        <th scope="col" aria-label="Fraction of resamples where this note ranked in the top 10">Top-10</th>
      {/if}
    </tr>
  </thead>
  {#if promiseSortedResults}
    {#await promiseSortedResults then sortedResults}
      {#key sortedResults}
        {#each visibleData as node}
          {#if (currSubtypeInfo.global || node.to !== currNode) && node !== undefined}
            <!-- svelte-ignore a11y-unknown-aria-attribute -->
            <tr
              class="{node.linked ? LINKED : NOT_LINKED}
            {classExt(node.to)}"
              class:GA-sig={node.sig}
            >
              <td
                aria-label={node.extra.map(presentPath).join('\n')}
                aria-label-position="left"
                on:click={async (e) => await openOrSwitch(app, node.to, e)}
                on:contextmenu={(e) => openMenu(e, app)}
                on:mouseover={(e) => hoverPreview(e, view, dropPath(node.to))}
              >
                {#if node.linked}
                  <span class={ICON}>
                    <FaLink />
                  </span>
                {/if}

                <ExtensionIcon path={node.to} />

                <span
                  class="internal-link {node.resolved ? '' : 'is-unresolved'}"
                >
                  {presentPath(node.to)}
                </span>
                {#if isImg(node.to)}
                  <ImgThumbnail img={node.img} />
                {/if}
              </td>
              <td class={MEASURE}>{Number.isFinite(node.measure) ? node.measure.toFixed(4) : '∞'}</td>
              {#if bootstrapEnabled && currSubtypeInfo?.supportsBootstrap}
                <td class={MEASURE}>
                  <CIBar
                    ciLo={node.ci_lo}
                    ciHi={node.ci_hi}
                    median={node.measure}
                    nullCiLo={nullEnabled ? node.null_ci_lo : undefined}
                    nullCiHi={nullEnabled ? node.null_ci_hi : undefined}
                    range={ciRange}
                    sig={!!node.sig}
                    label={`95% CI [${(node.ci_lo ?? 0).toFixed(3)}, ${(node.ci_hi ?? 0).toFixed(3)}]${nullEnabled && Number.isFinite(node.null_ci_lo) ? `; null [${(node.null_ci_lo ?? 0).toFixed(3)}, ${(node.null_ci_hi ?? 0).toFixed(3)}]${node.sig ? ' (significant)' : ''}` : ''}`}
                  />
                </td>
                <td class={MEASURE}>
                  <CIBar
                    ciLo={node.rank_ci_lo}
                    ciHi={node.rank_ci_hi}
                    median={node.rank_median}
                    range={rankRange}
                    label={`Rank 95% CI [${Number.isFinite(node.rank_ci_lo) ? Math.round(node.rank_ci_lo) : '—'}, ${Number.isFinite(node.rank_ci_hi) ? Math.round(node.rank_ci_hi) : '—'}]`}
                  />
                </td>
                <td class={MEASURE}>{((node.stability ?? 0) * 100).toFixed(0)}%</td>
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

  :global(.GA-sig) {
    font-weight: 600;
  }
</style>
