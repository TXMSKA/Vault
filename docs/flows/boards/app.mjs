// Vault's own small app, screen by screen, in the direction Tom chose on the
// identity board: Dial's theme with the keyhole as the mark. The app is a
// small utility window, so each screen is the window itself (920 by 640).
// Rows follow the flow: first run, unlock, the list, an entry, adding, import,
// export, apps, settings, then the light theme. The pieces are in
// ../kit/app.mjs; the entry rows and fields are shared with the identity board
// in ../kit/vault.mjs. Every entry, site, file and person shown is invented.

import { board } from "blueprint/board.mjs";
import { box, col, row, stack, icon, fill } from "blueprint/kit.mjs";
import { DIAL_LIGHT } from "../kit/skins.mjs";
import { entryField, divider, mark } from "../kit/vault.mjs";
import {
  d, t, SIZE, BODY_H, appWindow, view, centred, sectionHead, page, setting, listPane, detail, entryHead, kindHead, smallButton, fieldGroup,
  label, strong, heading, notice, button, link, input, formField, select, toggle, checkbox, choice, menu, dialog, toast, iconButton, appIcon, CONTROL_H, slug,
} from "../kit/app.mjs";

// ---- data -------------------------------------------------------------------

const ENTRIES = [
  { name: "Northwind Mail", sub: "alex.rivera@northwind.example" },
  { name: "Riverbank", sub: "alex.rivera" },
  { name: "Pinewood Forum", sub: "arivera" },
  { name: "Atlas Card", sub: "Card ending 4821" },
  { name: "Home Wi-Fi", sub: "Note" },
  { name: "Sprout deploys", sub: "Environment, 6 values" },
  { name: "Linden Library", sub: "alex.r" },
  { name: "Lease contract", sub: "Document, PDF" },
];

const SEARCHED = [
  { name: "Northwind Mail", sub: "alex.rivera@northwind.example" },
  { name: "Northside Gym", sub: "alex.rivera" },
];

const AFTER_DELETE = ENTRIES.slice(1);

const PASSWORD = "tide-Lantern-48-orbit";
const DOTS = "•".repeat(14);

const reveal = (on) => iconButton(d, on ? "eyeOff" : "eye", { name: "reveal", label: on ? "Hide" : "Reveal" });

// ---- the open entry ---------------------------------------------------------

function entryView({ revealed = false } = {}) {
  return detail(
    entryHead(
      "Northwind Mail",
      "Login",
      iconButton(d, "star", { name: "favourite", label: "Add to favourites" }),
      smallButton("pencil", "Edit"),
    ),
    fieldGroup(
      entryField(d, t, { label: "Username", value: "alex.rivera@northwind.example", actions: ["copy"] }),
      divider(),
      entryField(d, t, { label: "Password", value: revealed ? PASSWORD : DOTS, mono: true, actions: [revealed ? "eyeOff" : "eye", "copy"] }),
      divider(),
      entryField(d, t, { label: "One-time code", value: "284 913", mono: true, accent: true, trail: t.ui("18 s", { color: "soft", name: "code-timer", label: "Seconds left" }), actions: ["copy"] }),
      divider(),
      entryField(d, t, { label: "Website", value: "northwind.example", actions: ["externalLink"] }),
    ),
    row({ gap: 8 }, icon("clock", { size: 14, color: "soft" }), t.ui("Copied values clear from the clipboard after 30 seconds.", { size: 12, color: "soft" })),
  );
}

/** The list with an entry open: the main screen of the app. */
const main = ({ entries = ENTRIES, selected = 0, right = entryView(), theme, ...list } = {}, overlays = []) =>
  appWindow({ theme, menuOpen: list.menuOpen }, row({ h: BODY_H }, listPane({ entries, selected, ...list }), right), overlays);

/** The foot of a form: an optional delete on the left, Cancel and Save on the right. */
const formFoot = (save, { remove = false } = {}) =>
  row({ gap: 10 }, remove ? button("Delete entry", { danger: true, glyph: "trash2", ref: "delete" }) : null, fill(), button("Cancel"), button(save, { primary: true, ref: "save" }));

/** A form in the right pane: its head, its fields, its foot at the bottom. */
const formPane = (head, fields, foot) => detail(head, col({ gap: 14, grow: 1 }, ...fields), foot);

const passwordInput = (value, { focus, generatorOpen } = {}) =>
  input(value, {
    mono: true,
    focus,
    placeholder: "Type one or generate it",
    ref: "password",
    title: "Password",
    trail: [
      reveal(value != null),
      stack({ w: 32, h: 32, radius: d.r.control, fill: generatorOpen ? "surface-3" : undefined, name: "generate", label: "Generate a password" }, icon("wandSparkles", { size: 16, color: generatorOpen ? "primary" : "soft", place: "center" })),
    ],
  });

function editPane() {
  return formPane(
    entryHead("Northwind Mail", "Login"),
    [
      formField("Name", input("Northwind Mail", { ref: "name" })),
      row({ gap: 12 }, col({ grow: 1 }, formField("Username", input("alex.rivera@northwind.example", { ref: "username" })))),
      formField("Password", passwordInput(PASSWORD)),
      row(
        { gap: 12 },
        col({ grow: 1 }, formField("Website", input("https://northwind.example", { ref: "website" }))),
        col({ w: 170 }, formField("One-time code key", input("Set", { ref: "totp", title: "One-time code key", trail: [iconButton(d, "qrCode", { name: "scan", label: "Read from a QR code" })] }))),
      ),
    ],
    formFoot("Save", { remove: true }),
  );
}

