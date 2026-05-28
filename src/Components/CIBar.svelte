<script lang="ts">
  // Renders a 95% CI as a horizontal bar against a column-wide [min, max] axis.
  // When nullCi* are provided, overlays a second muted bar for the null CI —
  // direct visual comparison of observed vs configuration-model null.

  export let ciLo: number
  export let ciHi: number
  export let median: number | undefined = undefined
  export let nullCiLo: number | undefined = undefined
  export let nullCiHi: number | undefined = undefined
  export let range: [number, number]
  export let sig: boolean = false
  export let width: number = 80
  export let label: string = ''

  function pct(value: number): number {
    const [min, max] = range
    if (!Number.isFinite(value)) return 0
    if (max <= min) return 0.5
    return Math.max(0, Math.min(1, (value - min) / (max - min)))
  }

  $: hasNull =
    nullCiLo !== undefined && nullCiHi !== undefined &&
    Number.isFinite(nullCiLo) && Number.isFinite(nullCiHi)
  $: barHeight = hasNull ? 14 : 10
  $: obsY = hasNull ? 2 : 3
  $: nullY = 8
  $: axisY = hasNull ? 10 : 5
  $: medianY1 = hasNull ? 0 : 1
  $: medianY2 = hasNull ? 7 : 9
  $: valid = Number.isFinite(ciLo) && Number.isFinite(ciHi)
</script>

{#if valid}
  <svg width={width} height={barHeight} class="GA-ci-bar" role="img" aria-label={label}>
    <title>{label}</title>
    <line x1="0" y1={axisY} x2={width} y2={axisY} class="GA-ci-axis" />
    {#if hasNull}
      <rect
        x={pct(nullCiLo) * width}
        y={nullY}
        width={Math.max(1, (pct(nullCiHi) - pct(nullCiLo)) * width)}
        height="4"
        class="GA-ci-null"
      />
    {/if}
    <rect
      x={pct(ciLo) * width}
      y={obsY}
      width={Math.max(1, (pct(ciHi) - pct(ciLo)) * width)}
      height="4"
      class="GA-ci-fill"
      style:fill={sig ? 'var(--color-green, var(--interactive-accent-hover))' : 'var(--interactive-accent)'}
    />
    {#if median !== undefined && Number.isFinite(median)}
      <line
        x1={pct(median) * width}
        x2={pct(median) * width}
        y1={medianY1}
        y2={medianY2}
        class="GA-ci-median"
      />
    {/if}
  </svg>
{:else}
  <span class="GA-ci-empty">—</span>
{/if}

<style>
  .GA-ci-bar {
    display: inline-block;
    vertical-align: middle;
  }
  .GA-ci-axis {
    stroke: var(--background-modifier-border);
    stroke-width: 1;
  }
  .GA-ci-null {
    fill: var(--text-faint);
    opacity: 0.7;
  }
  .GA-ci-median {
    stroke: var(--text-normal);
    stroke-width: 1.5;
  }
  .GA-ci-empty {
    color: var(--text-faint);
  }
</style>
