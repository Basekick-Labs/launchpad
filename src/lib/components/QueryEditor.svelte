<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
  import { EditorState, Prec } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { sql } from '@codemirror/lang-sql';
  import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language';
  import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
  import type { ArcClient, QueryResult, StatementResult } from '$lib/arcClient';
  import { QueryHistoryManager } from '$lib/queryHistory';
  import { parseStatements } from '$lib/sqlParser';
  import { getArcTheme } from '$lib/codemirror/arcTheme';
  import { Button } from '$lib/components/ui/button';
  import { Play, Loader2, MousePointerClick } from 'lucide-svelte';

  export let client: ArcClient;
  export let database: string | null = null;
  export let initialQuery: string = 'SELECT * FROM system.tables LIMIT 10;';

  const dispatch = createEventDispatcher();

  let editorContainer: HTMLDivElement;
  let editorView: EditorView;
  let isExecuting = false;
  let isDark = false;
  let hasSelection = false;

  // Track selection state for UI
  function updateSelectionState() {
    if (!editorView) return;
    const { from, to } = editorView.state.selection.main;
    hasSelection = from !== to;
  }

  // Get selected text or null if no selection
  function getSelectedText(): string | null {
    if (!editorView) return null;
    const { from, to } = editorView.state.selection.main;
    if (from === to) return null;
    return editorView.state.sliceDoc(from, to);
  }

  // Check for dark mode
  function checkDarkMode() {
    isDark = document.documentElement.classList.contains('dark');
  }

  // Public method to insert text at cursor
  export function insertText(text: string) {
    if (!editorView) return;

    const { state } = editorView;
    const { from, to } = state.selection.main;

    editorView.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length }
    });

    editorView.focus();
  }

  // Public method to set entire query text
  export function setQuery(text: string) {
    if (!editorView) return;

    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: text }
    });

    editorView.focus();
  }

  const executeQuery = async (selectionOnly: boolean = false) => {
    if (isExecuting) return;

    // Get text to execute
    let textToExecute: string;
    if (selectionOnly) {
      const selected = getSelectedText();
      if (!selected || !selected.trim()) {
        // No selection, fall back to full content
        textToExecute = editorView.state.doc.toString().trim();
      } else {
        textToExecute = selected.trim();
      }
    } else {
      textToExecute = editorView.state.doc.toString().trim();
    }

    if (!textToExecute) return;

    // Parse into statements
    const parsedStatements = parseStatements(textToExecute);
    if (parsedStatements.length === 0) return;

    isExecuting = true;

    // Initialize results array
    const results: StatementResult[] = parsedStatements.map((stmt, idx) => ({
      index: idx,
      sql: stmt.sql,
      status: 'pending' as const
    }));

    // Dispatch initial state for multi-query
    if (results.length > 1) {
      dispatch('queryStarted', { statements: results });
    }

    // Execute statements sequentially
    let hasError = false;
    for (let i = 0; i < parsedStatements.length; i++) {
      results[i].status = 'running';

      // Dispatch progress for multi-query
      if (results.length > 1) {
        dispatch('statementProgress', { statements: [...results], currentIndex: i });
      }

      try {
        const result = await client.query(parsedStatements[i].sql, database || undefined);
        results[i].status = 'success';
        results[i].result = result;
        results[i].executionTime = result.executionTime;
      } catch (err) {
        results[i].status = 'error';
        results[i].error = err instanceof Error ? err.message : 'Unknown error occurred';
        hasError = true;
        break; // Stop on first error
      }
    }

    // Calculate totals for history
    const totalExecutionTime = results.reduce((sum, r) => sum + (r.executionTime || 0), 0);
    const totalRowCount = results.reduce((sum, r) => sum + (r.result?.rowCount || 0), 0);
    const allSucceeded = results.every(r => r.status === 'success');
    const firstError = results.find(r => r.error)?.error;

    // Save to history
    QueryHistoryManager.saveQuery({
      sql: textToExecute,
      executionTime: totalExecutionTime,
      rowCount: totalRowCount,
      success: allSucceeded,
      error: firstError
    });

    // Dispatch event to notify QueryHistory component
    window.dispatchEvent(new Event('query-executed'));

    // Dispatch results to parent component
    dispatch('queryExecuted', {
      results,
      query: textToExecute,
      error: firstError || '',
      executionTime: totalExecutionTime
    });

    isExecuting = false;
  };

  onMount(() => {
    checkDarkMode();

    const startState = EditorState.create({
      doc: initialQuery,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        foldGutter(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        sql(),
        getArcTheme(isDark),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap
        ]),
        Prec.highest(keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              executeQuery(false);
              return true;
            },
            preventDefault: true
          },
          {
            key: 'Shift-Mod-Enter',
            run: () => {
              executeQuery(true);
              return true;
            },
            preventDefault: true
          }
        ])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newQuery = update.state.doc.toString();
            dispatch('queryChanged', newQuery);
          }
          if (update.selectionSet) {
            updateSelectionState();
          }
        })
      ]
    });

    editorView = new EditorView({
      state: startState,
      parent: editorContainer
    });

    // Listen for theme changes
    const observer = new MutationObserver(() => {
      const wasDark = isDark;
      checkDarkMode();
      if (wasDark !== isDark && editorView) {
        // Recreate editor with new theme
        const currentDoc = editorView.state.doc.toString();
        editorView.destroy();

        const newState = EditorState.create({
          doc: currentDoc,
          extensions: [
            lineNumbers(),
            highlightActiveLine(),
            highlightActiveLineGutter(),
            history(),
            foldGutter(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            sql(),
            getArcTheme(isDark),
            keymap.of([
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...historyKeymap
            ]),
            Prec.highest(keymap.of([
              {
                key: 'Mod-Enter',
                run: () => {
                  executeQuery(false);
                  return true;
                },
                preventDefault: true
              },
              {
                key: 'Shift-Mod-Enter',
                run: () => {
                  executeQuery(true);
                  return true;
                },
                preventDefault: true
              }
            ])),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                const newQuery = update.state.doc.toString();
                dispatch('queryChanged', newQuery);
              }
              if (update.selectionSet) {
                updateSelectionState();
              }
            })
          ]
        });

        editorView = new EditorView({
          state: newState,
          parent: editorContainer
        });
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });

    return () => {
      observer.disconnect();
    };
  });

  onDestroy(() => {
    if (editorView) {
      editorView.destroy();
    }
  });
