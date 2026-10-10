import type { EntryView, Kind } from "../shared/api.js";
import { div, h } from "./dom.ts";
import { entryPane, tile } from "./entry.ts";
import type { EntryPane } from "./entry.ts";
import { counts, FILTERS, visible } from "./filter.ts";
import type { Filter } from "./filter.ts";
import { formPane } from "./form.ts";
import type { FormPane } from "./form.ts";
import { icon, mark } from "./icons.ts";
import type { IconName } from "./icons.ts";
import { ADD_ORDER, KIND_GLYPH } from "./kinds.ts";
import { closePopovers, openMenu, opened } from "./menu.ts";
import { clearToast, confirm, showToast } from "./overlays.ts";
import { button, heading, iconButton, reason } from "./parts.ts";
import { session } from "./session.ts";
import { tipsCard } from "./tips.ts";
import { bridge, view } from "./ui.ts";
import type { Context } from "./ui.ts";
const SHORT_TOAST = 5000, UNDO_TOAST = 9000, REFRESH_MS = 15000;
/**
 * The open vault: the list with its search, its filter and its add button on the left, and on the right the entry that is open, the form that adds or edits one, or
 * the empty state. It keeps nothing that is secret: the rows and the open entry come from the main process without secret values, and a value is asked for when
 * the person reveals or copies it.
 */
