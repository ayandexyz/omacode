// =============================================================================
// monitor: output lines arrive as task-notification events while the command
// runs, batched; a final notification at the end; guard rails hold.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { tools } from "./index.js";
import { KillBashTool } from "./killbash.js";
import { disposeShellRegistry, peekShellRegistry } from "./shells/index.js";
import { setTaskNotificationSink } from "../agent/task-notify.js";
import { MAX_EVENTS, lineMatcher } from "./monitor.js";
import { modeEnforcement } from "../permission/mode-policy.js";
import { ruleMatches } from "../permission/rules.js";
import { suggestRule } from "../permission/suggest.js";

process.env.FREECODE_TASK_NOTIFY = "1";
const MonitorTool = tools.monitor;
const ctx = (sessionId: string) => ({ cwd: process.cwd(), sessionId, abort: new AbortController().signal });

function capture() {
  const got: Array<{ text: string; notice: string }> = [];
  const prev = setTaskNotificationSink((_sid, text, notice) => got.push({ text, notice }));
  return { got, restore: () => setTaskNotificationSink(prev) };
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("matching lines arrive as one batched event while running, then a final one", async () => {
  const { got, restore } = capture();
  try {
    const r = await MonitorTool.execute(
      {
        command: "echo ok-1; echo FAIL case-a; echo ok-2; echo FAIL case-b; sleep 1.5; echo done",
        description: "eval failures",
        pattern: "FAIL",
      },
      ctx("mon-basic"),
    );
    assert.equal(r.success, true);
    assert.match(r.success ? r.result.output : "", /Monitoring as bash_\d+/);
    await until(() => got.some((g) => /<status>completed<\/status>/.test(g.text)));
    const events = got.filter((g) => /<status>event<\/status>/.test(g.text));
    assert.equal(events.length, 1, "two FAIL lines in one burst are one event");
    assert.match(events[0]!.text, /FAIL case-a\nFAIL case-b/);
    assert.doesNotMatch(events[0]!.text, /ok-1/, "non-matching lines are filtered out");
    assert.match(events[0]!.text, /still running/);
    assert.match(events[0]!.notice, /^Monitor eval failures: FAIL case-a/);
    assert.match(got.at(-1)!.text, /Monitor ended\.\nExit code: 0/);
  } finally {
    restore();
    disposeShellRegistry("mon-basic");
  }
});

test("a firehose stops itself after MAX_EVENTS and says the filter is too loose", async () => {
  const { got, restore } = capture();
  try {
    await MonitorTool.execute(
      // One line every 1.1s would take minutes; instead the flush window is
      // what spaces events, so emit one line per window, forever.
      { command: "while true; do echo tick; sleep 1.05; done", description: "ticks", timeout_ms: 120_000 },
      ctx("mon-flood"),
    );
    await until(() => got.some((g) => /Monitor ended/.test(g.text)), 40_000);
    assert.equal(got.filter((g) => /<status>event<\/status>/.test(g.text)).length, MAX_EVENTS);
    assert.match(got.at(-1)!.text, /stopped after 20 events — the filter is too loose/);
  } finally {
    restore();
    disposeShellRegistry("mon-flood");
  }
});

test("timeout_ms stops it, and the final notification says so", async () => {
  const { got, restore } = capture();
  try {
    await MonitorTool.execute({ command: "sleep 30", description: "idle", timeout_ms: 300 }, ctx("mon-timeout"));
    await until(() => got.some((g) => /Monitor ended/.test(g.text)));
    assert.match(got.at(-1)!.text, /timed out after 0s|timed out after \d+s/);
    assert.match(got.at(-1)!.text, /<status>killed<\/status>/);
  } finally {
    restore();
    disposeShellRegistry("mon-timeout");
  }
});

test("killbash by the model ends it silently — it asked for that", async () => {
  const { got, restore } = capture();
  try {
    const r = await MonitorTool.execute({ command: "sleep 30", description: "x" }, ctx("mon-kill"));
    const id = (r.success && r.result.metadata?.shellId) as string;
    await KillBashTool.execute({ bash_id: id }, ctx("mon-kill"));
    await until(() => peekShellRegistry("mon-kill")?.get(id)?.status === "killed");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(got.length, 0);
  } finally {
    restore();
    disposeShellRegistry("mon-kill");
  }
});

test("refused with notifications off — it would have no way to report", async () => {
  process.env.FREECODE_TASK_NOTIFY = "0";
  try {
    const r = await MonitorTool.execute({ command: "echo hi", description: "x" }, ctx("mon-off"));
    assert.equal(r.success, false);
    assert.match(r.success ? "" : r.error, /run_in_background/);
  } finally {
    process.env.FREECODE_TASK_NOTIFY = "1";
  }
});

test("an invalid regex falls back to a literal match", () => {
  const m = lineMatcher("[unclosed");
  assert.equal(m("has [unclosed in it"), true);
  assert.equal(m("does not"), false);
});

test("permissions treat it like bash: blocked in read-only modes, matched by command", () => {
  assert.match(modeEnforcement("explore", "monitor") ?? "", /not allowed in explore/);
  const args = { command: "pnpm eval coding", description: "x" };
  assert.equal(ruleMatches({ tool: "monitor", pattern: "pnpm eval:*", decision: "allow" } as never, "monitor", args, "/p"), true);
  assert.equal(ruleMatches({ tool: "monitor", pattern: "rm:*", decision: "allow" } as never, "monitor", args, "/p"), false);
  assert.equal(suggestRule("monitor", args, "/p"), "Monitor(pnpm eval:*)", "never a bare Monitor");
});

test("bash_id attaches to a running shell: earlier and later lines count, the shell's own exit reports the end", async () => {
  const { got, restore } = capture();
  const sid = "mon-attach";
  try {
    const bg = await tools.bash.execute(
      { command: "echo FAIL early; sleep 1; echo ok; echo FAIL late; sleep 1", run_in_background: true },
      ctx(sid),
    );
    const id = (bg.success && (bg.result as { metadata?: { shellId?: string } }).metadata?.shellId) as string;
    assert.ok(id, "bash returned a shell id");
    await new Promise((r) => setTimeout(r, 300)); // "FAIL early" is already buffered
    const r = await MonitorTool.execute({ bash_id: id, description: "fails", pattern: "FAIL" }, ctx(sid));
    assert.equal(r.success, true);
    assert.match(r.success ? r.result.output : "", new RegExp(`Watching ${id}`));
    await until(() => peekShellRegistry(sid)?.get(id)?.status === "completed");
    await until(() => got.some((g) => /FAIL late/.test(g.text)));
    const events = got.filter((g) => /<status>event<\/status>/.test(g.text));
    assert.match(events.map((e) => e.text).join("\n"), /FAIL early[\s\S]*FAIL late/);
    assert.equal(got.filter((g) => /Monitor ended/.test(g.text)).length, 0, "no second end notice");
  } finally {
    restore();
    disposeShellRegistry(sid);
  }
});

test("bash_id: a guard rail stops watching, never the shell", async () => {
  const { got, restore } = capture();
  const sid = "mon-attach-timeout";
  try {
    const bg = await tools.bash.execute({ command: "sleep 30", run_in_background: true }, ctx(sid));
    const id = (bg.success && (bg.result as { metadata?: { shellId?: string } }).metadata?.shellId) as string;
    await MonitorTool.execute({ bash_id: id, description: "idle", timeout_ms: 200 }, ctx(sid));
    await until(() => got.some((g) => /Stopped watching/.test(g.text)));
    assert.match(got.at(-1)!.text, /timed out[\s\S]*still running/);
    assert.equal(peekShellRegistry(sid)?.get(id)?.status, "running");
  } finally {
    restore();
    disposeShellRegistry(sid);
  }
});

test("bash_id: unknown or finished shells are refused; exactly one of command/bash_id", async () => {
  const r = await MonitorTool.execute({ bash_id: "bash_99", description: "x" }, ctx("mon-attach-missing"));
  assert.equal(r.success, false);
  assert.match(r.success ? "" : r.error, /No background shell bash_99/);
  const v = MonitorTool.validateInput?.({ command: "ls", bash_id: "bash_1", description: "x" } as never);
  assert.equal((v as { valid: boolean }).valid, false);
});

test("an attach call gets its own rule, never a bare Monitor that would allow every command", () => {
  const args = { bash_id: "bash_1", description: "x" };
  assert.equal(suggestRule("monitor", args, "/p"), "Monitor(bash_id:*)");
  const rule = { tool: "monitor", pattern: "bash_id:*", decision: "allow" } as never;
  assert.equal(ruleMatches(rule, "monitor", args, "/p"), true);
  assert.equal(ruleMatches(rule, "monitor", { command: "rm -rf /", description: "x" }, "/p"), false);
});
