import type { EntrySummary, Kind } from "../shared/api.js";
/** What the list shows: everything, the favourites, or one kind. */
export type Filter = "all" | "favourites" | Kind;
export const KINDS: readonly Kind[] = ["login", "card", "doc", "note", "key", "env", "custom"];
export const FILTERS: readonly Filter[] = ["all", "favourites", "login", "card", "doc", "note", "key", "env", "custom"];
/** The entries that show for a filter and a search. A search looks through every entry, whatever the filter says. */
export function visible(entries: readonly EntrySummary[], filter: Filter, search: string): EntrySummary[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) return entries.filter(entry => words.every(word => entry.search.includes(word)));
  return entries.filter(entry => filter === "all" || (filter === "favourites" ? entry.favorite : entry.kind === filter));
}
/** The number behind each line of the filter menu. */
export function counts(entries: readonly EntrySummary[]): Record<Filter, number> {
  const result = Object.fromEntries(FILTERS.map(filter => [filter, 0])) as Record<Filter, number>;
  for (const entry of entries) { result.all++; if (entry.favorite) result.favourites++; result[entry.kind]++; }
  return result;
}
