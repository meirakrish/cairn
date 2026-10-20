<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
</script>

<section class="error-page">
  <h1>{page.status}</h1>
  <p>{page.error?.message ?? 'Something went wrong.'}</p>
  <a href={resolve('/')}>Back to your cairns</a>
</section>