// ---- adding -----------------------------------------------------------------

const KINDS = [
  { label: "Login", line: "A website or app account", glyph: "globe", ref: "kind-login" },
  { label: "Card", line: "A payment card", glyph: "creditCard", ref: "kind-card" },
  { label: "Document", line: "A file, kept encrypted", glyph: "fileText", ref: "kind-document" },
  { label: "Note", line: "Private text", glyph: "stickyNote", ref: "kind-note" },
  { label: "Key", line: "An SSH or API key", glyph: "key", ref: "kind-key" },
  { label: "Environment", line: "Values a project loads in the terminal", glyph: "squareTerminal", ref: "kind-env" },
  { label: "Custom", line: "Fields you name yourself", glyph: "listPlus", ref: "kind-custom", head: "New custom entry" },
];

const textArea = (value, { h = 96, mono = false, ref, placeholder } = {}) =>
  col(
    { h, pad: [10, 12], radius: d.r.control, fill: "surface-2", stroke: "field-line", name: ref, label: ref },
    value ? (mono ? t.mono(value, { size: 13 }) : t.ui(value, { size: 14, color: "title" })) : t.ui(placeholder, { size: 14, color: "dim" }),
  );

/** The fields of a new entry of each kind. */
const NEW_FORMS = {
  // With the generator open, the password field holds the focus and the made password.
  login: ({ generating = false } = {}) => [
    formField("Name", input(null, { placeholder: "Northside Gym", focus: !generating, ref: "name" })),
    formField("Username", input(null, { placeholder: "Email or user name", ref: "username" })),
    formField("Password", generating ? passwordInput("k7#Rq-vW2p!eLz9@Tm4s", { focus: true, generatorOpen: true }) : passwordInput(null)),
    formField("Website", input(null, { placeholder: "https://", ref: "website" })),
  ],
  card: () => [
    formField("Name", input(null, { placeholder: "Atlas Card", focus: true, ref: "name" })),
    formField("Cardholder", input(null, { placeholder: "Name on the card", ref: "holder" })),
    formField("Number", input(null, { placeholder: "1234 5678 9012 3456", mono: true, ref: "number" })),
    row({ gap: 12 }, col({ grow: 1 }, formField("Expires", input(null, { placeholder: "MM/YY", ref: "expires" }))), col({ grow: 1 }, formField("Security code", input(null, { placeholder: "CVC", ref: "cvc" })))),
  ],
  document: () => [
    formField("Name", input(null, { placeholder: "Lease contract", focus: true, ref: "name" })),
    formField(
      "File",
      col(
        { h: 120, gap: 8, align: "center", justify: "center", radius: d.r.group, stroke: "field-line", dash: "4 4", name: "file", label: "Choose a file" },
        icon("upload", { size: 20, color: "soft" }),
        t.ui("Drop a file here or choose one", { color: "text" }),
        t.ui("Kept encrypted inside Vault", { size: 12, color: "soft" }),
      ),
    ),
    formField("Note", textArea(null, { h: 72, placeholder: "Optional", ref: "note" })),
  ],
  note: () => [formField("Name", input(null, { placeholder: "Home Wi-Fi", focus: true, ref: "name" })), formField("Text", textArea(null, { h: 220, placeholder: "Only you can read this", ref: "text" }))],
  key: () => [
    formField("Name", input(null, { placeholder: "Build server", focus: true, ref: "name" })),
    formField("Key", textArea(null, { h: 150, placeholder: "Paste the private key", ref: "key" })),
    formField("Passphrase", input(null, { placeholder: "Optional", mono: true, ref: "passphrase" })),
  ],
  env: () => [
    formField("Project", input(null, { placeholder: "sprout", focus: true, ref: "project" }), { hint: "The name the terminal asks for: vault env sprout." }),
    label("Values"),
    ...[["DATABASE_URL", DOTS], ["API_TOKEN", DOTS]].map(([key, value]) =>
      row({ gap: 8, name: `value-${slug(key)}`, label: key }, input(key, { mono: true, w: 200 }), input(value, { mono: true, grow: 1 }), iconButton(d, "x", { label: "Remove value" })),
    ),
    row({ self: "start" }, smallButton("plus", "Add value", "add-value")),
  ],
  custom: () => [
    formField("Name", input(null, { placeholder: "Gate code", focus: true, ref: "name" })),
    label("Fields"),
    row({ gap: 8, name: "custom-field", label: "Field" }, input(null, { placeholder: "Field name", w: 200 }), input(null, { placeholder: "Value", grow: 1 }), iconButton(d, "eyeOff", { label: "Hidden" })),
    row({ self: "start" }, smallButton("plus", "Add field", "add-field")),
  ],
};

const newEntry = (kind, { generating } = {}) => {
  const { label: name, glyph, head } = KINDS.find((k) => k.ref === `kind-${kind}`);
  return main({ selected: -1, right: formPane(kindHead(head ?? `New ${name.toLowerCase()}`, name, glyph), NEW_FORMS[kind]({ generating }), formFoot("Save")) }, generating ? [generator()] : []);
};

