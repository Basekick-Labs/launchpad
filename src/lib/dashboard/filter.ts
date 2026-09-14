import type { DashboardSummary } from './model';

/**
 * Filter a dashboard list by a free-text query.
 *
 * Matches title and tags, case-insensitively, as a contiguous substring.
 * Description is deliberately excluded — #22 specifies title and tag, and
 * including description makes a short query match almost everything.
 *
 * Extracted from the page rather than inlined so it can be tested without a
 * DOM. The needle is normalized once rather than per row, since this runs on
 * every keystroke.
 *
 * `toLowerCase`, not `toLocaleLowerCase`: a stable result matters more here
 * than locale-correct casing, and locale-dependent filtering would make the
 * same query behave differently for two users looking at the same list.
 * Diacritic folding is out of scope.
 */
export function filterDashboards(
  list: readonly DashboardSummary[],
  query: string,
): DashboardSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...list];
  return list.filter(
    (d) =>
      d.title.toLowerCase().includes(needle) ||
      d.tags.some((tag) => tag.toLowerCase().includes(needle)),
  );
}