export function listScreen(context: Context): HTMLElement {
  const { t } = context;
  let pane: EntryPane | undefined, form: FormPane | undefined, token = 0;
  const search = h("input", { type: "text", name: "search", placeholder: t.search, "aria-label": t.search, autocomplete: "off", spellcheck: "false", value: session.search });
  const clearSearch = iconButton("x", t.clearSearch, () => { search.value = ""; typed(); search.focus(); }, 14);
  clearSearch.classList.add("clear");
  const addButton = h("button", { class: "add", type: "button", "aria-label": t.addEntry, title: t.addEntry, "aria-haspopup": "menu", "aria-expanded": "false" }, icon("plus", 18, 2.4));
  const filterName = h("span", {}, ""), count = h("span", { class: "count" }, "");
  const filterButton = h("button", { class: "filter", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" }, filterName, icon("chevronDown", 14));
  const filterRow = div("filterrow", filterButton, div("fill"), count), rows = div("rows");
  const content = div("pane"), detail = h("section", { class: "detail", "aria-label": t.entriesLabel }, content);
  const aside = h("aside", { class: "list", "aria-label": t.entriesLabel }, div("listtop", div("search", icon("search", 16), search, clearSearch), addButton), filterRow, rows);
  const root = div("main", aside, detail);

  const toast = (text: string, glyph: IconName = "check", action?: { label: string; run(): void }, ms = SHORT_TOAST) => { showToast(detail, { text, glyph, action, closeLabel: t.close, ms }); };
  /** A call failed: a locked vault shows the locked screen, anything else is said in a toast. */
  const failure = (code: string) => { if (code === "locked") void view.sync(); else toast(code === "conflict" ? t.conflict : reason(t, code), "circleAlert"); };
  /** Asks before an edit that was started is thrown away. */
  async function guard(next: () => void) {
    if (form?.dirty() && !(await confirm(t, { title: t.discardTitle, body: t.discardBody, yes: t.discard, danger: true, no: t.keepEditing }))) return;
    next();
  }

  function paintList() {
    const shown = visible(session.entries, session.filter, session.search), searching = session.search.trim().length > 0;
    filterName.textContent = t.filterName(searching ? "results" : session.filter); filterButton.setAttribute("aria-label", t.showLabel(filterName.textContent));
    count.textContent = String(shown.length); clearSearch.hidden = !session.search;
    filterRow.hidden = session.loaded && session.entries.length === 0;
    rows.replaceChildren(...shown.length ? shown.map(entry => {
      const on = entry.id === session.selected && session.mode !== "new";
      const row = h("button", { class: `erow${on ? " on" : ""}`, type: "button", "aria-current": on ? "true" : undefined, "data-id": entry.id, onclick: () => { void guard(() => select(entry.id)); } },
        tile(entry.title, 32), div("rt", h("span", { class: "rname" }, entry.title || "…"), h("span", { class: "rsub" }, t.sub(entry.kind, entry.detail, entry.count))));
      return row;
    }) : session.loaded && session.entries.length ? [h("p", { class: "none" }, t.noMatches)] : []);
  }
  function chooseKind(anchor: HTMLElement) {
    if (opened(anchor)) { closePopovers(); return; }
    openMenu(anchor, ADD_ORDER.map(kind => ({ label: t.kindName(kind), line: t.kindLine(kind), glyph: KIND_GLYPH[kind], run: () => { void guard(() => startNew(kind)); } })), { width: 300, label: t.addEntry });
  }
  function startNew(kind: Kind) { session.mode = "new"; session.kind = kind; session.selected = undefined; paintList(); void paintDetail(); }
  function select(id: string) { session.selected = id; session.mode = "view"; session.kind = undefined; paintList(); void paintDetail(); }
  function typed() { session.search = search.value; paintList(); }

  function empty(): HTMLElement {
    const add = button(t.addEntry, { primary: true, glyph: "plus", onclick: () => chooseKind(add) });
    add.setAttribute("aria-haspopup", "menu"); add.setAttribute("aria-expanded", "false");
    // Import is in the command line for now; the button keeps its place from the board and says where to go.
    const importing = button(t.import, { glyph: "download", disabled: true }); importing.title = t.inCommandLine("vault import");
    return div("empty", mark(40, "soft"), heading(t.emptyTitle, 18), h("p", { class: "ui14 center" }, t.emptyBody), div("actions gap", importing, add));
  }
  async function paintDetail() {
    const mine = ++token;
    pane?.dispose(); pane = undefined; form?.dispose(); form = undefined; closePopovers();
    const set = (...nodes: HTMLElement[]) => { if (mine === token) content.replaceChildren(...nodes); };
    if (session.mode === "new" && session.kind) {
      clearToast(detail); form = formPane(context, { kind: session.kind, hooks: formHooks }); set(form.root); return;
    }
    if (!session.loaded) { set(); return; }
    if (!session.entries.length) { set(empty()); return; }
    const id = session.selected;
    if (!id) { set(div("choose", h("p", { class: "ui14 center" }, t.chooseEntry))); return; }
    const result = await bridge.entryOpen({ id });
    if (mine !== token) return;
    if (!result.ok) {
      if (result.code === "not_found") { session.selected = undefined; session.mode = "view"; paintList(); set(div("choose", h("p", { class: "ui14 center" }, t.chooseEntry))); }
      else { failure(result.code); set(); }
      return;
    }
    const entry = result.entry;
    if (session.mode === "edit") { clearToast(detail); form = formPane(context, { kind: entry.kind, entry, hooks: formHooks }); set(form.root); return; }
    pane = entryPane(context, entry, {
      edit: () => { session.mode = "edit"; void paintDetail(); },
      favourite: async favorite => { const answer = await bridge.entryFavorite({ id: entry.id, favorite }); if (answer.ok) await load(); else failure(answer.code); },
      toast: (text, glyph) => toast(text, glyph ?? "check"),
      failed: failure,
    });
    set(pane.root);
  }
  async function remove(entry: EntryView) {
    if (entry.files.length && !(await confirm(t, { title: t.deleteFilesTitle(entry.title), body: t.deleteFilesBody, yes: t.deleteButton, danger: true }))) return;
    const result = await bridge.entryRemove({ id: entry.id, expected: entry.version });
    if (!result.ok) { failure(result.code); return; }
    session.mode = "view"; session.selected = undefined; session.kind = undefined;
    await load();
    const undo = async () => { const back = await bridge.entryUndo({ id: entry.id }); if (back.ok) { session.selected = entry.id; await load(); } else failure(back.code); };
    toast(t.deleted(entry.title), "trash2", result.undo ? { label: t.undo, run: () => { void undo(); } } : undefined, result.undo ? UNDO_TOAST : SHORT_TOAST);
  }
  const formHooks = {
    cancel: () => { session.mode = "view"; session.kind = undefined; paintList(); void paintDetail(); },
    saved: async (id: string) => { session.mode = "view"; session.kind = undefined; session.selected = id; await load(); },
    remove: (entry: EntryView) => { void remove(entry); },
    reload: () => { session.mode = "view"; void load(); },
  };
  /** Reads the entries again. After a change the open entry is drawn again too; when the window only came back into focus, it is left as it is. */
  async function load(options: { detail: boolean } = { detail: true }) {
    const result = await bridge.entries();
    if (!result.ok) {
      if (result.code === "locked") { await view.sync(); return; }
      if (!session.loaded) failure(result.code);
      return;
    }
    session.entries = result.entries; session.loaded = true;
    if (!session.started) {
      session.started = true;
      const first = visible(session.entries, session.filter, session.search)[0];
      if (!session.selected && session.mode === "view" && first) session.selected = first.id;
    }
    if (session.selected && !session.entries.some(entry => entry.id === session.selected)) { session.selected = undefined; if (session.mode !== "new") session.mode = "view"; }
    paintList();
    if (options.detail) await paintDetail();
    if (!session.tipsShown) {
      session.tipsShown = true;
      if (view.state().tour) { session.tips = 1; paintTips(); }
    }
  }
  function paintTips() {
    root.querySelector(".tips")?.remove();
    if (!session.tips) return;
    const dismiss = () => { session.tips = 0; paintTips(); void bridge.dismissTour(); };
    root.append(tipsCard(context, session.tips, { more: () => { session.tips = 2; paintTips(); }, done: dismiss }));
  }
  search.addEventListener("input", typed);
  search.addEventListener("keydown", event => {
    if (event.key === "Escape" && search.value) { event.preventDefault(); search.value = ""; typed(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); rows.querySelector<HTMLElement>(".erow")?.focus(); }
  });
  rows.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...rows.querySelectorAll<HTMLElement>(".erow")], at = items.indexOf(document.activeElement as HTMLElement);
    event.preventDefault(); (items[at + (event.key === "ArrowDown" ? 1 : -1)] ?? (event.key === "ArrowUp" ? search : undefined))?.focus();
  });
  addButton.addEventListener("click", () => chooseKind(addButton));
  filterButton.addEventListener("click", () => {
    if (opened(filterButton)) { closePopovers(); return; }
    const number = counts(session.entries);
    openMenu(filterButton, FILTERS.flatMap((filter: Filter) => {
      const item = { label: t.filterName(filter), hint: String(number[filter]), glyph: (filter === "all" ? "layers" : filter === "favourites" ? "star" : KIND_GLYPH[filter]) as IconName, on: !session.search.trim() && session.filter === filter, run: () => { session.filter = filter; session.search = ""; search.value = ""; paintList(); } };
      return filter === "favourites" ? [item, "rule" as const] : [item];
    }), { width: 240, choose: true, label: t.showLabel(t.filterName(session.filter)) });
  });
  const onFocus = () => { if (session.loaded) void load({ detail: false }); };
  window.addEventListener("focus", onFocus);
  // What other apps add while the window stays open shows within a quarter of a minute.
  const refresh = window.setInterval(onFocus, REFRESH_MS);
  view.tips = () => { session.tips = 1; paintTips(); };
  view.leave(() => { window.removeEventListener("focus", onFocus); clearInterval(refresh); view.tips = () => {}; pane?.dispose(); form?.dispose(); token++; closePopovers(); });
  paintList(); paintTips(); void paintDetail(); void load();
  return root;
}
