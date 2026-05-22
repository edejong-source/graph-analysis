<script lang="ts">
  import type { App, TFile } from 'obsidian'
  import type AnalysisView from 'src/AnalysisView'
  import type { SubtypeInfo } from 'src/Interfaces'
  import type GraphAnalysisPlugin from 'src/main'
  import FaCreativeCommonsZero from 'svelte-icons/fa/FaCreativeCommonsZero.svelte'
  import FaDownload from 'svelte-icons/fa/FaDownload.svelte'
  import FaFire from 'svelte-icons/fa/FaFire.svelte'
  import FaRegSnowflake from 'svelte-icons/fa/FaRegSnowflake.svelte'
  import IoIosTrendingDown from 'svelte-icons/io/IoIosTrendingDown.svelte'
  import IoIosTrendingUp from 'svelte-icons/io/IoIosTrendingUp.svelte'
  import IoMdRefresh from 'svelte-icons/io/IoMdRefresh.svelte'
  import MdExposureZero from 'svelte-icons/md/MdExposureZero.svelte'
  import InfoIcon from './InfoIcon.svelte'
  import GoSignOut from 'svelte-icons/go/GoSignOut.svelte'
  import GoSignIn from 'svelte-icons/go/GoSignIn.svelte'

  export let currSubtypeInfo: SubtypeInfo
  export let noZero: boolean = undefined
  export let sortBy: boolean = undefined
  export let ascOrder: boolean = undefined
  export let currFile: TFile = undefined
  export let frozen: boolean = undefined
  export let plugin: GraphAnalysisPlugin
  export let app: App
  export let view: AnalysisView
  export let blockSwitch: boolean
  export let newBatch: any[]
  export let visibleData: any[]
  export let promiseSortedResults: Promise<any[]>
  export let page: number
  export let bootstrapEnabled: boolean = undefined
  export let nullEnabled: boolean = undefined
  export let exportCSV: (() => void) | undefined = undefined
</script>