/** The generator, open under the password field. */
function generator() {
  const option = (on, value) => checkbox(on, value, `gen-${slug(value)}`);
  return col(
    { w: 340, pad: 16, gap: 14, radius: d.r.group, fill: "surface-2", stroke: "line-strong", place: { x: 300 + 24 + 576 - 340, y: 36 + 24 + 48 + 20 + 3 * 66 + 46 }, name: "generator", label: "Password generator" },
    row({ gap: 8 }, strong("Generate a password"), fill(), iconButton(d, "refreshCw", { name: "regenerate", label: "Make another" })),
    row({ pad: [10, 12], radius: d.r.control, fill: "surface" }, t.mono("k7#Rq-vW2p!eLz9@Tm4s", { color: "title" })),
    col(
      { gap: 8 },
      row({}, label("Length"), fill(), t.ui("20", { weight: 600, color: "title" })),
      stack(
        { h: 20, name: "length", label: "Length: 20" },
        box({ h: 4, radius: "pill", fill: "surface-3", place: { x: 0, y: 8 }, w: 308 }),
        box({ h: 4, radius: "pill", fill: "primary", place: { x: 0, y: 8 }, w: 120 }),
        box({ w: 20, h: 20, radius: "pill", fill: "primary", place: { x: 110, y: 0 } }),
      ),
    ),
    row({ gap: 18 }, option(true, "Symbols"), option(true, "Numbers"), option(true, "Uppercase")),
    row({}, fill(), button("Use this password", { primary: true, ref: "use" })),
  );
}

// ---- first run --------------------------------------------------------------

function welcome() {
  return appWindow(
    { locked: true },
    centred(
      460,
      col({ gap: 16 }, appIcon(d, 56), col({ gap: 6 }, heading("Welcome to Vault", { size: 24 }), t.body("Vault keeps your passwords encrypted on this computer and shares them only with the Cosmic apps you allow.", { color: "text" }))),
      col({ gap: 10 }, choice(true, "Create a new vault", "Start empty and import later from a browser or another manager.", "create"), choice(false, "Restore a backup", "Open an encrypted Vault backup with its password.", "restore")),
      row({}, fill(), button("Continue", { primary: true, ref: "continue" })),
    ),
  );
}

function createVault({ mismatch = false } = {}) {
  return appWindow(
    { locked: true },
    centred(
      400,
      col({ gap: 6 }, heading("Choose a master password", { size: 22 }), t.body("It unlocks Vault in every app. A long phrase you can remember works best.", { color: "text" })),
      formField("Master password", input("•".repeat(22), { mono: true, ref: "password", trail: [reveal(false)] }), { hint: "15 to 128 characters." }),
      formField("Repeat it", input("•".repeat(mismatch ? 19 : 22), { mono: true, focus: !mismatch, error: mismatch, ref: "repeat" }), mismatch ? { error: "The two passwords are not the same." } : {}),
      notice("info", "Nobody can recover this password for you. The recovery key on the next step can."),
      row({}, button("Back"), fill(), button("Create vault", { primary: true, ref: "create-vault" })),
    ),
  );
}

function recoveryKey() {
  return appWindow(
    { locked: true },
    centred(
      460,
      col({ gap: 6 }, heading("Your recovery key", { size: 22 }), t.body("It opens Vault if you forget the master password. It is shown only now, so save or print the recovery sheet.", { color: "text" })),
      col(
        { pad: [18, 20], gap: 8, radius: d.r.group, fill: "surface-2", stroke: "line-strong", name: "key", label: "Recovery key" },
        t.mono("R7KD-93PX-QM4T-8VZN", { size: 18, color: "title" }),
        t.mono("H2CE-6WLB-T9FA-5JRS", { size: 18, color: "title" }),
      ),
      row({ gap: 10 }, button("Save recovery sheet", { glyph: "download", ref: "save-sheet" }), button("Print", { glyph: "fileText", ref: "print" })),
      checkbox(true, "I saved or printed the recovery sheet", "saved"),
      row({}, fill(), button("Open Vault", { primary: true, ref: "open" })),
    ),
  );
}

/** The recovery sheet as saved or printed: an A4 page in print colours, not the app's theme. */
function recoverySheet() {
  const ink = "#1d1f22", soft = "#4f545b", paper = "#efece5", rule = "#c9c4b8";
  const line = (value, props = {}) => t.body(value, { size: 13, color: soft, ...props });
  return col(
    { w: 595, h: 842, pad: [64, 64], gap: 28, fill: paper, name: "sheet", label: "Recovery sheet" },
    row({ gap: 14 }, mark(d, 36, { ink }), t.display("Vault recovery sheet", { size: 22, weight: 600, color: ink })),
    line("Made on 7 October 2026 on the computer named STUDIO-PC."),
    col(
      { pad: [22, 24], gap: 10, radius: 8, stroke: ink, name: "sheet-key", label: "Recovery key" },
      t.ui("Recovery key", { size: 12, weight: 600, color: soft }),
      t.mono("R7KD-93PX-QM4T-8VZN", { size: 22, color: ink }),
      t.mono("H2CE-6WLB-T9FA-5JRS", { size: 22, color: ink }),
    ),
    col(
      { gap: 10 },
      t.ui("How to use it", { size: 14, weight: 600, color: ink }),
      line("On Vault's locked screen, choose Use recovery key, type this key and choose a new master password. A new recovery key and sheet replace this one."),
    ),
    col(
      { gap: 10 },
      t.ui("Keep it safe", { size: 14, weight: 600, color: ink }),
      line("Keep this sheet offline, somewhere only you can reach. Anyone with this key and a copy of your vault can open it."),
    ),
    fill(),
    box({ h: 1, fill: rule }),
    line("Vault does not keep a copy of this key and cannot send it again.", { size: 12 }),
  );
}

