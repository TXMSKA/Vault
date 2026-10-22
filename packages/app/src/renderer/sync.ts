import type { SyncView } from "../shared/api.js";
import { div, h } from "./dom.ts";
import { icon } from "./icons.ts";
import type { IconName } from "./icons.ts";
import { dialogBox } from "./overlays.ts";
import { busy, button, checkbox, choice, field, iconButton, link, notice, reason } from "./parts.ts";
import { session } from "./session.ts";
import { bridge, flow, go, view } from "./ui.ts";
import type { Context } from "./ui.ts";
import type { Dictionary } from "./i18n.ts";

type Via = "quantum" | "folder";
/** Where the person is in setting up sync; it lasts while the page or the join screens stay open, and starts over each time they open. */
const progress = { via: "quantum" as Via, folder: undefined as string | undefined, step: "choose" as "choose" | "signing" | "signed" | "password", account: "", datasets: 0, moving: false, recovery: false };
const restart = () => { progress.via = "quantum"; progress.folder = undefined; progress.step = "choose"; progress.account = ""; progress.datasets = 0; progress.moving = false; progress.recovery = false; };

const failureText = (t: Dictionary, code: string) =>
  code === "quantum_url_required" ? t.quantumMissing : code === "sync_signin_timeout" ? t.signInTimeout : code === "sync_signin_failed" ? t.signInFailed : code === "no_folder" ? t.folderFirst : reason(t, code);
const minutesSince = (iso: string | null) => iso ? Math.max(0, (Date.now() - Date.parse(iso)) / 60000) : 0;

/** The Sync row of the settings page: Set up while sync is off; where it goes and Manage while it is on. */
export function syncSetting(t: Dictionary): HTMLElement {
  const control = div("synccontrol");
  const open = () => { restart(); session.page = "sync"; view.redraw(); };
  const paint = (status?: SyncView) => control.replaceChildren(...status?.configured
    ? [h("span", { class: "dim" }, t.syncOn(status.origin ?? "quantum")), button(t.manage, { onclick: open })]
    : [button(t.setUp, { onclick: open })]);
  paint();
  void bridge.syncStatus().then(result => { if (result.ok) paint(result.status); });
  return div("setting", div("scopy", h("strong", { class: "strong" }, t.syncTitle), h("span", { class: "line" }, t.syncLine)), control);
}

/** The account the browser signed in to, with a way to use another. */
const accountCard = (t: Dictionary, again: () => void) =>
  div("account", icon("check", 18), div("acopy", h("strong", { class: "strong" }, t.signedIn), h("span", { class: "line" }, progress.account)), link(t.otherAccount, again));

/**
 * The page behind Settings, Sync: off, it offers the Cosmic account or a cloud folder, waits for the browser sign-in and starts sync; on, it says where sync goes,
 * when it last ran, the account's storage and the computers, with Sync now, Move to Cosmic account (folder) and Turn off sync.
 */