<span class="GA-Subtype-Options">
  <InfoIcon {currSubtypeInfo} />

  {#if noZero !== undefined}
    <span
      class="GA-Option-span"
      aria-label={noZero ? 'Show Zeros' : 'Hide Zeros'}
      on:click={() => {
        noZero = !noZero
        if (!frozen) {
          blockSwitch = true
          newBatch = []
          visibleData = []
          promiseSortedResults = null
          page = 0
        }
      }}
    >
      <span class="icon">
        {#if noZero}
          <MdExposureZero />
        {:else}
          <FaCreativeCommonsZero />
        {/if}
      </span>
    </span>
  {/if}
  {#if ascOrder !== undefined}
    <span
      class="GA-Option-span"
      aria-label={ascOrder ? 'Ascending' : 'Descending'}
      on:click={() => {
        ascOrder = !ascOrder
        if (!frozen) {
          blockSwitch = true
          newBatch = []
          visibleData = []
          promiseSortedResults = null
          page = 0
        }
      }}
    >
      <span class="icon">
        {#if ascOrder}
          <IoIosTrendingUp />
        {:else}
          <IoIosTrendingDown />
        {/if}
      </span>
    </span>
  {/if}
  {#if frozen !== undefined}
    <span
      class="GA-Option-span"
      aria-label={frozen ? `Frozen on: ${currFile.basename}` : 'Unfrozen'}
      on:click={() => {
        frozen = !frozen
        if (!frozen && !currSubtypeInfo.global) {
          blockSwitch = true
          newBatch = []
          visibleData = []
          promiseSortedResults = null
          page = 0

          setTimeout(() => (currFile = app.workspace.getActiveFile()), 100)
        } else if (!frozen && currSubtypeInfo.global) {
          blockSwitch = true
          setTimeout(() => {
            blockSwitch = false
            currFile = app.workspace.getActiveFile()
          }, 100)
          newBatch = []
        }
      }}
    >
      <span class="icon">
        {#if frozen}
          <FaRegSnowflake />
        {:else}
          <FaFire />
        {/if}
      </span>
    </span>
  {/if}
  {#if sortBy !== undefined}
    <span
      class="GA-Option-span"
      aria-label="Sort By: {sortBy ? 'Authority' : 'Hub'}"
      on:click={() => {
        sortBy = !sortBy
        if (!frozen) {
          blockSwitch = true
          newBatch = []
          visibleData = []
          promiseSortedResults = null
          page = 0
        }
      }}
    >
      <span class="icon">
        {#if sortBy}
          <GoSignIn />
        {:else}
          <GoSignOut />
        {/if}
      </span>
    </span>
  {/if}
  {#if bootstrapEnabled !== undefined && currSubtypeInfo.supportsBootstrap}
    <span
      class="GA-Option-span GA-bootstrap-toggle"
      class:active={bootstrapEnabled}
      aria-label={bootstrapEnabled
        ? `Uncertainty ON (${plugin.settings.bootstrapIterations} resamples @ ${Math.round(plugin.settings.bootstrapFraction * 100)}% edges)`
        : 'Uncertainty OFF — click to show bootstrap CIs'}
      on:click={() => {
        bootstrapEnabled = !bootstrapEnabled
        if (!frozen) {
          blockSwitch = true
          newBatch = []
          visibleData = []
          promiseSortedResults = null
          page = 0
        }
      }}
    >
      <span class="icon-text">{bootstrapEnabled ? '±' : '~'}</span>
    </span>
  {/if}
  {#if nullEnabled !== undefined && bootstrapEnabled && currSubtypeInfo.supportsBootstrap}
    <span
      class="GA-Option-span GA-null-toggle"
      class:active={nullEnabled}
      aria-label={nullEnabled
        ? 'Null overlay ON — degree-preserving random graph CI'
        : 'Null overlay OFF — click to compare against configuration-model null'}
      on:click={() => {
        nullEnabled = !nullEnabled
        if (!frozen) {
          blockSwitch = true
          newBatch = []
          visibleData = []
          promiseSortedResults = null
          page = 0
        }
      }}
    >
      <span class="icon-text">H₀</span>
    </span>
  {/if}
  {#if exportCSV !== undefined}
    <span
      class="GA-Option-span"
      aria-label="Export current view as CSV"
      on:click={exportCSV}
    >
      <span class="icon">
        <FaDownload />
      </span>
    </span>
  {/if}
  <span
    class="GA-Option-span"
    aria-label="Refresh Index"
    on:click={async () => {
      await plugin.refreshGraph()
      await view.draw(currSubtypeInfo.subtype)
    }}
  >
    <span class="icon">
      <IoMdRefresh />
    </span>
  </span>
</span>

<style>
  .GA-Subtype-Options {
    margin-left: 10px;
  }
  .icon {
    color: var(--text-normal);
    display: inline-block;
    padding-top: 5px !important;
    width: 20px;
    height: 20px;
  }

  .GA-Option-span {
    padding: 2px;
  }
  .GA-bootstrap-toggle .icon-text {
    display: inline-block;
    width: 20px;
    height: 20px;
    text-align: center;
    line-height: 20px;
    font-weight: 700;
    color: var(--text-muted);
    border-radius: 3px;
  }
  .GA-bootstrap-toggle.active .icon-text {
    color: var(--text-on-accent);
    background-color: var(--interactive-accent);
  }
  .GA-null-toggle .icon-text {
    display: inline-block;
    width: 22px;
    height: 20px;
    text-align: center;
    line-height: 20px;
    font-weight: 700;
    font-size: 11px;
    color: var(--text-muted);
    border-radius: 3px;
  }
  .GA-null-toggle.active .icon-text {
    color: var(--text-on-accent);
    background-color: var(--interactive-accent);
  }
</style>