function restoreBackup() {
  return appWindow(
    { locked: true },
    centred(
      420,
      col({ gap: 6 }, heading("Restore a backup", { size: 22 }), t.body("Choose a Vault backup and type the password it was made with.", { color: "text" })),
      formField("Backup", row({ gap: 8 }, input("vault-backup-2026-09-30.vault", { grow: 1, glyph: "fileArchive", ref: "file" }), button("Choose", { ref: "choose" }))),
      formField("Backup password", input("•".repeat(18), { mono: true, focus: true, ref: "backup-password", trail: [reveal(false)] })),
      notice("info", "The restored vault keeps that backup's master password and gets a new recovery key."),
      row({}, button("Back"), fill(), button("Restore", { primary: true, ref: "restore" })),
    ),
  );
}

/** The empty list, the first time Vault opens. */
function emptyState() {
  return detail(
    col(
      { grow: 1, gap: 14, align: "center", justify: "center", name: "empty", label: "Empty vault" },
      mark(d, 40, { ink: "soft" }),
      heading("Your vault is empty", { size: 18 }),
      t.ui("Add your first entry, or bring passwords from a browser or another manager.", { size: 14, color: "soft", align: "center", w: 340 }),
      row({ gap: 10 }, button("Import", { glyph: "download", ref: "import" }), button("Add an entry", { primary: true, glyph: "plus", ref: "add-entry" })),
    ),
  );
}

const emptyList = (overlays) => main({ entries: [], selected: -1, right: emptyState(), empty: col({}) }, overlays);

/** The first-open tips: a card over the empty list, so the empty state's buttons stay usable beside it. */
function tour(page, items, last) {
  return col(
    { w: 272, pad: 20, gap: 14, radius: d.r.group, fill: "surface-2", stroke: "line-strong", place: "bottom-left", dx: 14, dy: -20, name: "tour", label: "First-open tips" },
    row({}, strong(page === 1 ? "Welcome to Vault" : "A few more things"), fill(), t.ui(`${page} of 2`, { size: 12, color: "soft" })),
    ...items.map(([title, line]) => col({ gap: 2, name: `tip-${slug(title)}`, label: title }, t.ui(title, { size: 14, weight: 600, color: "title" }), t.ui(line, { color: "soft" }))),
    row({ gap: 10 }, fill(), last ? null : button("Got it", { ref: "got-it" }), button(last ? "Done" : "More", { primary: true, ref: last ? "done" : "more" })),
  );
}

const TIPS_1 = [
  ["Add or import", "Add an entry with +, or bring passwords from a browser through Import."],
  ["Copy, then it clears", "Copied values leave the clipboard after 30 seconds."],
  ["One unlock for every app", "Horizon, Nova and Nebula use this vault while it is unlocked."],
];

const TIPS_2 = [
  ["Lock", "Lock in the title bar closes Vault for every app. It also locks itself when idle."],
  ["Apps", "Each app sees only its own kind of entry, and you choose which apps get in."],
  ["Recovery key", "It is the only way back in without the master password. Keep it safe."],
];

// ---- unlock -----------------------------------------------------------------

function locked({ error = false, theme } = {}) {
  return appWindow(
    { locked: true, theme },
    centred(
      360,
      col({ gap: 16, align: "center" }, appIcon(d, 56), col({ gap: 6, align: "center" }, heading("Vault is locked", { size: 22 }), t.ui("Unlocking here unlocks Vault for every Cosmic app on this computer until it locks again.", { size: 14, color: "soft", align: "center", w: 340 }))),
      // The placeholder names the field, so no label repeats it above.
      col(
        { gap: 6 },
        input(error ? "•".repeat(12) : null, { placeholder: "Master password", mono: true, focus: !error, error, ref: "password", trail: [reveal(false)] }),
        error ? notice("circleAlert", "That password is not right. Try again or use the recovery key.", { tone: "error" }) : null,
      ),
      button("Unlock", { primary: true, ref: "unlock" }),
      row({ gap: 12 }, button("Windows Hello", { glyph: "fingerprint", ref: "hello" }), fill(), link("Use recovery key", "recovery")),
    ),
  );
}

function helloWaiting() {
  return appWindow(
    { locked: true },
    centred(
      360,
      col(
        { gap: 16, align: "center" },
        stack({ w: 72, h: 72, radius: "pill", stroke: "primary", strokeWidth: 2 }, icon("fingerprint", { size: 32, color: "primary", place: "center" })),
        col({ gap: 6, align: "center" }, heading("Waiting for Windows Hello", { size: 20 }), t.ui("Confirm it is you in the Windows Security window.", { size: 14, color: "soft", align: "center" })),
        button("Cancel", { ref: "cancel" }),
      ),
    ),
  );
}

