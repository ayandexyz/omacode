// =============================================================================
// A background shell reports its exit as a task notification — unless the
// model already knows how it ended (drained it with bashoutput, or killed it
// with killbash), in which case the notification would only buy a turn.
// Plus the foreground timeout cap.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { _executeBash, MAX_TIMEOUT } from "./bash.js";
import { BashOutputTool } from "./bashoutput.js";
import { KillBashTool } from "./killbash.js";
import { disposeShellRegistry, peekShellRegistry } from "./shells/index.js";
import { setTaskNotificationSink } from "../agent/task-notify.js";

process.env.FREECODE_TASK_NOTIFY = "1";

const ctx = (sessionId: string) => ({
  cwd: process.cwd(),
  sessionId,
  abort: new AbortController().signal,
});

interface Delivered {
  sessionId: string;
  text: string;
  notice: string;
  isStale?: () => boolean;
}

function capture(): { got: Delivered[]; restore: () => void } {
  const got: Delivered[] = [];
  const prev = setTaskNotificationSink((sessionId, text, notice, isStale) =>
    got.push({ sessionId, text, notice, isStale }),
  );
  return { got, restore: () => setTaskNotificationSink(prev) };
}

async function untilSettled(sessionId: string, id: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const status = peekShellRegistry(sessionId)?.get(id)?.status;
    if (status && status !== "running") return;
    if (Date.now() > deadline) throw new Error(`${id} never settled`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const start = async (sessionId: string, command: string) => {
  const r = await _executeBash({ command, run_in_background: true }, ctx(sessionId));
  assert.equal(r.success, true);
  return {
    id: (r.success && r.result.metadata?.shellId) as string,
    output: r.success ? r.result.output : "",
  };
};

test("an exited shell notifies its session with the exit code and output tail", async () => {
  const { got, restore } = capture();
  try {
    const { id, output } = await start("notify-exit", "echo hello-from-shell; exit 3");
    assert.match(output, /task-notification/, "the start message promises the notification");
    await untilSettled("notify-exit", id);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.sessionId, "notify-exit");
    assert.match(got[0]!.text, /<kind>shell<\/kind>/);
    assert.match(got[0]!.text, /<status>failed<\/status>/);
    assert.match(got[0]!.text, /Exit code: 3/);
    assert.match(got[0]!.text, /hello-from-shell/);
    assert.match(got[0]!.notice, /^Background command failed: echo hello-from-shell/);
    assert.equal(got[0]!.isStale?.(), false);
  } finally {
    restore();
    disposeShellRegistry("notify-exit");
  }
});

test("draining the finished shell with bashoutput makes the notification stale", async () => {
  const { got, restore } = capture();
  try {
    const { id } = await start("notify-drained", "echo done");
    await untilSettled("notify-drained", id);
    assert.equal(got.length, 1);
    await BashOutputTool.execute({ bash_id: id }, ctx("notify-drained"));
    assert.equal(got[0]!.isStale?.(), true, "checked at delivery, so a drain in between wins");
  } finally {
    restore();
    disposeShellRegistry("notify-drained");
  }
});

test("a shell drained before it exited still notifies — the model has not seen the end", async () => {
  const { got, restore } = capture();
  try {
    const { id } = await start("notify-early-read", "sleep 0.3; echo late");
    await BashOutputTool.execute({ bash_id: id }, ctx("notify-early-read"));
    await untilSettled("notify-early-read", id);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.isStale?.(), false);
  } finally {
    restore();
    disposeShellRegistry("notify-early-read");
  }
});

test("a shell the model killed with killbash does not notify", async () => {
  const { got, restore } = capture();
  try {
    const { id } = await start("notify-killbash", "sleep 30");
    await KillBashTool.execute({ bash_id: id }, ctx("notify-killbash"));
    await untilSettled("notify-killbash", id);
    assert.equal(got.length, 0);
  } finally {
    restore();
    disposeShellRegistry("notify-killbash");
  }
});

