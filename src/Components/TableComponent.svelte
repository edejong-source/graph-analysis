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
  import ExtensionIcon from './ExtensionIcon.svelte'
  import ImgThumbnail from './ImgThumbnail.svelte'
  import SubtypeOptions from './SubtypeOptions.svelte'

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
  }

  $: currNode = currFile?.path
  let size = 50
  let current_component: HTMLElement
  let newBatch: ComponentResults[] = []
  let visibleData: ComponentResults[] = []
  let page = 0
  let blockSwitch = false

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
      const { median, ci_lo, ci_hi, stability, n } = agg[to]
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
    const header = useCI
      ? ['note', 'median', 'ci_lo', 'ci_hi', 'stability', 'n']
      : ['note', 'measure', 'extra']
    const lines = [header.join(',')]
    for (const r of data) {
      const fields = useCI
        ? [r.to, fmtNum(r.measure), fmtNum(r.ci_lo), fmtNum(r.ci_hi), fmtNum(r.stability, 3), String(r.n ?? '')]
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
        <th scope="col" aria-label="95% bootstrap confidence interval">95% CI</th>
        {#if nullEnabled}
          <th scope="col" aria-label="Configuration-model null 95% CI (degree-preserving random graph)">Null 95% CI</th>
        {/if}
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
                  [{Number.isFinite(node.ci_lo) ? node.ci_lo.toFixed(3) : '∞'},
                  {Number.isFinite(node.ci_hi) ? node.ci_hi.toFixed(3) : '∞'}]
                </td>
                {#if nullEnabled}
                  <td class={MEASURE}>
                    {#if node.null_ci_lo !== undefined && node.null_ci_hi !== undefined}
                      [{Number.isFinite(node.null_ci_lo) ? node.null_ci_lo.toFixed(3) : '∞'},
                      {Number.isFinite(node.null_ci_hi) ? node.null_ci_hi.toFixed(3) : '∞'}]
                    {:else}
                      —
                    {/if}
                  </td>
                {/if}
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
