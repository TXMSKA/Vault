import { div, h } from "./dom.ts";
import { icon } from "./icons.ts";
import type { IconName } from "./icons.ts";
export type MenuItem = { label: string; line?: string; hint?: string; glyph?: IconName; on?: boolean; disabled?: boolean; run?(): void } | "rule";
export type Popover = { root: HTMLElement; close(): void };
let open: { popover: Popover; anchor: HTMLElement } | undefined;
/** Closes whatever is open: a menu or a popover, at most one at a time. */
export function closePopovers() { open?.popover.close(); }
/**
 * Puts `content` under `anchor`, in the board's open-list look: it closes on a press outside it, on Escape, when the window loses focus or changes size,
 * and gives the focus back to the anchor. `align` says which edge of the anchor it lines up with.
 */
export function openPopover(anchor: HTMLElement, content: HTMLElement, options: { width: number; align?: "left" | "right"; label: string; role?: string; onclose?: () => void }): Popover {
  closePopovers();
  const root = div("popover", content);
  root.setAttribute("role", options.role ?? "dialog"); root.setAttribute("aria-label", options.label); root.style.width = `${options.width}px`;
  document.body.append(root);
  const box = anchor.getBoundingClientRect(), width = options.width;
  const left = options.align === "right" ? box.right - width : box.left;
  root.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  root.style.top = `${Math.min(box.bottom + 6, Math.max(8, window.innerHeight - root.offsetHeight - 8))}px`;
  anchor.setAttribute("aria-expanded", "true"); anchor.classList.add("open");
  let closed = false;
  const outside = (event: Event) => { if (!root.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(); };
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); anchor.focus(); } };
  const away = () => close();
  function close() {
    if (closed) return; closed = true;
    document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); window.removeEventListener("blur", away); window.removeEventListener("resize", away);
    anchor.setAttribute("aria-expanded", "false"); anchor.classList.remove("open"); root.remove();
    if (open?.popover === popover) open = undefined;
    options.onclose?.();
  }
  const popover: Popover = { root, close };
  document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape, true); window.addEventListener("blur", away); window.addEventListener("resize", away);
  open = { popover, anchor };
  return popover;
}
/** A list of choices under `anchor`. A choice that is `on` carries the check; one that is `disabled` shows its line and does nothing. */
export function openMenu(anchor: HTMLElement, items: MenuItem[], options: { width: number; align?: "left" | "right"; label: string; choose?: boolean }): Popover {
  const buttons: HTMLButtonElement[] = [];
  const list = div("menu", ...items.map(item => {
    if (item === "rule") return div("rule");
    const button = h("button", { class: `menu-item${item.line ? " tall" : ""}${item.disabled ? " off" : ""}`, type: "button", role: options.choose ? "menuitemradio" : "menuitem", "aria-checked": options.choose ? String(!!item.on) : undefined, "aria-disabled": item.disabled ? "true" : undefined, title: item.disabled ? item.line : undefined,
      onclick: () => { if (item.disabled) return; popover.close(); anchor.focus(); item.run?.(); } },
      item.glyph && icon(item.glyph, 16),
      div("copy", h("span", { class: "name" }, item.label), item.line && h("span", { class: "line" }, item.line)),
      item.hint && h("span", { class: "hint" }, item.hint),
      item.on && icon("check", 16));
    buttons.push(button); return button;
  }));
  list.setAttribute("role", "menu");
  const popover = openPopover(anchor, list, { ...options, role: "presentation" });
  const enabled = () => buttons.filter(button => button.getAttribute("aria-disabled") !== "true");
  list.addEventListener("keydown", event => {
    const keys = enabled(), at = keys.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") { event.preventDefault(); keys[(at + 1) % keys.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); keys[(at - 1 + keys.length) % keys.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); keys[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); keys.at(-1)?.focus(); }
    else if (event.key === "Tab") popover.close();
  });
  (buttons.find(button => button.getAttribute("aria-checked") === "true") ?? enabled()[0])?.focus();
  return popover;
}
/** Whether `anchor` has its menu open, so that pressing it again closes the menu instead of opening another. */
export const opened = (anchor: HTMLElement) => anchor.classList.contains("open");