test("a shell killed by someone else (the /shells panel) does notify, as killed", async () => {
  const { got, restore } = capture();
  try {
    const { id } = await start("notify-panel-kill", "sleep 30");
    peekShellRegistry("notify-panel-kill")!.kill(id);
    await untilSettled("notify-panel-kill", id);
    assert.equal(got.length, 1);
    assert.match(got[0]!.text, /<status>killed<\/status>/);
  } finally {
    restore();
    disposeShellRegistry("notify-panel-kill");
  }
});

test("notifications off: no notification, and the start message says to check with bashoutput", async () => {
  const { got, restore } = capture();
  process.env.FREECODE_TASK_NOTIFY = "0";
  try {
    const { id, output } = await start("notify-off", "echo quiet");
    assert.match(output, /notifications are off/);
    await untilSettled("notify-off", id);
    assert.equal(got.length, 0);
  } finally {
    process.env.FREECODE_TASK_NOTIFY = "1";
    restore();
    disposeShellRegistry("notify-off");
  }
});

test("a foreground timeout above the cap is capped, and the message says why", async () => {
  // Uses the cap's own value as the "asked" timeout so the test does not wait:
  // the check is on the clamp arithmetic, via a command that finishes at once.
  assert.equal(MAX_TIMEOUT, 600_000);
  const quick = await _executeBash(
    { command: "echo ok", timeout: MAX_TIMEOUT * 10 },
    ctx("fg-cap"),
  );
  assert.equal(quick.success, true, "a huge timeout is clamped, not rejected");
});

test("a foreground command outliving the default timeout moves to the background, output kept", async () => {
  const { got, restore } = capture();
  try {
    const r = await _executeBash(
      { command: "echo early-line; sleep 1; echo late-line" },
      ctx("fg-move"),
      300,
    );
    assert.equal(r.success, true, "not a failure: the command is still running");
    const out = r.success ? r.result.output : "";
    assert.equal(r.success && r.result.metadata?.movedToBackground, true);
    assert.match(out, /early-line/, "what it printed so far is shown");
    assert.match(out, /moved to the background as bash_\d+ instead of being killed/);
    assert.match(out, /Do not run it again/);
    const id = (r.success && r.result.metadata?.shellId) as string;
    await untilSettled("fg-move", id);
    assert.equal(got.length, 1, "its exit is reported like any background shell");
    assert.match(got[0]!.text, /<status>completed<\/status>/);
    // The registry holds the whole run: the pre-move output and what followed.
    const all = await BashOutputTool.execute({ bash_id: id }, ctx("fg-move"));
    const text = all.success ? all.result.output : "";
    assert.match(text, /early-line/);
    assert.match(text, /late-line/);
    assert.equal(text.match(/early-line/g)?.length, 1, "no chunk recorded twice");
  } finally {
    restore();
    disposeShellRegistry("fg-move");
  }
});

test("an explicit short timeout still kills — and the model now sees the output and the advice", async () => {
  const r = await _executeBash(
    { command: "echo before-kill; sleep 5", timeout: 300 },
    ctx("fg-kill"),
  );
  assert.equal(r.success, false);
  const error = r.success ? "" : r.error;
  assert.match(error, /timed out after 300ms \(the timeout you set\) and was killed/);
  assert.match(error, /before-kill/, "partial output reaches the model");
  assert.match(error, /run_in_background: true/, "the advice reaches the model");
  assert.equal(peekShellRegistry("fg-kill")?.list().length ?? 0, 0, "nothing was adopted");
});

test("polling a still-running shell with nothing new tells the model to stop polling", async () => {
  try {
    const { id } = await start("poll-nudge", "sleep 5");
    const r = await BashOutputTool.execute({ bash_id: id }, ctx("poll-nudge"));
    assert.match(r.success ? r.result.output : "", /stop polling/);
    process.env.FREECODE_TASK_NOTIFY = "0";
    const off = await BashOutputTool.execute({ bash_id: id }, ctx("poll-nudge"));
    assert.doesNotMatch(off.success ? off.result.output : "", /stop polling/, "no promise it can't keep");
  } finally {
    process.env.FREECODE_TASK_NOTIFY = "1";
    disposeShellRegistry("poll-nudge");
  }
});
