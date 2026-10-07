// Identity for Vault: three directions to choose from, one screen each (Dial,
// Seal, Key). Every screen shows the same app icon and name, the same app
// window on its list with one login open and the same unlock card, so only the
// identity changes: the mark, the colours, the faces and the corners. The
// themes are in ../kit/skins.mjs, the samples in ../kit/vault.mjs. The entries,
// the sites and the person in them are invented.

import { board } from "blueprint/board.mjs";
import { CHOSEN, DIRECTIONS, directionScreen } from "../kit/vault.mjs";

export default board({
  id: "identity",
  title: "Vault's identity",
  note: "Three identity directions for Vault to pick from. Each screen shows the app icon and name, the app window on its list with one login open, and the unlock card, the same in all three, so only the mark, the colours, the type and the corners change. Click a screen for its note. The entries and the person in them are invented.",
  screens: [
    // Kept apart from the three directions by an empty row, as every round of changes is shown.
    { id: CHOSEN.id, title: "New: Dial with the keyhole", col: 0, row: -2, root: () => directionScreen(CHOSEN), note: CHOSEN.note },
    ...Object.values(DIRECTIONS).map((d, i) => ({ id: d.id, title: d.name, col: i, row: 0, root: () => directionScreen(d), note: d.note })),
  ],
  // Present has no element to click here, so each direction leads to the next from the player's bar.
  links: Object.values(DIRECTIONS).map((d, i, all) => ({ from: d.id, to: all[(i + 1) % all.length].id, label: all[(i + 1) % all.length].name })),
});