function recoveryUnlock() {
  return appWindow(
    { locked: true },
    centred(
      420,
      col({ gap: 6 }, heading("Use the recovery key", { size: 22 }), t.body("Type the key from your recovery sheet. Then choose a new master password.", { color: "text" })),
      formField("Recovery key", input("R7KD-93PX-QM4T-8VZN-H2CE-6WLB-T9FA-5JRS", { mono: true, focus: true, ref: "recovery-key" })),
      formField("New master password", input("•".repeat(20), { mono: true, ref: "new-password", trail: [reveal(false)] }), { hint: "15 to 128 characters." }),
      formField("Repeat it", input("•".repeat(20), { mono: true, ref: "repeat" })),
      notice("info", "Windows Hello turns off and a new recovery key replaces this one."),
      row({}, button("Back"), fill(), button("Unlock", { primary: true, ref: "unlock" })),
    ),
  );
}

// ---- import -----------------------------------------------------------------

const SOURCES = [
  ["Chrome", "CSV from Google Password Manager"],
  ["Edge", "CSV from Edge's passwords"],
  ["Firefox", "CSV from Firefox's logins"],
  ["Bitwarden", "CSV, or JSON that is not encrypted"],
  ["1Password", "CSV export"],
  ["KeePass", "CSV, or KeePass 2 XML"],
];

const sourceTile = ([name, line], on) =>
  row(
    { grow: 1, pad: [12, 14], gap: 12, radius: d.r.group, stroke: on ? "primary" : "line", strokeWidth: on ? 2 : 1, fill: on ? "selected" : undefined, name: `source-${slug(name)}`, label: name },
    stack({ w: 18, h: 18, radius: "pill", stroke: on ? "primary" : "field-line", strokeWidth: 2 }, on ? box({ w: 8, h: 8, radius: "pill", fill: "primary", place: "center" }) : null),
    col({ gap: 2, grow: 1 }, strong(name), t.ui(line, { size: 12, color: "soft" })),
  );

function importSource({ chosen } = {}) {
  return appWindow(
    {},
    view(
      {},
      sectionHead("Import"),
      page(
        t.body("Choose where the passwords come from, then the file you exported from it.", { color: "text" }),
        col({ gap: 10 }, ...[0, 3].map((i) => row({ gap: 10 }, ...SOURCES.slice(i, i + 3).map((source, j) => sourceTile(source, i + j === 0))))),
        chosen
          ? row(
              { gap: 10, pad: [10, 14], radius: d.r.control, fill: "surface-2", name: "chosen-file", label: "Chosen file" },
              icon("fileText", { size: 16, color: "soft" }),
              t.ui("Chrome Passwords.csv", { size: 14, color: "title" }),
              t.ui("84 KB, 218 rows", { color: "soft" }),
              fill(),
              link("Change", "change-file"),
            )
          : null,
        fill(),
        row({}, notice("lock", "The file is read on this computer only."), fill(), chosen ? button("Import 218 passwords", { primary: true, ref: "import" }) : button("Choose file", { primary: true, glyph: "folderOpen", ref: "choose-file" })),
      ),
    ),
  );
}

function importReport() {
  const line = (count, why) => row({ gap: 12 }, t.ui(String(count), { size: 14, weight: 600, color: "title", w: 28 }), t.ui(why, { size: 14, color: "text" }));
  return appWindow(
    {},
    view(
      {},
      sectionHead("Import"),
      page(
        col({ gap: 6 }, heading("212 passwords imported"), t.body("6 rows were skipped.", { color: "text" })),
        col({ pad: 16, gap: 10, radius: d.r.group, stroke: "line", name: "skipped", label: "Skipped rows" }, label("Skipped and why"), line(4, "Already in Vault, with the same website and username"), line(2, "Not a valid web address")),
        row(
          { pad: 16, gap: 12, align: "start", radius: d.r.group, fill: "error-wash", name: "delete-reminder", label: "Delete the exported file" },
          icon("triangleAlert", { size: 18, color: "error" }),
          col({ gap: 4, grow: 1 }, strong("Delete Chrome Passwords.csv now"), t.ui("It holds every password in plain text. Vault did not move or delete it.", { color: "text" })),
          button("Show in folder", { ref: "show-file" }),
        ),
        fill(),
        row({}, fill(), button("Done", { primary: true, ref: "done" })),
      ),
    ),
  );
}

// ---- export -----------------------------------------------------------------

function exportView({ plain = false } = {}) {
  return appWindow(
    {},
    view(
      {},
      sectionHead("Export"),
      page(
        col(
          { gap: 10 },
          choice(!plain, "Encrypted backup", "Restores into Vault with a backup password you choose. Safe to keep in a cloud folder.", "encrypted"),
          choice(plain, "Plain CSV file", "Readable by any program and by anyone who opens it. For moving to another manager.", "plain"),
        ),
        plain
          ? col(
              { gap: 14 },
              row(
                { pad: 14, gap: 12, align: "start", radius: d.r.group, fill: "error-wash", name: "plain-warning", label: "Warning" },
                icon("triangleAlert", { size: 18, color: "error" }),
                t.ui("Every password will be written as plain text. Delete the file as soon as it is imported elsewhere.", { size: 14, color: "title" }),
              ),
              formField("Master password", input("•".repeat(16), { mono: true, focus: true, ref: "master", trail: [reveal(false)] }), { hint: "Asked again for a plain export." }),
            )
          : row({ gap: 12, align: "start" }, col({ grow: 1 }, formField("Backup password", input("•".repeat(18), { mono: true, ref: "backup-password", trail: [reveal(false)] }), { hint: "15 to 128 characters." })), col({ grow: 1 }, formField("Repeat it", input(null, { placeholder: "Repeat the backup password", mono: true, focus: true, ref: "repeat" })))),
        fill(),
        row({}, fill(), plain ? button("Export plain file", { danger: true, glyph: "download", ref: "export-plain" }) : button("Save backup", { primary: true, glyph: "download", ref: "save-backup" })),
      ),
    ),
  );
}

