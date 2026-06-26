import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// Arc color palette - ClickHouse-inspired neutral with purple accent
const arcColors = {
  // Brand colors (use sparingly)
  accent: '#A855F7',  // THE accent color (Arc Purple)
  purple: '#4B0082',
  cyan: '#00E5E5',
  magenta: '#E500E5',
  navy: '#1A1A3E',

  // Light theme - Clean neutral palette
  light: {
    background: '#FFFFFF',
    foreground: '#0F0F0F',
    muted: '#F5F5F5',
    mutedForeground: '#666666',
    border: '#E5E5E5',
    selection: '#F3E8FF',  // Light purple tint for selection
    lineHighlight: '#FAFAFA',
  },

  // Dark theme - True dark neutrals (ClickHouse-inspired)
  dark: {
    background: '#0F0F0F',   // Near black
    foreground: '#FAFAFA',   // Bright text
    muted: '#1A1A1A',        // Slightly elevated
    mutedForeground: '#A1A1A1',
    border: '#2A2A2A',       // Subtle borders
    selection: '#2E1A47',    // Dark purple tint for selection
    lineHighlight: '#141414',
  }
};

// Syntax colors for SQL - Muted palette with purple accent
const syntaxColors = {
  keyword: '#A855F7',     // Arc Purple for keywords (accent)
  string: '#22c55e',      // green-500 for strings
  number: '#00E5E5',      // Cyan for numbers
  operator: '#F472B6',    // Soft pink for operators
  function: '#60A5FA',    // Soft blue for functions
  variable: '#FBBF24',    // Amber for variables
  comment: '#6b7280',     // gray-500 for comments
  punctuation: '#9ca3af', // gray-400 for punctuation
  type: '#C4B5FD',        // Soft violet for types
};

// Light theme highlight style
const lightHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: syntaxColors.keyword, fontWeight: 'bold' },
  { tag: t.operator, color: syntaxColors.operator },
  { tag: t.special(t.string), color: syntaxColors.string },
  { tag: t.string, color: syntaxColors.string },
  { tag: t.number, color: syntaxColors.number },
  { tag: t.bool, color: syntaxColors.keyword },
  { tag: t.null, color: syntaxColors.keyword },
  { tag: t.function(t.variableName), color: syntaxColors.function },
  { tag: t.typeName, color: syntaxColors.type },
  { tag: t.className, color: syntaxColors.type },
  { tag: t.definition(t.variableName), color: syntaxColors.variable },
  { tag: t.variableName, color: arcColors.light.foreground },
  { tag: t.comment, color: syntaxColors.comment, fontStyle: 'italic' },
  { tag: t.punctuation, color: syntaxColors.punctuation },
  { tag: t.bracket, color: syntaxColors.punctuation },
  { tag: t.meta, color: syntaxColors.comment },
]);

// Dark theme highlight style
const darkHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: '#a78bfa', fontWeight: 'bold' }, // lighter purple for dark theme
  { tag: t.operator, color: '#f472b6' }, // lighter magenta
  { tag: t.special(t.string), color: '#4ade80' },
  { tag: t.string, color: '#4ade80' },
  { tag: t.number, color: arcColors.cyan },
  { tag: t.bool, color: '#a78bfa' },
  { tag: t.null, color: '#a78bfa' },
  { tag: t.function(t.variableName), color: '#60a5fa' },
  { tag: t.typeName, color: '#c4b5fd' },
  { tag: t.className, color: '#c4b5fd' },
  { tag: t.definition(t.variableName), color: '#fbbf24' },
  { tag: t.variableName, color: arcColors.dark.foreground },
  { tag: t.comment, color: '#9ca3af', fontStyle: 'italic' },
  { tag: t.punctuation, color: '#d1d5db' },
  { tag: t.bracket, color: '#d1d5db' },
  { tag: t.meta, color: '#9ca3af' },
]);

