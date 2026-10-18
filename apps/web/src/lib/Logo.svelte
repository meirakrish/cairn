<script lang="ts">
  let { size = 32 }: { size?: number } = $props();
</script>

<!-- A cairn: four stacked stones, the top one in the accent colour. Keep in sync with assets/favicon.svg. -->
<svg class="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
  <ellipse cx="32" cy="52" rx="23" ry="8.5" transform="rotate(-2 32 52)" fill="var(--stone-1)" />
  <ellipse
    cx="30.5"
    cy="38.5"
    rx="16.5"
    ry="6.5"
    transform="rotate(4 30.5 38.5)"
    fill="var(--stone-2)"
  />
  <ellipse cx="33" cy="27" rx="11.5" ry="5.2" transform="rotate(-5 33 27)" fill="var(--stone-3)" />
  <ellipse
    cx="31.5"
    cy="17.5"
    rx="6.8"
    ry="4.3"
    transform="rotate(3 31.5 17.5)"
    fill="var(--accent)"
  />
</svg>

<style>
  .logo {
    flex: none;
    display: block;
  }
</style>