// ---- apps -------------------------------------------------------------------

const APPS = [
  ["Horizon", "Website logins", "globe"],
  ["Nova", "Project environment values", "squareTerminal"],
  ["Nebula", "Every kind of entry", "orbit"],
  ["Vault command line", "Every kind of entry", "terminal"],
];

const appRow = ([name, sees, glyph], ...actions) =>
  row(
    { pad: [12, 0], gap: 14, edge: { side: "bottom", color: "line" }, name: `app-${slug(name)}`, label: name },
    stack({ w: 36, h: 36, radius: d.r.control, fill: "surface-3" }, icon(glyph, { size: 18, color: "text", place: "center" })),
    col({ gap: 2, grow: 1 }, strong(name), t.ui(`Sees: ${sees}`, { color: "soft" })),
    ...actions,
  );

function appsView() {
  return view(
    {},
    sectionHead("Apps"),
    page(
      t.body("Each app sees only its own kind of entry. Agents and Lyra never receive values.", { color: "text" }),
      col({ gap: 0 }, label("Waiting for you"), appRow(["Field Notes", "Website logins", "notebookPen"], button("Deny", { ref: "deny" }), button("Allow", { primary: true, ref: "allow" }))),
      col({ gap: 0 }, label("Allowed"), ...APPS.map((app) => appRow(app, button("Revoke", { ref: `revoke-${slug(app[0])}` })))),
    ),
  );
}

// ---- settings ---------------------------------------------------------------

function settingsView({ open } = {}) {
  return view(
    {},
    sectionHead("Settings"),
    page(
      col(
        { gap: 0 },
        setting("Lock after idle", "Vault locks itself when no app has used it for this long.", select("15 minutes", { w: 180, ref: "idle", title: "Lock after idle: 15 minutes", open: open === "idle" })),
        setting("Lock when the last app closes", "Closing the last Cosmic app that uses Vault locks it.", toggle(true, { ref: "last-app", title: "Lock when the last app closes" })),
        setting("Windows Hello", "Unlock with your face, fingerprint or PIN instead of the master password.", toggle(true, { ref: "hello", title: "Windows Hello" })),
        setting("Language", "The language of Vault's own window.", select("English", { w: 180, ref: "language", open: open === "language" })),
        setting("Theme", "Follow Windows, or always dark or light.", select("System", { w: 180, ref: "theme", open: open === "theme" })),
        setting("Sync", "Encrypted sync through a cloud folder you choose.", t.ui("Coming later", { color: "soft", name: "sync", label: "Coming later" })),
      ),
    ),
  );
}

// The open lists of the three selects, under each one (the select sits at the right of its row).
const SELECT_X = SIZE.w - 24 - 180;
const settingsMenu = (open, items, y) => menu(items, { w: 180, at: { x: SELECT_X, y }, name: `${open}-list`, title: open });

const IDLE = ["1 minute", "5 minutes", "15 minutes", "30 minutes", "1 hour", "4 hours"].map((value) => ({ label: value, on: value === "15 minutes" }));
const LANGUAGES = [{ label: "English", on: true }, { label: "Español" }];
const THEMES = [{ label: "System", on: true }, { label: "Dark" }, { label: "Light" }];

// ---- the menu ---------------------------------------------------------------

const MAIN_MENU = [
  { label: "Apps", line: "Choose which apps can use Vault", glyph: "layoutGrid", ref: "go-apps" },
  { label: "Import", line: "From a browser or another manager", glyph: "download", ref: "go-import" },
  { label: "Export", line: "Save an encrypted backup or a plain file", glyph: "upload", ref: "go-export" },
  { label: "Settings", line: "Locking, Windows Hello, language, theme", glyph: "settings2", ref: "go-settings" },
  "rule",
  { label: "Show the tips again", line: "The first-open tour", glyph: "lightbulb", ref: "go-tour" },
];

const FILTERS = [
  { label: "All entries", hint: "128", glyph: "layers", on: true },
  { label: "Favourites", hint: "12", glyph: "star" },
  "rule",
  { label: "Logins", hint: "96", glyph: "globe" },
  { label: "Cards", hint: "4", glyph: "creditCard" },
  { label: "Documents", hint: "3", glyph: "fileText" },
  { label: "Notes", hint: "9", glyph: "stickyNote" },
  { label: "Keys", hint: "2", glyph: "key" },
  { label: "Environment", hint: "3", glyph: "squareTerminal" },
  { label: "Custom", hint: "1", glyph: "listPlus" },
];

// ---- the board --------------------------------------------------------------

const LIST_TOP = 36 + 24; // the top of the search field in the window
const screen = (id, title, col, row, root, note) => ({ id, title, col, row, w: SIZE.w, h: SIZE.h, root, note });

