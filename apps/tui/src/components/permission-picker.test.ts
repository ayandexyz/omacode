// The permission prompt is the safety boundary between the model and the
// user's machine: a wrong key mapping is an unintended allow. These pin which
// key produces which decision, and that dismissing the prompt never allows.

import { test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import type { SelectListTheme } from "@earendil-works/pi-tui";
import { createPermissionPicker, type PermissionRequestView } from "./permission-picker.js";

const ESC = "\x1b";
const KEY_DOWN = `${ESC}[B`;
const KEY_UP = `${ESC}[A`;
const KEY_ENTER = "\r";

const id = (t: string) => t;
const theme: SelectListTheme = { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id };

const request: PermissionRequestView = {
  toolName: "Bash",
  description: "rm -rf build",
  suggestedRule: "Bash(rm:*)",
  reason: "Deletes files",
};

function picker(req = request) {
  const events: string[] = [];
  const p = createPermissionPicker(
    req,
    { onSelect: (d) => events.push(`select:${d}`), onCancel: () => events.push("cancel") },
    theme,
  );
  return { p, events };
}

const settle = () => new Promise((r) => setImmediate(r));

test("the five decisions, in order, and Enter picks the highlighted one", async () => {
  const expected = ["allow-once", "allow-session", "allow-project", "allow-always", "deny"];
  for (let i = 0; i < expected.length; i++) {
    const { p, events } = picker();
    for (let k = 0; k < i; k++) p.handleInput(KEY_DOWN);
    p.handleInput(KEY_ENTER);
    await settle();
    assert.deepEqual(events, [`select:${expected[i]}`], `${i} down, then Enter`);
  }
});

test("Enter with no movement is allow-once: the default is the narrowest allow", async () => {
  const { p, events } = picker();
  p.handleInput(KEY_ENTER);
  await settle();
  assert.deepEqual(events, ["select:allow-once"]);
});

test("Escape cancels, and a cancel never selects anything", async () => {
  const { p, events } = picker();
  p.handleInput(KEY_DOWN);
  p.handleInput(ESC);
  await settle();
  assert.deepEqual(events, ["cancel"]);
});

test("moving away and back lands on the same decision", async () => {
  const { p, events } = picker();
  p.handleInput(KEY_DOWN);
  p.handleInput(KEY_DOWN);
  p.handleInput(KEY_UP);
  p.handleInput(KEY_ENTER);
  await settle();
  assert.deepEqual(events, ["select:allow-session"]);
});

test("with a suggested rule, each scope says what it grants and where it is saved", () => {
  const { p } = picker();
  const screen = stripAnsi(p.render(140).join("\n"));
  assert.match(screen, /Allow once[\s\S]*Bash: rm -rf build/);
  assert.match(screen, /Grants Bash\(rm:\*\) until the session ends/);
  assert.match(screen, /Saves Bash\(rm:\*\) to \.freecode\/settings\.json/);
  assert.match(screen, /Saves Bash\(rm:\*\) to ~\/\.freecode\/settings\.json/);
  assert.match(screen, /Deny[\s\S]*Deletes files/);
});

test("without a rule every allow shows the call itself; deny falls back to a plain reason", () => {
  const { p } = picker({ toolName: "Write", description: "src/a.ts" });
  const screen = stripAnsi(p.render(140).join("\n"));
  assert.doesNotMatch(screen, /Grants|Saves/);
  assert.match(screen, /Write: src\/a\.ts/);
  assert.match(screen, /Block this action/);
});