export function syncScreen(context: Context): HTMLElement {
  const { t } = context;
  const content = div("syncbody"), status = div("slot");
  let current: SyncView | undefined, disposed = false;
  view.leave(() => { disposed = true; if (progress.step === "signing") void bridge.syncCancel(); });
  const show = (...nodes: (HTMLElement | false | null | undefined)[]) => { if (!disposed) content.replaceChildren(...nodes.filter((node): node is HTMLElement => !!node)); };
  const fail = (code: string) => status.replaceChildren(notice("circleAlert", failureText(t, code), "error"));

  async function signIn() {
    status.replaceChildren(); const opened = await bridge.syncSignIn();
    if (!opened.ok) { progress.step = "choose"; draw(); fail(opened.code); return; }
    progress.step = "signing"; draw();
    const result = await bridge.syncWait(); if (disposed || result.ok === false && result.code === "cancelled") return;
    if (!result.ok) { progress.moving = false; progress.step = "choose"; draw(); fail(result.code); return; }
    progress.account = result.account; progress.datasets = result.datasets;
    if (progress.moving) { const moved = await bridge.syncMove(); progress.moving = false; if (!moved.ok) { await load(); fail(moved.code); return; } current = moved.status; progress.step = "choose"; draw(); return; }
    if (current?.configured) { const synced = await bridge.syncNow(); await load(); if (!synced.ok) fail(synced.code); return; }
    progress.step = "signed"; draw();
  }
  function chooseView(): HTMLElement {
    const options = (["quantum", "folder"] as const).map(value => choice("via", value, value === "quantum" ? t.viaAccount : t.viaFolder, value === "quantum" ? t.viaAccountLine : t.viaFolderLine, progress.via === value, () => { progress.via = value; status.replaceChildren(); draw(); }));
    const folder = field({ name: "folder", glyph: "folderOpen", placeholder: t.noFolder, readonly: true, t, grow: true, value: progress.folder ?? "" });
    folder.input.setAttribute("aria-label", t.folderLabel);
    const pick = button(t.choose, { onclick: async () => { const result = await bridge.syncChooseFolder(); if (result.ok) { progress.folder = result.name; folder.input.value = result.name; status.replaceChildren(); } else if (result.code !== "cancelled") fail(result.code); } });
    const go = progress.via === "quantum"
      ? button(t.signIn, { primary: true, glyph: "externalLink", onclick: () => { void signIn(); } })
      : button(t.startSync, { primary: true, onclick: async () => {
        if (!progress.folder) { fail("no_folder"); return; }
        const result = await busy(content, () => bridge.syncSetup({ via: "folder" })); if (!result.ok) { fail(result.code); return; } current = result.status; draw();
      } });
    return div("syncstep", h("p", { class: "lead" }, t.syncIntro), div("choices", ...options.map(option => option.root)),
      progress.via === "folder" && div("fg", h("label", { class: "label" }, t.folderLabel), div("pick", folder.root, pick)), status, div("fill"), div("actions", div("fill"), go));
  }
  function signedView(): HTMLElement {
    const again = () => { void signIn(); };
    if (progress.datasets > 0) {
      const out = button(t.signOut, { onclick: async () => { const result = await bridge.syncSignOut(); if (!result.ok) { fail(result.code); return; } restart(); draw(); } });
      return div("syncstep", accountCard(t, again), div("alert", icon("triangleAlert", 18), h("span", {}, t.takenAlert)), h("p", { class: "lead" }, t.takenBody), status, div("fill"), div("actions", div("fill"), out));
    }
    const start = button(t.startSync, { primary: true, onclick: async () => { const result = await busy(content, () => bridge.syncSetup({ via: "quantum" })); if (!result.ok) { fail(result.code); return; } current = result.status; progress.step = "choose"; draw(); } });
    return div("syncstep", accountCard(t, again), h("p", { class: "lead" }, t.startBody), notice("info", t.startNotice), status, div("fill"), div("actions", div("fill"), start));
  }
  function onView(s: SyncView): HTMLElement {
    const problem = s.problem === "sync_plan_required" ? { text: t.problemPlan } : s.problem === "sync_signin_required" ? { text: t.problemSignIn, action: t.signIn } : s.problem === "sync_storage_full" ? { text: t.problemFull } : s.problem ? { text: t.problemOther } : undefined;
    const row = (title: string, line: string, control?: HTMLElement | null) => div("setting", div("scopy", h("strong", { class: "strong" }, title), h("span", { class: "line" }, line)), control ?? null);
    const move = () => {
      const close = () => view.modal(undefined);
      const { root } = dialogBox({ title: t.moveTitle, onescape: close }, [h("p", { class: "lead" }, t.moveBody)],
        [button(t.cancel, { onclick: close }), button(t.moveYes, { primary: true, onclick: () => { close(); progress.moving = true; void signIn(); } })]);
      view.modal(root);
    };
    const turnOff = () => {
      const remove = checkbox(t.removeCopies(s.origin ?? "quantum"), false, () => undefined), signOut = checkbox(t.signOutToo, true, () => undefined), slot = div("slot");
      const close = () => view.modal(undefined);
      const { root, dialog } = dialogBox({ title: t.turnOffTitle, onescape: close }, [h("p", { class: "lead" }, t.turnOffBody), remove.root, s.origin === "quantum" ? signOut.root : null, slot].filter((node): node is HTMLElement => !!node),
        [button(t.cancel, { onclick: close }), button(t.turnOffYes, { danger: true, onclick: async () => {
          const result = await busy(dialog, () => bridge.syncLeave({ remove: remove.input.checked, signOut: s.origin === "quantum" && signOut.input.checked }));
          if (!result.ok) { slot.replaceChildren(notice("circleAlert", failureText(t, result.code), "error")); return; }
          close(); current = result.status; restart(); draw();
        } })]);
      view.modal(root);
    };
    const now = button(t.syncNow, { glyph: "refreshCw", onclick: async () => { status.replaceChildren(); const result = await busy(content, () => bridge.syncNow()); if (result.ok) { current = result.status; draw(); } else { await load(); fail(result.code); } } });
    const computer = (glyph: IconName, name: string) => div("computer", icon(glyph, 18), h("strong", { class: "strong" }, name));
    return div("syncstep",
      problem && div("alert", icon("triangleAlert", 18), h("span", { class: "grow" }, problem.text), problem.action ? button(problem.action, { onclick: () => { void signIn(); } }) : null),
      div("syncrows",
        s.origin === "folder" ? row(t.viaFolder, s.folder ?? "", button(t.moveToAccount, { onclick: move })) : row(t.viaAccount, s.account ?? ""),
        row(t.lastSynced, t.lastSyncedLine(s.lastSynced ? t.ago(minutesSince(s.lastSynced)) : t.notYet), now),
        s.origin === "quantum" && s.storage ? row(t.storage, t.storageLine(s.storage.used, s.storage.pool)) : null),
      div("computers", h("span", { class: "label" }, t.computers), computer("monitor", t.thisComputer), ...Array.from({ length: s.others }, () => computer("laptop", t.otherComputer))),
      status, div("fill"), div("actions", button(t.turnOff, { danger: true, onclick: turnOff }), div("fill")));
  }
  function signingView(): HTMLElement {
    return div("syncwait",
      div("waiticon", icon("externalLink", 22)), h("h2", { class: "h h20" }, t.signingTitle), h("p", { class: "lead" }, t.signingBody),
      div("actions gap", button(t.cancel, { onclick: async () => { await bridge.syncCancel(); progress.moving = false; progress.step = "choose"; draw(); } }), button(t.openAgain, { onclick: () => { void signIn(); } })),
      status);
  }
  function draw() {
    if (current?.configured && progress.step !== "signing") { show(onView(current)); return; }
    show(progress.step === "signing" ? signingView() : progress.step === "signed" ? signedView() : chooseView());
  }
  async function load() { const result = await bridge.syncStatus(); if (disposed) return; if (result.ok) current = result.status; else fail(result.code); draw(); }
  const back = iconButton("arrowLeft", t.backToList, () => { session.page = "settings"; view.redraw(); }, 18);
  void load();
  return div("view page syncpage", div("sectionhead", back, h("h1", { class: "h h18" }, t.syncPageTitle)), content);
}