const screens = [
  // First run
  screen("welcome", "Welcome", 0, 0, welcome, "The first open on a computer with no vault: create one, or restore an encrypted backup. An existing shared vault, made by Nebula or another app, opens on the locked screen instead."),
  screen("create", "Master password", 1, 0, () => createVault(), "Two fields, 15 to 128 characters, as the service checks."),
  screen("create-mismatch", "Master password, not the same", 2, 0, () => createVault({ mismatch: true }), "The error sits under the field it is about."),
  screen("recovery-key", "Recovery key", 3, 0, recoveryKey, "Shown once. Save recovery sheet opens the system save dialog and Print the print dialog, both with the sheet beside this screen. Open Vault stays available without the checkbox; the checkbox only reminds."),
  screen("restore", "Restore a backup", 4, 0, restoreBackup, "Choose opens the system file picker."),
  { id: "recovery-sheet", title: "Recovery sheet", col: 7, row: 0, w: 595, h: 842, root: recoverySheet, note: "The page Save recovery sheet writes as a PDF and Print prints, in print colours." },
  screen("tour", "First open, tips", 5, 0, () => emptyList([tour(1, TIPS_1, false)]), "Three key things in a card over the empty list; the rest of the window works around it. More continues, Got it closes."),
  screen("tour-more", "First open, more tips", 6, 0, () => emptyList([tour(2, TIPS_2, true)]), "The rest of the tips, behind More."),
  // Unlock
  screen("locked", "Locked", 0, 1, () => locked(), "What unlocking means is said once, here. The master password works everywhere, Linux included; Windows Hello shows only on Windows."),
  screen("locked-error", "Wrong password", 1, 1, () => locked({ error: true })),
  screen("hello", "Windows Hello", 2, 1, helloWaiting, "Windows draws its own Security window over this one."),
  screen("recovery-unlock", "Recovery key unlock", 3, 1, recoveryUnlock, "After this, the new recovery key screen of the first run follows."),
  // The list
  screen("empty", "Empty", 0, 2, () => emptyList(), "The first open without tips, and after deleting the last entry."),
  screen("list", "List", 1, 2, () => main(), "The main screen. Entries sorted by recent use; the open one is marked. Lock locks for every app."),
  screen("search", "Search", 2, 2, () => main({ entries: SEARCHED, search: "north", focus: true, count: 2, filter: "Results" }), "Results as you type, over names, usernames and websites."),
  screen("filter-open", "Kind filter, open", 3, 2, () => main({ filterOpen: true }, [menu(FILTERS, { w: 240, at: { x: 24, y: LIST_TOP + 36 + 16 + 30 }, name: "filters", title: "Show" })]), "Favourites first, then one line per kind with its count."),
  screen("menu-open", "Menu, open", 4, 2, () => main({ menuOpen: true }, [menu(MAIN_MENU, { w: 320, at: { x: SIZE.w - 132 - 8 - 320, y: 36 + 4 }, name: "main-menu", title: "Menu" })]), "Every option says what it does."),
  // An entry
  screen("revealed", "Password shown and copied", 0, 3, () => main({ right: entryView({ revealed: true }) }, [toast("Password copied. It clears in 30 seconds.")]), "Reveal shows the value until the entry closes. Copy shows this toast; the clipboard clears after 30 seconds."),
  screen("edit", "Edit", 1, 3, () => main({ right: editPane() }), "Delete entry removes it at once, with an undo."),
  screen("deleted", "Deleted, with undo", 2, 3, () => main({ entries: AFTER_DELETE, selected: -1, right: detail(col({ grow: 1, align: "center", justify: "center" }, t.ui("Choose an entry to see it.", { size: 14, color: "soft" }))) }, [toast("Northwind Mail deleted.", { action: "Undo", glyph: "trash2" })]), "Undo puts it back for as long as the toast is shown."),
  // Adding
  screen("add-open", "Add, kinds", 0, 4, () => main({ addOpen: true }, [menu(KINDS, { w: 300, at: { x: 300 - 14 - 36, y: LIST_TOP + CONTROL_H + 6 }, name: "kinds", title: "Add" })]), "Every kind says what it is for."),
  screen("add-login", "New login", 1, 4, () => newEntry("login"), "The generator opens from the wand in the password field."),
  screen("generator", "Password generator", 2, 4, () => newEntry("login", { generating: true }), "Length, symbols, numbers and uppercase. Use this password fills the field."),
  screen("add-card", "New card", 3, 4, () => newEntry("card")),
  screen("add-document", "New document", 4, 4, () => newEntry("document")),
  screen("add-note", "New note", 5, 4, () => newEntry("note")),
  screen("add-key", "New key", 6, 4, () => newEntry("key")),
  screen("add-env", "New environment", 7, 4, () => newEntry("env"), "Nova reads these; the terminal loads them with vault env."),
  screen("add-custom", "New custom entry", 8, 4, () => newEntry("custom")),
  // Import
  screen("import", "Import, source", 0, 5, () => importSource(), "Choose file opens the system file picker."),
  screen("import-file", "Import, file chosen", 1, 5, () => importSource({ chosen: true })),
  screen("import-report", "Import, report", 2, 5, importReport, "Skipped rows with the reason, and the reminder to delete the plain export."),
  // Export
  screen("export", "Export, encrypted", 0, 6, () => exportView(), "Save backup opens the system save dialog."),
  screen("export-plain", "Export, plain", 1, 6, () => exportView({ plain: true }), "Behind a clear warning and the master password."),
  // Apps
  screen("apps", "Apps", 0, 7, () => appWindow({}, appsView())),
  screen("revoke", "Revoke, confirm", 1, 7, () => appWindow({}, appsView(), [dialog({ title: "Revoke Nova?" }, [t.body("Nova stops reading environment values until you allow it again. Nothing is deleted.", { color: "text" })], [button("Cancel"), button("Revoke", { danger: true, ref: "confirm-revoke" })])])),
  // Settings
  screen("settings", "Settings", 0, 8, () => appWindow({}, settingsView())),
  screen("idle-open", "Lock after idle, open", 1, 8, () => appWindow({}, settingsView({ open: "idle" }), [settingsMenu("idle", IDLE, 36 + 56 + 24 + 54)])),
  screen("language-open", "Language, open", 2, 8, () => appWindow({}, settingsView({ open: "language" }), [settingsMenu("language", LANGUAGES, 36 + 56 + 24 + 3 * 76 + 54)])),
  screen("theme-open", "Theme, open", 3, 8, () => appWindow({}, settingsView({ open: "theme" }), [settingsMenu("theme", THEMES, 36 + 56 + 24 + 4 * 76 + 54)])),
  // Light
  screen("light-locked", "Light: locked", 0, 9, () => locked({ theme: DIAL_LIGHT }), "The light theme, designed on its own: a dim cool grey with no surface near white, the brass deepened for contrast."),
  screen("light-list", "Light: list", 1, 9, () => main({ theme: DIAL_LIGHT })),
  screen("light-settings", "Light: settings", 2, 9, () => appWindow({ theme: DIAL_LIGHT }, settingsView())),
];

