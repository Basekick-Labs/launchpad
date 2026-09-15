<!--
  A lean CodeMirror editor for one panel target.

  Deliberately NOT a reuse of `QueryEditor.svelte`. That component takes an
  `ArcClient` prop and calls `client.query(...)` itself, which would bypass
  `applyMacros` — so `$__timeFilter(time)` would reach Arc literally and every
  real panel query would come back a syntax error. It also splits multiple
  statements (a target is one), writes query history, and fires a global
  `query-executed` window event. None of that is wanted here, and there is no way
  to switch it off.

  This owns the document and nothing else: it dispatches `change` and `run`, and
  the query runner executes.

  Completion is macros and dashboard variables only. Schema completion needs a
  column-metadata call that does not exist yet and is deferred.
-->
<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
  import { EditorState, Prec } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { sql } from '@codemirror/lang-sql';
  import { bracketMatching, indentOnInput } from '@codemirror/language';
  import { autocompletion, closeBrackets, type CompletionContext } from '@codemirror/autocomplete';
  import { getArcTheme } from '$lib/codemirror/arcTheme';
  import { colorScheme } from '$lib/stores/theme';

  export let value = '';
  /** `{ label, detail }` — macros plus the dashboard's variables. */
  export let hints: Array<{ label: string; detail: string }> = [];

  const dispatch = createEventDispatcher<{ change: string; run: void }>();

  let host: HTMLDivElement | undefined;
  let view: EditorView | null = null;
  /** Guards the round trip: our own setValue must not re-dispatch a change. */
  let applying = false;

  function completions(context: CompletionContext) {
    // `$` is a word boundary in CodeMirror's default matcher, so match it
    // explicitly or a macro never completes after the user types the dollar.
    const before = context.matchBefore(/\$[\w_]*$/);
    if (!before && !context.explicit) return null;
    return {
      from: before ? before.from : context.pos,
      options: hints.map((h) => ({ label: h.label, detail: h.detail, type: 'keyword' })),
    };
  }

  function build(): void {
    if (!host) return;
    view?.destroy();
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          bracketMatching(),
          indentOnInput(),
          closeBrackets(),
          autocompletion({ override: [completions] }),
          sql(),
          getArcTheme($colorScheme === 'dark'),
          // Above the default keymap, or Mod-Enter is swallowed by it.
          Prec.high(
            keymap.of([
              {
                key: 'Mod-Enter',
                run: () => {
                  dispatch('run');
                  return true;
                },
              },
            ]),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || applying) return;
            dispatch('change', u.state.doc.toString());
          }),
        ],
      }),
    });
  }

  onMount(build);
  // The theme is baked into the extension list, so a scheme change rebuilds —
  // acceptable here because the document is carried across and an editor rebuild
  // is invisible, unlike a chart losing its viewport.
  $: if (view && $colorScheme) rebuildForTheme($colorScheme);
  let lastScheme = '';
  function rebuildForTheme(scheme: string): void {
    if (scheme === lastScheme) return;
    lastScheme = scheme;
    if (view) {
      value = view.state.doc.toString();
      build();
    }
  }

  // Accept an external change (a target switch, a discard) without echoing it.
  $: if (view && value !== view.state.doc.toString()) {
    applying = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    applying = false;
  }

  onDestroy(() => view?.destroy());
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor {
    height: 100%;
    min-height: 8rem;
    overflow: auto;
    border: 1px solid hsl(var(--border));
    border-radius: 0.375rem;
  }
</style>
