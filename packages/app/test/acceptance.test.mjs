import "../../../test/guard.mjs";
import assert from "node:assert/strict";
import { en, es } from "../src/renderer/i18n.ts";
import { createSync } from "../src/main/sync.ts";

class ClassList {
  constructor(el) { this.el = el; }
  add(...names) { for (const name of names) if (name && !this.el.classes.includes(name)) this.el.classes.push(name); this.el.syncClass(); }
  remove(...names) { this.el.classes = this.el.classes.filter(name => !names.includes(name)); this.el.syncClass(); }
  toggle(name, on = !this.contains(name)) { if (on) this.add(name); else this.remove(name); }
  contains(name) { return this.el.classes.includes(name); }
}
class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.classes = []; this.classList = new ClassList(this); this.disabled = false; this.checked = false; this._value = ""; this.style = {}; }
  syncClass() { this.attrs.class = this.classes.join(" "); }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === "class") this.classes = String(value).split(/\s+/).filter(Boolean); if (name === "value") this._value = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== fn); }
  dispatch(type) { const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }; for (const fn of [...(this.listeners[type] ?? [])]) fn(event); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  querySelectorAll(selector) {
    const tags = selector.split(",").map(item => item.trim()), out = [];
    const visit = node => { for (const child of node.children ?? []) { if (!child || typeof child === "string") continue; if (tags.includes(child.tag)) out.push(child); visit(child); } };
    visit(this); return out;
  }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get type() { return this.attrs.type ?? ""; }
  set type(value) { this.attrs.type = value; }
  focus() {}
}
const textOf = node => node == null || node === false ? "" : typeof node === "string" ? node : (node.children ?? []).map(textOf).join("");
const buttons = (root, label) => {
  const found = [];
  const visit = node => { if (!node || typeof node === "string") return; if (node.tag === "button" && textOf(node).trim() === label) found.push(node); for (const child of node.children ?? []) visit(child); };
  visit(root); return found;
};
const click = (root, label) => { const found = buttons(root, label); if (found.length !== 1) throw new Error(`missing ${label}`); found[0].dispatch("click"); };
const field = (root, name) => {
  let found;
  const visit = node => { if (found || !node || typeof node === "string") return; if (node.tag === "input" && node.attrs.name === name) found = node; for (const child of node.children ?? []) visit(child); };
  visit(root); if (!found) throw new Error("missing field"); return found;
};
const formOf = root => {
  let found;
  const visit = node => { if (found || !node || typeof node === "string") return; if (node.tag === "form") found = node; for (const child of node.children ?? []) visit(child); };
  visit(root); if (!found) throw new Error("missing form"); return found;
};
const until = async (step, predicate) => { for (let i = 0; i < 20 && !predicate(); i++) await new Promise(resolve => { setTimeout(resolve, 0); }); if (!predicate()) throw new Error(step); };

const calls = [], source = { configured: false, origin: null, account: null, folder: null, storage: null, lastSynced: null, others: 0, pending: 0, conflicts: 0, problem: null, managedSync: true, missingPolicies: [] };
let datasets = 0, releaseWait = () => {};
const bridge = {
  syncStatus: async () => ({ ok: true, status: source }),
  syncSignIn: async () => ({ ok: true }),
  syncWait: async () => ({ ok: true, account: "qa@example.invalid", datasets }),
  syncSetup: async () => { calls.push("setup"); return { ok: false, code: "sync_acceptance_required" }; },
  syncJoin: async () => { calls.push("join"); return { ok: false, code: "sync_acceptance_required" }; },
  syncAcceptance: async () => { calls.push("acceptance"); return { ok: true }; },
  syncAcceptanceOpen: async () => ({ ok: true }),
  syncAcceptanceWait: () => new Promise(resolve => { releaseWait = resolve; }),
  syncCancel: async () => { calls.push("cancel"); releaseWait({ ok: false, code: "cancelled" }); return { ok: true }; },
  syncChooseFolder: async () => ({ ok: false, code: "cancelled" }),
  syncSignOut: async () => ({ ok: true }),
  syncMove: async () => ({ ok: false, code: "cancelled" }),
  syncNow: async () => ({ ok: false, code: "cancelled" }),
  syncLeave: async () => ({ ok: true, status: source }),
};
globalThis.document = { createElement: tag => new El(tag), createElementNS: (_namespace, tag) => new El(tag) };
globalThis.window = { vault: bridge };
const { syncScreen, joinScreen, startJoin } = await import("../src/renderer/sync.ts");