const links = [
  { from: "welcome", to: "create", at: "continue", label: "Continue" },
  { from: "welcome", to: "restore", at: "restore", label: "Restore a backup" },
  { from: "create", to: "recovery-key", at: "create-vault", label: "Create vault" },
  { from: "create", to: "create-mismatch", label: "Not the same" },
  { from: "recovery-key", to: "tour", at: "open", label: "Open Vault" },
  { from: "recovery-key", to: "recovery-sheet", at: "save-sheet", label: "Save recovery sheet" },
  { from: "tour", to: "tour-more", at: "more", label: "More" },
  { from: "tour", to: "empty", at: "got-it", label: "Got it" },
  { from: "tour-more", to: "empty", at: "done", label: "Done" },
  { from: "locked", to: "list", at: "unlock", label: "Unlock" },
  { from: "locked", to: "locked-error", label: "Wrong password" },
  { from: "locked", to: "hello", at: "hello", label: "Windows Hello" },
  { from: "locked", to: "recovery-unlock", at: "recovery", label: "Use recovery key" },
  { from: "recovery-unlock", to: "recovery-key", at: "unlock", label: "New recovery key" },
  { from: "empty", to: "import", at: "import", label: "Import" },
  { from: "empty", to: "add-open", at: "add-entry", label: "Add an entry" },
  { from: "list", to: "search", at: "search", label: "Search" },
  { from: "list", to: "filter-open", at: "filter", label: "Show" },
  { from: "list", to: "menu-open", at: "menu-button", label: "Menu" },
  { from: "list", to: "add-open", at: "add", label: "Add" },
  { from: "list", to: "revealed", at: "password-eye", label: "Reveal" },
  { from: "list", to: "edit", at: "edit", label: "Edit" },
  { from: "list", to: "locked", at: "lock", label: "Lock" },
  { from: "edit", to: "deleted", at: "delete", label: "Delete entry" },
  { from: "menu-open", to: "apps", at: "go-apps", label: "Apps" },
  { from: "menu-open", to: "import", at: "go-import", label: "Import" },
  { from: "menu-open", to: "export", at: "go-export", label: "Export" },
  { from: "menu-open", to: "settings", at: "go-settings", label: "Settings" },
  { from: "menu-open", to: "tour", at: "go-tour", label: "Tips" },
  { from: "add-open", to: "add-login", at: "kind-login", label: "Login" },
  { from: "add-open", to: "add-card", at: "kind-card", label: "Card" },
  { from: "add-open", to: "add-document", at: "kind-document", label: "Document" },
  { from: "add-open", to: "add-note", at: "kind-note", label: "Note" },
  { from: "add-open", to: "add-key", at: "kind-key", label: "Key" },
  { from: "add-open", to: "add-env", at: "kind-env", label: "Environment" },
  { from: "add-open", to: "add-custom", at: "kind-custom", label: "Custom" },
  { from: "add-login", to: "generator", at: "generate", label: "Generate" },
  { from: "import", to: "import-file", at: "choose-file", label: "Choose file" },
  { from: "import-file", to: "import-report", at: "import", label: "Import" },
  { from: "export", to: "export-plain", at: "plain", label: "Plain CSV file" },
  { from: "apps", to: "revoke", at: "revoke-nova", label: "Revoke" },
  { from: "settings", to: "idle-open", at: "idle", label: "Lock after idle" },
  { from: "settings", to: "language-open", at: "language", label: "Language" },
  { from: "settings", to: "theme-open", at: "theme", label: "Theme" },
];

export default board({
  id: "app",
  title: "Vault app",
  note: "Vault's own small app, for people without Nebula: view, add, import and export passwords, and choose which apps get in. Drawn in Dial with the keyhole. Each row is one part of the flow: first run, unlock, the list, an entry, adding, import, export, apps, settings, and the light theme at the bottom. Copy ships in English and Spanish; the boards are in English. Click a screen for its note; everything shown is invented.",
  screens,
  links,
});
