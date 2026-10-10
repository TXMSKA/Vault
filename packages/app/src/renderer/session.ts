import type { EntrySummary, Kind } from "../shared/api.js";
import type { Filter } from "./filter.ts";
/**
 * Where the person is in the open vault: the page, the list with its search and filter, the entry that is open and what is being done to it. It lives as long as
 * the vault stays open; a rebuilt screen (a change of language, say) picks up where it was. No value that is secret is ever in it.
 */
export const session = {
  page: "list" as "list" | "settings",
  entries: [] as EntrySummary[],
  loaded: false,
  search: "",
  filter: "all" as Filter,
  selected: undefined as string | undefined,
  mode: "view" as "view" | "edit" | "new",
  kind: undefined as Kind | undefined,
  /** Whether the first list was already shown, so that the first entry opens by itself once and not after the person closed it. */
  started: false,
  /** The tips on screen: none, the first card or the second. */
  tips: 0 as 0 | 1 | 2,
  /** The tips shown on their own for the first time in this run. */
  tipsShown: false,
};
export function resetSession() {
  session.page = "list"; session.entries = []; session.loaded = false; session.search = ""; session.filter = "all"; session.selected = undefined;
  session.mode = "view"; session.kind = undefined; session.started = false; session.tips = 0;
}
