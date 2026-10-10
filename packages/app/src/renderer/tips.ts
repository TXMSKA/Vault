import { div, h } from "./dom.ts";
import { button } from "./parts.ts";
import type { Context } from "./ui.ts";
/** The first-open tips: a card over the corner of the list, three things to a page, so the rest of the window works around it. */
export function tipsCard({ t }: Context, page: 1 | 2, hooks: { more(): void; done(): void }): HTMLElement {
  const items = page === 1
    ? [[t.tipAddTitle, t.tipAddLine], [t.tipCopyTitle, t.tipCopyLine], [t.tipUnlockTitle, t.tipUnlockLine]]
    : [[t.tipLockTitle, t.tipLockLine], [t.tipAppsTitle, t.tipAppsLine], [t.tipRecoveryTitle, t.tipRecoveryLine]];
  const card = div("tips", div("tiphead", h("strong", { class: "strong" }, page === 1 ? t.tipsWelcome : t.tipsMore), div("fill"), h("span", { class: "hint" }, t.tipsOf(page))),
    ...items.map(([title, line]) => div("tip", h("span", { class: "tt" }, title), h("span", { class: "tl" }, line))),
    div("actions gap", div("fill"), page === 1 ? button(t.gotIt, { onclick: hooks.done }) : null, button(page === 1 ? t.more : t.done, { primary: true, onclick: page === 1 ? hooks.more : hooks.done })));
  card.setAttribute("role", "region"); card.setAttribute("aria-label", page === 1 ? t.tipsWelcome : t.tipsMore);
  return card;
}