// Light theme editor styling
const arcLightTheme = EditorView.theme({
  '&': {
    backgroundColor: arcColors.light.background,
    color: arcColors.light.foreground,
  },
  '.cm-content': {
    caretColor: syntaxColors.keyword,
    fontFamily: "'JetBrains Mono', 'Fira Code', Monaco, Menlo, monospace",
    padding: '12px 0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: syntaxColors.keyword,
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: arcColors.light.selection,
  },
  '.cm-panels': {
    backgroundColor: arcColors.light.muted,
    color: arcColors.light.foreground,
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: `1px solid ${arcColors.light.border}`,
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: `1px solid ${arcColors.light.border}`,
  },
  '.cm-searchMatch': {
    backgroundColor: '#fef08a',
    outline: `1px solid #eab308`,
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: '#fde047',
  },
  '.cm-activeLine': {
    backgroundColor: arcColors.light.lineHighlight,
  },
  '.cm-selectionMatch': {
    backgroundColor: '#dbeafe',
  },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: '#c7d2fe',
    outline: `1px solid ${syntaxColors.keyword}`,
  },
  '.cm-gutters': {
    backgroundColor: arcColors.light.muted,
    color: arcColors.light.mutedForeground,
    border: 'none',
    borderRight: `1px solid ${arcColors.light.border}`,
  },
  '.cm-activeLineGutter': {
    backgroundColor: arcColors.light.lineHighlight,
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'transparent',
    border: 'none',
    color: arcColors.light.mutedForeground,
  },
  '.cm-tooltip': {
    border: `1px solid ${arcColors.light.border}`,
    backgroundColor: arcColors.light.background,
  },
  '.cm-tooltip .cm-tooltip-arrow:before': {
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  '.cm-tooltip .cm-tooltip-arrow:after': {
    borderTopColor: arcColors.light.background,
    borderBottomColor: arcColors.light.background,
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: arcColors.light.selection,
      color: arcColors.light.foreground,
    },
  },
}, { dark: false });

// Dark theme editor styling
const arcDarkTheme = EditorView.theme({
  '&': {
    backgroundColor: arcColors.dark.background,
    color: arcColors.dark.foreground,
  },
  '.cm-content': {
    caretColor: arcColors.accent,
    fontFamily: "'JetBrains Mono', 'Fira Code', Monaco, Menlo, monospace",
    padding: '12px 0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: arcColors.accent,
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: arcColors.dark.selection,
  },
  '.cm-panels': {
    backgroundColor: arcColors.dark.muted,
    color: arcColors.dark.foreground,
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: `1px solid ${arcColors.dark.border}`,
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: `1px solid ${arcColors.dark.border}`,
  },
  '.cm-searchMatch': {
    backgroundColor: '#854d0e',
    outline: `1px solid #ca8a04`,
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: '#a16207',
  },
  '.cm-activeLine': {
    backgroundColor: arcColors.dark.lineHighlight,
  },
  '.cm-selectionMatch': {
    backgroundColor: '#1e3a5f',
  },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: '#312e81',
    outline: `1px solid #a78bfa`,
  },
  '.cm-gutters': {
    backgroundColor: arcColors.dark.muted,
    color: arcColors.dark.mutedForeground,
    border: 'none',
    borderRight: `1px solid ${arcColors.dark.border}`,
  },
  '.cm-activeLineGutter': {
    backgroundColor: arcColors.dark.lineHighlight,
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'transparent',
    border: 'none',
    color: arcColors.dark.mutedForeground,
  },
  '.cm-tooltip': {
    border: `1px solid ${arcColors.dark.border}`,
    backgroundColor: arcColors.dark.background,
  },
  '.cm-tooltip .cm-tooltip-arrow:before': {
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  '.cm-tooltip .cm-tooltip-arrow:after': {
    borderTopColor: arcColors.dark.background,
    borderBottomColor: arcColors.dark.background,
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: arcColors.dark.selection,
      color: arcColors.dark.foreground,
    },
  },
}, { dark: true });

// Combined extensions
export const arcLight: Extension = [
  arcLightTheme,
  syntaxHighlighting(lightHighlightStyle),
];

export const arcDark: Extension = [
  arcDarkTheme,
  syntaxHighlighting(darkHighlightStyle),
];

// Helper to get theme based on current mode
export function getArcTheme(isDark: boolean): Extension {
  return isDark ? arcDark : arcLight;
}