const screen = (builder, dictionary) => builder({ t: dictionary, state: {} });
let stage = "setup";
try {
  datasets = 0; calls.length = 0; startJoin();
  const setup = screen(syncScreen, en);
  await until("sign-in", () => buttons(setup, en.signIn).length === 1);
  click(setup, en.signIn);
  await until("start", () => buttons(setup, en.startSync).length === 1);
  click(setup, en.startSync);
  await until("setup-offer", () => buttons(setup, en.acceptInBrowser).length === 1);
  assert.equal(buttons(setup, en.acceptInBrowser).length, 1);
  assert.equal(textOf(setup).includes(en.problemAcceptance), true);
  assert.equal(calls.filter(item => item === "acceptance").length, 0);
  assert.equal(buttons(setup, en.startSync).length, 1);
  click(setup, en.acceptInBrowser);
  await until("setup-wait", () => textOf(setup).includes(en.acceptingBody));
  assert.equal(calls.filter(item => item === "acceptance").length, 1);
  assert.equal(buttons(setup, en.cancel).length, 1);
  assert.equal(buttons(setup, en.openAgain).length, 1);
  assert.equal(buttons(setup, en.acceptInBrowser).length, 0);
  releaseWait({ ok: true, status: source });
  await until("setup-return", () => buttons(setup, en.startSync).length === 1 && !textOf(setup).includes(en.acceptingBody));
  assert.equal(calls.filter(item => item === "setup").length, 1);

  stage = "join";
  datasets = 1; calls.length = 0; startJoin();
  const join = screen(joinScreen, en);
  click(join, en.signIn);
  await until("password", () => { try { return field(join, "password").tag === "input"; } catch { return false; } });
  const secret = field(join, "password"); secret.value = "synthetic";
  formOf(join).dispatch("submit");
  await until("join-offer", () => buttons(join, en.acceptInBrowser).length === 1);
  assert.equal(secret.value, "");
  assert.equal(buttons(join, en.acceptInBrowser).length, 1);
  assert.equal(textOf(join).includes(en.problemAcceptance), true);
  assert.equal(calls.filter(item => item === "acceptance").length, 0);
  click(join, en.acceptInBrowser);
  await until("join-wait", () => textOf(join).includes(en.acceptingBody));
  assert.equal(buttons(join, en.cancel).length, 1);
  assert.equal(buttons(join, en.openAgain).length, 1);
  click(join, en.cancel);
  await until("join-return", () => !textOf(join).includes(en.acceptingBody) && buttons(join, en.join).length === 1);
  assert.equal(field(join, "password").value, "");
  assert.equal(calls.filter(item => item === "join").length, 1);
  assert.equal(calls.includes("cancel"), true);

  stage = "spanish";
  datasets = 0; calls.length = 0; startJoin();
  const spanish = screen(syncScreen, es);
  await until("spanish-sign-in", () => buttons(spanish, es.signIn).length === 1);
  click(spanish, es.signIn);
  await until("spanish-start", () => buttons(spanish, es.startSync).length === 1);
  click(spanish, es.startSync);
  await until("spanish-offer", () => buttons(spanish, es.acceptInBrowser).length === 1);
  assert.equal(buttons(spanish, es.acceptInBrowser).length, 1);
  assert.equal(textOf(spanish).includes("dispositivo"), true);
  assert.equal(calls.filter(item => item === "acceptance").length, 0);

  stage = "setup-signin";
  const savedWait = bridge.syncWait;
  bridge.syncWait = async () => ({ ok: false, code: "sync_acceptance_required" });
  datasets = 0; calls.length = 0; startJoin();
  const setupRefused = screen(syncScreen, en);
  await until("setup-signin-button", () => buttons(setupRefused, en.signIn).length === 1);
  click(setupRefused, en.signIn);
  await until("setup-signin-offer", () => buttons(setupRefused, en.acceptInBrowser).length === 1);
  click(setupRefused, en.acceptInBrowser);
  await until("setup-signin-accepting", () => textOf(setupRefused).includes(en.acceptingBody));
  releaseWait({ ok: true, status: source, account: "qa@example.invalid", datasets: 0 });
  await until("setup-signin-start", () => buttons(setupRefused, en.startSync).length === 1);
  assert.equal(buttons(setupRefused, en.signIn).length, 0);
  assert.equal(textOf(setupRefused).includes("qa@example.invalid"), true);
  assert.equal(calls.filter(item => item === "setup").length, 0);

  stage = "join-signin";
  bridge.syncWait = async () => ({ ok: false, code: "sync_acceptance_required" });
  datasets = 0; calls.length = 0; startJoin();
  const refused = screen(joinScreen, en);
  click(refused, en.signIn);
  await until("signin-offer", () => buttons(refused, en.acceptInBrowser).length === 1);
  assert.equal(textOf(refused).includes(en.joinEmpty), false);
  click(refused, en.acceptInBrowser);
  await until("signin-wait", () => textOf(refused).includes(en.acceptingBody));
  click(refused, en.cancel);
  await until("signin-back", () => buttons(refused, en.signIn).length === 1 && !textOf(refused).includes(en.acceptingBody));
  assert.equal(textOf(refused).includes(en.joinEmpty), false);
  assert.equal(buttons(refused, en.join).length, 0);

  calls.length = 0; startJoin();
  const resumed = screen(joinScreen, en);
  click(resumed, en.signIn);
  await until("signin-again", () => buttons(resumed, en.acceptInBrowser).length === 1);
  click(resumed, en.acceptInBrowser);
  await until("signin-accepting", () => textOf(resumed).includes(en.acceptingBody));
  releaseWait({ ok: true, status: source, account: "qa@example.invalid", datasets: 1 });
  await until("signin-password", () => { try { return field(resumed, "password").tag === "input"; } catch { return false; } });
  assert.equal(textOf(resumed).includes(en.joinEmpty), false);
  assert.equal(textOf(resumed).includes("qa@example.invalid"), true);
  assert.equal(buttons(resumed, en.join).length, 1);
  bridge.syncWait = savedWait;

  stage = "join-count";
  let reads = 0;
  const quantum = {
    signIn: async () => ({ url: "https://accounts.example.invalid/authorize/", id: "sign-join" }),
    wait: async () => ({ account: "qa@example.invalid" }),
    account: async () => { reads += 1; if (reads === 1) throw { code: "sync_acceptance_required" }; return { account: "qa@example.invalid", datasets: 1 }; },
    acceptance: async () => ({ url: "https://accounts.example.invalid/", id: "flow-join" }),
    poll: async () => ({ account: "qa@example.invalid" }),
    cancelAcceptance: async () => ({ ok: true }),
  };
  const held = { configured: false, origin: null, account: null, folder: null, storage: null, lastSynced: null, computers: [], pending: 0, conflicts: 0, failure: null, managedSync: true, missingPolicies: [] };
  const main = createSync({ service: () => ({ sync: { status: async () => held, quantum } }), quantum: () => ({ api: "https://api.example.invalid", site: "https://accounts.example.invalid" }), openUrl: async () => {}, chooseFolder: async () => undefined, refresh: async () => {} });
  assert.equal((await main.signIn()).ok, true);
  const blocked = await main.wait();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "sync_acceptance_required");
  assert.equal(Object.hasOwn(blocked, "datasets"), false);
  assert.equal((await main.acceptance()).ok, true);
  const counted = await main.acceptanceWait();
  assert.equal(counted.ok, true);
  assert.equal(counted.datasets, 1);
  assert.equal(counted.account, "qa@example.invalid");
  assert.equal(reads, 2);

  stage = "join-count-lifecycle";
  for (const mode of ["blur", "cancel"]) {
    const releases = []; let loads = 0, polls = 0;
    const held2 = {
      ...quantum,
      account: () => new Promise((resolve, reject) => { loads += 1; const n = loads; releases.push(() => n === 1 ? reject({ code: "sync_acceptance_required" }) : n === 2 ? resolve({ account: "qa@example.invalid", datasets: 1 }) : resolve({ account: "qa@example.invalid", datasets: 1 })); }),
      poll: async () => { polls += 1; return { account: "qa@example.invalid" }; },
    };
    const m = createSync({ service: () => ({ sync: { status: async () => held, quantum: held2 } }), quantum: () => ({ api: "https://api.example.invalid", site: "https://accounts.example.invalid" }), openUrl: async () => {}, chooseFolder: async () => undefined, refresh: async () => {} });
    assert.equal((await m.signIn()).ok, true);
    const first = m.wait(); await new Promise(r => setTimeout(r, 5)); releases[0](); assert.equal((await first).code, "sync_acceptance_required");
    assert.equal((await m.acceptance()).ok, true);
    let settled; const pending = m.acceptanceWait().then(value => { settled = value; return value; });
    await new Promise(r => setTimeout(r, 5)); assert.equal(releases.length, 2);
    if (mode === "blur") m.foreground(false); else await m.cancel();
    releases[1](); await new Promise(r => setTimeout(r, 10));
    if (mode === "cancel") { assert.equal(settled?.ok, false); assert.equal(settled.code, "cancelled"); continue; }
    assert.equal(settled, undefined);
    m.foreground(true); await new Promise(r => setTimeout(r, 5)); releases[2]?.();
    const done = await pending; assert.equal(done.ok, true); assert.equal(done.datasets, 1); assert.equal(polls, 2);
  }
} catch (error) {
  console.error(`Vault app acceptance failed at ${stage}: assertion.`);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*acceptance\.test\.mjs:\d+:\d+/.test(line)).join("\n"));
  throw new Error("app acceptance check failed");
}