</script>

<div class="flex h-full flex-col gap-4 p-6">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      <h2 class="text-lg font-semibold">SQL Query</h2>
      {#if hasSelection}
        <span class="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">Selection</span>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      {#if hasSelection}
        <Button variant="outline" size="sm" on:click={() => executeQuery(true)} disabled={isExecuting}>
          <MousePointerClick class="mr-1.5 h-3.5 w-3.5" />
          Run Selection
          <kbd class="ml-1.5 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">⇧⌘↵</kbd>
        </Button>
      {/if}
      <Button on:click={() => executeQuery(false)} disabled={isExecuting}>
        {#if isExecuting}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          Executing...
        {:else}
          <Play class="mr-2 h-4 w-4" />
          Execute
        {/if}
        <kbd class="ml-2 rounded bg-primary-foreground/20 px-1.5 py-0.5 font-mono text-xs">⌘↵</kbd>
      </Button>
    </div>
  </div>

  <div bind:this={editorContainer} class="editor-container flex-1 overflow-hidden rounded-lg border"></div>
</div>

<style>
  .editor-container :global(.cm-editor) {
    height: 100%;
    font-size: 14px;
  }

  .editor-container :global(.cm-scroller) {
    overflow: auto;
  }

  .editor-container :global(.cm-focused) {
    outline: none;
  }
</style>
