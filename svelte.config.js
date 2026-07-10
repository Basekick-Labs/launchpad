import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      out: 'build',
      precompress: false
    }),
    alias: {
      $components: 'src/lib/components',
      $server: 'src/lib/server'
    },
    // SvelteKit auto-injects hashes for its own inline hydration scripts/styles,
    // so hydration keeps working under a strict CSP. Cross-origin script/object
    // injection is blocked; frame-ancestors backstops X-Frame-Options.
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        // Cloudflare Turnstile (optional signup CAPTCHA) loads its script and
        // renders a challenge iframe from challenges.cloudflare.com. These are
        // harmless when Turnstile is not configured.
        'script-src': ['self', 'https://challenges.cloudflare.com'],
        'frame-src': ['https://challenges.cloudflare.com'],
        'style-src': ['self', 'unsafe-inline'],
        'img-src': ['self', 'data:'],
        'font-src': ['self', 'data:'],
        'connect-src': ['self', 'https://challenges.cloudflare.com'],
        'object-src': ['none'],
        'base-uri': ['self'],
        'frame-ancestors': ['none'],
        'form-action': ['self']
      }
    }
  }
};

export default config;