/** Join a synced vault, from the welcome screen: the Cosmic account or a cloud folder, then the master password (or the recovery key) of that vault. */
export function joinScreen({ t }: Context): HTMLElement {
  const content = div("syncbody"), status = div("slot");
  let disposed = false;
  view.leave(() => { disposed = true; if (progress.step === "signing") void bridge.syncCancel(); });
  const show = (node: HTMLElement) => { if (!disposed) content.replaceChildren(node); };
  const fail = (code: string) => status.replaceChildren(notice("circleAlert", failureText(t, code), "error"));
  async function signIn() {
    status.replaceChildren(); const opened = await bridge.syncSignIn();
    if (!opened.ok) { progress.step = "choose"; draw(); fail(opened.code); return; }
    progress.step = "signing"; draw();
    const result = await bridge.syncWait(); if (disposed || result.ok === false && result.code === "cancelled") return;
    if (!result.ok) { progress.step = "choose"; draw(); fail(result.code); return; }
    progress.account = result.account; progress.datasets = result.datasets; progress.step = "password"; draw();
  }
  function chooseView(): HTMLElement {
    const options = (["quantum", "folder"] as const).map(value => choice("via", value, value === "quantum" ? t.viaAccount : t.viaFolder, value === "quantum" ? t.viaAccountLine : t.viaFolderLine, progress.via === value, () => { progress.via = value; status.replaceChildren(); draw(); }));
    const folder = field({ name: "folder", glyph: "folderOpen", placeholder: t.noFolder, readonly: true, t, grow: true, value: progress.folder ?? "" });
    folder.input.setAttribute("aria-label", t.folderLabel);
    const pick = button(t.choose, { onclick: async () => { const result = await bridge.syncChooseFolder(); if (result.ok) { progress.folder = result.name; folder.input.value = result.name; status.replaceChildren(); } else if (result.code !== "cancelled") fail(result.code); } });
    const next = progress.via === "quantum"
      ? button(t.signIn, { primary: true, glyph: "externalLink", onclick: () => { void signIn(); } })
      : button(t.continue, { primary: true, onclick: () => { if (!progress.folder) { fail("no_folder"); return; } progress.step = "password"; draw(); } });
    return div("syncstep", h("p", { class: "lead" }, t.syncIntro), div("choices", ...options.map(option => option.root)),
      progress.via === "folder" && div("fg", h("label", { class: "label" }, t.folderLabel), div("pick", folder.root, pick)), status, div("fill"), div("actions", div("fill"), next));
  }
  function passwordView(): HTMLElement {
    const account = progress.via === "quantum";
    if (account && progress.datasets === 0) {
      const out = button(t.signOut, { onclick: async () => { await bridge.syncSignOut(); restart(); draw(); } });
      return div("syncstep", accountCard(t, () => { void signIn(); }), notice("info", t.joinEmpty), status, div("fill"), div("actions", div("fill"), out));
    }
    const secret = progress.recovery
      ? field({ label: t.joinRecovery, name: "recovery", mono: true, secret: true, reveal: true, autocomplete: "off", t })
      : field({ label: t.masterPassword, name: "password", mono: true, secret: true, reveal: true, placeholder: t.joinPlaceholder, autocomplete: "current-password", t });
    const swap = link(progress.recovery ? t.usePassword : t.useRecovery, () => { progress.recovery = !progress.recovery; status.replaceChildren(); draw(); });
    const form = h("form", { class: "syncstep", novalidate: true, onsubmit: (event: Event) => event.preventDefault() },
      account ? accountCard(t, () => { void signIn(); }) : null, h("p", { class: "lead" }, account ? t.joinBody : t.joinFolderBody), secret.root, div("pick", swap), status, div("fill"),
      div("actions", div("fill"), button(t.join, { primary: true, type: "submit" })));
    form.addEventListener("submit", async () => {
      const typed = secret.input.value; secret.error(); status.replaceChildren();
      if (!typed) { secret.input.focus(); return; }
      const result = await busy(form, () => bridge.syncJoin(progress.recovery ? { via: progress.via, recovery: typed } : { via: progress.via, password: typed }));
      secret.input.value = "";
      if (result.ok) { restart(); flow.first = "welcome"; await view.sync(); return; }
      secret.input.focus();
      if (result.code === "locked") secret.error(progress.recovery ? t.joinWrongRecovery : t.joinWrong); else fail(result.code);
    });
    queueMicrotask(() => secret.input.focus());
    return form;
  }
  function signingView(): HTMLElement {
    return div("syncwait",
      div("waiticon", icon("externalLink", 22)), h("h2", { class: "h h20" }, t.signingTitle), h("p", { class: "lead" }, t.signingBody),
      div("actions gap", button(t.cancel, { onclick: async () => { await bridge.syncCancel(); progress.step = "choose"; draw(); } }), button(t.openAgain, { onclick: () => { void signIn(); } })),
      status);
  }
  function draw() { show(progress.step === "signing" ? signingView() : progress.step === "password" ? passwordView() : chooseView()); }
  const back = iconButton("arrowLeft", t.back, () => { if (progress.step === "signing") void bridge.syncCancel(); restart(); go(() => { flow.first = "welcome"; }); }, 18);
  draw();
  return div("view page syncpage", div("sectionhead", back, h("h1", { class: "h h18" }, t.joinTitle)), content);
}
/** Called when the welcome screen sends the person here, so each visit starts at the first step. */
export const startJoin = restart;
