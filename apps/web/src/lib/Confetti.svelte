<script lang="ts">
  // A short burst of confetti over its parent (position: relative). Decorative, pure CSS motion,
  // and hidden for people who ask for less motion.
  let { pieces = 28 }: { pieces?: number } = $props();

  const COLORS = ['#f4b942', '#e4572e', '#5fb98a', '#4a90d9', '#c46bd8', '#f08aa5'];

  const bits = $derived(
    Array.from({ length: pieces }, (_, i) => ({
      color: COLORS[i % COLORS.length],
      // Spread across the width, each with its own fall, drift and spin.
      left: (i * 100) / pieces + Math.random() * (100 / pieces),
      delay: Math.random() * 0.25,
      duration: 1.1 + Math.random() * 0.9,
      drift: (Math.random() - 0.5) * 120,
      spin: (Math.random() < 0.5 ? -1 : 1) * (240 + Math.random() * 480),
    })),
  );
</script>

<div class="confetti" aria-hidden="true">
  {#each bits as bit, i (i)}
    <span
      style:left="{bit.left}%"
      style:background={bit.color}
      style:animation-delay="{bit.delay}s"
      style:animation-duration="{bit.duration}s"
      style:--drift="{bit.drift}px"
      style:--spin="{bit.spin}deg"
    ></span>
  {/each}
</div>

<style>
  .confetti {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  span {
    position: absolute;
    top: -0.5rem;
    width: 0.5rem;
    height: 0.8rem;
    border-radius: 2px;
    opacity: 0;
    animation: fall ease-out forwards;
  }

  @keyframes fall {
    0% {
      opacity: 1;
      transform: translate(0, 0) rotate(0);
    }
    100% {
      opacity: 0;
      transform: translate(var(--drift), 14rem) rotate(var(--spin));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .confetti {
      display: none;
    }
  }
</style>
