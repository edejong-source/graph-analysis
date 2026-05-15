<script lang="ts">
  import type { App } from 'obsidian'
  import { hoverPreview, isInVault, isLinked } from 'obsidian-community-lib'
  import type AnalysisView from 'src/AnalysisView'
  import { ANALYSIS_TYPES, ICON, MEASURE, NODE } from 'src/Constants'
  import type {
    Communities,
    GraphAnalysisSettings,
    Subtype,
  } from 'src/Interfaces'
  import type GraphAnalysisPlugin from 'src/main'
  import { bootstrapCommunityCoMembership } from 'src/Bootstrap'
  import {
    classExt,
    classLinked,
    classResolved,
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

  interface ComponentResults {
    label: string
    comm: string[]
  }

  interface CoMembershipRow {
    to: string
    prob: number
    resolved: boolean
  }

  let { resolvedLinks } = app.metadataCache

  $: currSubtypeInfo = ANALYSIS_TYPES.find((sub) => sub.subtype === currSubtype)
  let ascOrder = false
  let bootstrapEnabled = settings.bootstrapEnabledDefault
  let progress = 1
  let size = 50
  let current_component: HTMLElement
  let newBatch: ComponentResults[] = []
  let visibleData: ComponentResults[] = []
  let coMembershipRows: CoMembershipRow[] = []
  let page = 0
  let blockSwitch = false

  let currFile = app.workspace.getActiveFile()
  $: currNode = currFile?.path
  app.workspace.on('file-open', (activeFile) => {
    blockSwitch = true
    setTimeout(() => {
      blockSwitch = false
      currFile = activeFile
    }, 100)
    newBatch = []
  })

  let its = 20
  const iterationsArr = Array(50)
    .fill(0)
    .map((i, j) => j + 1)

  $: promiseSortedResults = !plugin.g
    ? null
    : (bootstrapEnabled && currNode
        ? (progress = 0,
          bootstrapCommunityCoMembership(
            plugin.g,
            'Label Propagation',
            currNode,
            {
              iterations: plugin.settings.bootstrapIterations,
              fraction: plugin.settings.bootstrapFraction,
              seed: plugin.settings.bootstrapSeed,
              yieldEvery: 10,
            },
            (d, t) => (progress = d / t),
          ).then((agg) => {
            const rows: CoMembershipRow[] = []
            for (const to in agg) {
              if (agg[to].prob < 0.1) continue
              if (to === currNode) continue
              const resolved = !to.endsWith('.md') || isInVault(app, to)
              rows.push({ to, prob: agg[to].prob, resolved })
            }
            rows.sort((a, b) => b.prob - a.prob)
            coMembershipRows = rows
            return [] as ComponentResults[]
          }))
        : plugin.g.algs[currSubtype]('', { iterations: its }).then(
            (comms: Communities) => {
              const greater = ascOrder ? 1 : -1
              const lesser = ascOrder ? -1 : 1

              const componentResults: ComponentResults[] = []
              Object.keys(comms).forEach((label) => {
                let comm = comms[label]
                if (comm.length > 1) {
                  componentResults.push({ label, comm })
                }
              })
              componentResults.sort((a, b) =>
                a.comm.length > b.comm.length ? greater : lesser,
              )
              coMembershipRows = []
              return componentResults
            },
          )
      ).then((res: ComponentResults[]) => {
        newBatch = res.slice(0, size)
        setTimeout(() => {
          blockSwitch = false
        }, 100)
        return res
      })

  $: visibleData = [...visibleData, ...newBatch]

  onMount(() => {
    currFile = app.workspace.getActiveFile()
  })
</script>

<div class="GA-CCs" bind:this={current_component}>
  <div>
    <span>
      <SubtypeOptions
        bind:currSubtypeInfo
        bind:ascOrder
        bind:blockSwitch
        bind:newBatch
        bind:visibleData
        bind:promiseSortedResults
        bind:page
        bind:bootstrapEnabled
        {plugin}
        {view}
        {app}
      />

      <label for="iterations">Iterations: </label>
      <input
        name="iterations"
        type="range"
        min="1"
        max="30"
        value={its}
        on:change={(e) => {
          const value = Number.parseInt(e.target.value)
          blockSwitch = true
          visibleData = []
          promiseSortedResults = null
          page = 0
          setTimeout(() => {
            blockSwitch = false
          }, 100)
          newBatch = []

          its = value
        }}
      />
    </span>
  </div>
  {#if bootstrapEnabled && progress < 1}
    <div class="GA-progress-track">
      <div class="GA-progress-bar" style="width: {(progress * 100).toFixed(1)}%" />
    </div>
  {/if}
  {#if promiseSortedResults}
    {#await promiseSortedResults then sortedResults}
      {#key sortedResults}
        {#if bootstrapEnabled}
          <div class="GA-coMembership">
            <p class="GA-coMembership-hint">
              Notes most often grouped with <strong>{presentPath(currNode ?? '')}</strong>
              across {plugin.settings.bootstrapIterations} edge-subsampled resamples.
            </p>
            {#each coMembershipRows as row}
              <div
                class="{NODE}
                  {classResolved(app, row.to)}
                  {classExt(row.to)}"
                on:click={async (e) => await openOrSwitch(app, row.to, e)}
                on:mouseover={(e) => hoverPreview(e, view, row.to)}
              >
                <ExtensionIcon path={row.to} />
                <span class="internal-link">{presentPath(row.to)}</span>
                <span class={MEASURE}>{(row.prob * 100).toFixed(0)}%</span>
              </div>
            {/each}
          </div>
        {:else}
        {#each visibleData as comm}
          <div class="GA-CC">
            <details class="tree-item-self">
              <summary
                class="tree-item-inner"
                on:contextmenu={(e) =>
                  openMenu(e, app, { toCopy: comm.comm.join('\n') })}
              >
                <span
                  class="top-row 
                  {comm.comm.includes(currNode) ? 'currComm' : ''}"
                >
                  <span>
                    <!-- Unecessary span? -->
                    {presentPath(comm.label)}
                  </span>
                  <span class={MEASURE}>{comm.comm.length}</span>
                </span>
              </summary>
              <div class="GA-details ">
                {#each comm.comm as member}
                  <div
                    class="
                    {NODE} 
                    {classLinked(resolvedLinks, comm.label, member)}
                    {classResolved(app, member)} 
                    {classExt(member)}
                      "
                    on:click={async (e) => await openOrSwitch(app, member, e)}
                    on:mouseover={(e) => hoverPreview(e, view, member)}
                  >
                    {#if isLinked(resolvedLinks, comm.label, member, false)}
                      <span class={ICON}>
                        <FaLink />
                      </span>
                    {/if}
                    <ExtensionIcon path={member} />
                    <span
                      class="internal-link {currNode === member
                        ? 'currNode'
                        : ''}">{presentPath(member)}</span
                    >
                    {#if plugin.settings.showImgThumbnails && isImg(member)}
                      <ImgThumbnail img={getImgBufferPromise(app, member)} />
                    {/if}
                  </div>
                {/each}
              </div>
            </details>
          </div>
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
        {/if}
      {/key}
    {/await}
  {/if}
</div>

<style>
  .GA-CCs {
    display: flex;
    flex-direction: column;
    padding-left: 10px;
  }

  .is-unresolved {
    color: var(--text-muted);
  }
  /* .GA-CC {
        border: 1px solid var(--background-modifier-border);
        border-radius: 3px; 
        padding: 5px; 
      } */

  .GA-details {
    padding-left: 20px;
  }
  .GA-node,
  .CC-sentence {
    font-size: var(--font-size-secondary);
    border: 1px solid transparent;
    border-radius: 5px;
  }

  .CC-sentence:hover {
    background-color: var(--background-secondary-alt);
  }

  .CC-item {
    padding-left: 30px;
    font-weight: 600;
  }

  .CC-sentence {
    padding-left: 40px;
    color: var(--text-muted);
  }
  .top-row span + span {
    float: right;
  }

  span.GA-measure {
    background-color: var(--background-secondary-alt);
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 12px;
    line-height: 12px;
  }
  span.GA-measure:hover {
    background-color: var(--interactive-accent);
  }

  .currComm {
    color: var(--text-accent);
  }

  .currNode {
    font-weight: bold;
  }
  .GA-coMembership-hint {
    color: var(--text-muted);
    font-size: var(--font-size-secondary);
    margin: 4px 0 8px 0;
  }
  .GA-coMembership > div {
    padding: 2px 4px;
    cursor: pointer;
  }
  .GA-coMembership > div:hover {
    background-color: var(--background-secondary-alt);
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
