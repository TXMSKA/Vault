export type Child = Node | string | false | null | undefined;
export type Props = Record<string, string | number | boolean | null | undefined | ((event: any) => void)>;
/**
 * Builds an element. Text is always set as text, never as markup. A prop whose name starts with "on" adds a listener, `true` sets the
 * attribute empty, and `false`, `null` and `undefined` leave it out.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (name.startsWith("on") && typeof value === "function") element.addEventListener(name.slice(2), value);
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) if (child !== false && child != null) element.append(child);
  return element;
}
export const div = (className: string, ...children: Child[]) => h("div", { class: className }, ...children);
export const span = (className: string, text: string) => h("span", { class: className }, text);
