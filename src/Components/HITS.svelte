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
  import ExtensionIcon from './ExtensionIcon.svelte'
  import ImgThumbnail from './ImgThumbnail.svelte'
  import SubtypeOptions from './SubtypeOptions.svelte'

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
  }

  $: currNode = currFile?.path
  let size = 50
  let current_component: HTMLElement
  let newBatch: ComponentResults[] = []
  let visibleData: ComponentResults[] = []
  let page = 0
  let blockSwitch = false

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
          'hub_median', 'hub_ci_lo', 'hub_ci_hi', 'hub_stability',
          ...(useNull ? ['hub_null_ci_lo', 'hub_null_ci_hi', 'hub_sig'] : []),
        ]
      : ['note', 'authority', 'hub']
    const lines = [header.join(',')]
    for (const r of data) {
      const fields = useCI
        ? [
            r.to,
            fmtNum(r.authority), fmtNum(r.auth_ci_lo, 3), fmtNum(r.auth_ci_hi, 3), fmtNum(r.auth_stability, 3),
            ...(useNull ? [fmtNum(r.auth_null_ci_lo, 3), fmtNum(r.auth_null_ci_hi, 3), r.auth_sig ? '1' : '0'] : []),
            fmtNum(r.hub), fmtNum(r.hub_ci_lo, 3), fmtNum(r.hub_ci_hi, 3), fmtNum(r.hub_stability, 3),
            ...(useNull ? [fmtNum(r.hub_null_ci_lo, 3), fmtNum(r.hub_null_ci_hi, 3), r.hub_sig ? '1' : '0'] : []),
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
        <th scope="col" aria-label="95% bootstrap CI for authority">CI (A)</th>
        {#if nullEnabled}
          <th scope="col" aria-label="Configuration-model null 95% CI for authority">Null CI (A)</th>
        {/if}
        <th scope="col" aria-label="Top-10 frequency for authority">Top-10 (A)</th>
      {/if}
      <th scope="col">Hub</th>
      {#if bootstrapEnabled}
        <th scope="col" aria-label="95% bootstrap CI for hub">CI (H)</th>
        {#if nullEnabled}
          <th scope="col" aria-label="Configuration-model null 95% CI for hub">Null CI (H)</th>
        {/if}
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
                  [{Number.isFinite(node.auth_ci_lo) ? node.auth_ci_lo.toFixed(3) : '—'},
                  {Number.isFinite(node.auth_ci_hi) ? node.auth_ci_hi.toFixed(3) : '—'}]
                </td>
                {#if nullEnabled}
                  <td class={MEASURE}>
                    {#if node.auth_null_ci_lo !== undefined && node.auth_null_ci_hi !== undefined}
                      [{Number.isFinite(node.auth_null_ci_lo) ? node.auth_null_ci_lo.toFixed(3) : '—'},
                      {Number.isFinite(node.auth_null_ci_hi) ? node.auth_null_ci_hi.toFixed(3) : '—'}]
                    {:else}
                      —
                    {/if}
                  </td>
                {/if}
                <td class={MEASURE}>{((node.auth_stability ?? 0) * 100).toFixed(0)}%</td>
              {/if}
              <td class={MEASURE}>{node.hub}</td>
              {#if bootstrapEnabled}
                <td class={MEASURE}>
                  [{Number.isFinite(node.hub_ci_lo) ? node.hub_ci_lo.toFixed(3) : '—'},
                  {Number.isFinite(node.hub_ci_hi) ? node.hub_ci_hi.toFixed(3) : '—'}]
                </td>
                {#if nullEnabled}
                  <td class={MEASURE}>
                    {#if node.hub_null_ci_lo !== undefined && node.hub_null_ci_hi !== undefined}
                      [{Number.isFinite(node.hub_null_ci_lo) ? node.hub_null_ci_lo.toFixed(3) : '—'},
                      {Number.isFinite(node.hub_null_ci_hi) ? node.hub_null_ci_hi.toFixed(3) : '—'}]
                    {:else}
                      —
                    {/if}
                  </td>
                {/if}
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
