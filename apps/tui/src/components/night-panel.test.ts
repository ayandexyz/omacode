import test from "node:test";
import assert from "node:assert/strict";
import { NightPanel } from "./night-panel.js";
import type { NightRunSummary } from "@thisisayande/freecode-shared";

const strip = (rows: string[]): string =>
  // eslint-disable-next-line no-control-regex
  rows.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

const run = (over: Partial<NightRunSummary> = {}): NightRunSummary => ({
  runId: "abc123",
  status: "completed",
  objective: "reduce the TUI's render cost",
  branch: "night/reduce-the-tui-render-cost",
  stopReason: "objective_met",
  iterations: 9,
  commits: 7,
  waitedMs: 0,
  provider: "anthropic",
  model: "claude-opus-5",
  uncommitted: 0,
  needsHuman: 0,
  ...over,
});

function panel(runs: NightRunSummary[]): {
  p: NightPanel;
  opened: string[];
  stopped: string[];
  closed: number;
} {
  const opened: string[] = [];
  const stopped: string[] = [];
  let closed = 0;
  const p = new NightPanel({
    onOpen: (id) => opened.push(id),
    onStop: (id) => stopped.push(id),
    onClose: () => {
      closed += 1;
    },
  });
  p.setRuns(runs);
  return { p, opened, stopped, get closed() {
    return closed;
  } } as never;
}

test("an empty roster says how to start a run, since the panel cannot", () => {
  const { p } = panel([]);
  const text = strip(p.render(70));
  assert.match(text, /No overnight runs yet/);
  assert.match(text, /freecode night "<objective>" --until 07:00/);
});

test("needs-you outranks the commit count in the status cell", () => {
  // Nine commits and one unanswered question is, to the user, a night with a
  // question in it.
  const { p } = panel([run({ commits: 9, needsHuman: 1 })]);
  const text = strip(p.render(70));
  assert.match(text, /1 needs you/);
  assert.doesNotMatch(text, /9 commits/);
});

test("a running night shows its progress; a crashed one says so", () => {
  const { p } = panel([
    run({ runId: "r1", status: "running", stopReason: undefined, iterations: 3, commits: 2 }),
  ]);
  assert.match(strip(p.render(70)), /running · it\.3 · 2 commits/);

  const crashed = panel([run({ runId: "r2", status: "crashed", commits: 4 })]);
  assert.match(strip(crashed.p.render(70)), /crashed · 4 commits/);
});

test("time spent waiting on a quota is on the row", () => {
  const { p } = panel([run({ waitedMs: 2 * 3_600_000 + 11 * 60_000 })]);
  assert.match(strip(p.render(70)), /waited 2h11m/);
});

test("enter opens the selected run's report", () => {
  const { p, opened } = panel([run({ runId: "first" }), run({ runId: "second" })]);
  p.handleInput("\r");
  assert.deepEqual(opened, ["first"]);
  p.handleInput("\u001b[B"); // down
  p.handleInput("\r");
  assert.deepEqual(opened, ["first", "second"]);
});

test("k stops a running night and does nothing to a finished one", () => {
  const finished = panel([run({ runId: "done", status: "completed" })]);
  finished.p.handleInput("k");
  assert.deepEqual(finished.stopped, [], "a finished run has nothing to stop");

  const live = panel([run({ runId: "live", status: "running" })]);
  live.p.handleInput("k");
  assert.deepEqual(live.stopped, ["live"]);
});

test("the hint only offers stop when the selection can be stopped", () => {
  assert.doesNotMatch(strip(panel([run()]).p.render(70)), /k stop/);
  assert.match(
    strip(panel([run({ status: "running" })]).p.render(70)),
    /k stop/,
  );
});

test("the cursor stays on the same run across a refresh", () => {
  // The roster re-sorts as runs finish; the selection must follow the run the
  // user was looking at, not the index it happened to occupy.
  const { p } = panel([run({ runId: "a" }), run({ runId: "b" })]);
  p.handleInput("\u001b[B");
  assert.equal(p.selectedRun()?.runId, "b");
  p.setRuns([run({ runId: "c" }), run({ runId: "a" }), run({ runId: "b" })]);
  assert.equal(p.selectedRun()?.runId, "b");
});

test("height is content-driven, not a fixed slab of the terminal", () => {
  const one = new NightPanel({ onOpen: () => {}, onStop: () => {}, onClose: () => {} });
  one.setRuns([run()]);
  const three = new NightPanel({ onOpen: () => {}, onStop: () => {}, onClose: () => {} });
  three.setRuns([run({ runId: "a" }), run({ runId: "b" }), run({ runId: "c" })]);
  assert.ok(three.heightFor(70) > one.heightFor(70));
  assert.equal(one.heightFor(70), 4); // border + 1 row + hint + border
});

test("escape closes", () => {
  const h = panel([run()]);
  h.p.handleInput("\u001b");
  assert.equal(h.closed, 1);
});

test("counts feed the chip without opening the card", () => {
  const { p } = panel([
    run({ runId: "a", status: "running", needsHuman: 0 }),
    run({ runId: "b", status: "completed", needsHuman: 2 }),
  ]);
  assert.equal(p.runningCount(), 1);
  assert.equal(p.needsYouCount(), 2);
  assert.equal(p.isEmpty(), false);
});
