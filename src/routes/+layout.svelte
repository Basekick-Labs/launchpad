<script lang="ts">
  import '../app.css';
  import '@fontsource/inter/400.css';
  import '@fontsource/inter/500.css';
  import '@fontsource/inter/600.css';
  import '@fontsource/inter/700.css';
  import '@fontsource/jetbrains-mono/400.css';
  import { Toaster } from '$lib/components/ui/sonner';
</script>

<slot />
<Toaster richColors position="bottom-right" />
