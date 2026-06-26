<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Sun, Moon, Monitor } from 'lucide-svelte';

  type Theme = 'light' | 'dark' | 'system';

  let theme: Theme = 'system';
  let resolvedTheme: 'light' | 'dark' = 'light';

  function getSystemTheme(): 'light' | 'dark' {
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(t: Theme) {
    const resolved = t === 'system' ? getSystemTheme() : t;
    resolvedTheme = resolved;

    if (resolved === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
    }
  }

  function cycleTheme() {
    const themes: Theme[] = ['light', 'dark', 'system'];
    const currentIndex = themes.indexOf(theme);
    theme = themes[(currentIndex + 1) % themes.length];
    localStorage.setItem('arc-theme', theme);
    applyTheme(theme);
  }

  onMount(() => {
    // Load saved theme
    const saved = localStorage.getItem('arc-theme') as Theme | null;
    if (saved && ['light', 'dark', 'system'].includes(saved)) {
      theme = saved;
    }
    applyTheme(theme);

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (theme === 'system') {
        applyTheme('system');
      }
    };
    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  });
</script>

<Button
  variant="ghost"
  size="icon"
  class="h-9 w-9"
  on:click={cycleTheme}
  title="Toggle theme ({theme})"
>
  {#if theme === 'system'}
    <Monitor class="h-4 w-4" />
  {:else if resolvedTheme === 'dark'}
    <Moon class="h-4 w-4" />
  {:else}
    <Sun class="h-4 w-4" />
  {/if}
</Button>
