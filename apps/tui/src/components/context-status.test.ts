import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CacheStats } from "@thisisayande/freecode-shared";
import { ContextMisses, contextSummary } from "./context-status.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

const stats = (over: Partial<CacheStats> = {}): CacheStats => ({
  yieldPct: 99,
  lastYieldPct: 99,
  lastPct: 97,
  sessionPct: 91,
  misses: [],
  ...over,
});

const summary = (s: CacheStats | undefined, rate?: number) => {
  const out = contextSummary(12_300, 200_000, rate, s);
  return out && { tokens: strip(out.tokens), cache: out.cache && strip(out.cache) };
};

const misses = (s: CacheStats | undefined, width = 120): string[] =>
  new ContextMisses(() => s).render(width).map(strip);

test("nothing renders while the context limit is unknown", () => {
  assert.equal(contextSummary(12_300, 0, 87, stats()), null);
});

test("without stats the plain last-run rate stands in", () => {
  assert.deepEqual(summary(undefined, 87), { tokens: "12.3K / 200.0K", cache: "cache 87%" });
});

test("without any cache data only the token count shows", () => {
  assert.deepEqual(summary(undefined), { tokens: "12.3K / 200.0K", cache: null });
});

test("stats render jcode's yield · last · session line", () => {
  assert.equal(summary(stats())?.cache, "yield 99% · last 97% · session 91%");
});

test("before the second call yield reads as priming", () => {
  assert.match(
    summary(stats({ yieldPct: undefined, lastYieldPct: undefined }))?.cache ?? "",
    /priming · last 97% · session 91%/,
  );
});

test("no misses, no rows: the list costs nothing until it has something to say", () => {
  assert.deepEqual(misses(stats()), []);
  assert.deepEqual(misses(undefined), []);
});

test("misses list the turn label, tokens and reason, newest last", () => {
  const lines = misses(
    stats({
      misses: [
        { turn: { run: 2, call: 1 }, missedTokens: 40_100, reason: "model switch", harnessBug: false },
        { turn: { run: 3, call: 2 }, missedTokens: 12_000, reason: "harness: prefix rewritten", harnessBug: true },
      ],
    }),
  );
  assert.deepEqual(lines, [
    "miss attribution · 52.1k missed total",
    "2> 40.1k miss (model switch)",
    "3.2> 12.0k miss (harness: prefix rewritten)",
  ]);
});

test("more than five misses fold into a count", () => {
  const list = Array.from({ length: 7 }, (_, i) => ({
    turn: { run: i + 1, call: 1 },
    missedTokens: 2_000,
    reason: "expired",
    harnessBug: false,
  }));
  const lines = misses(stats({ misses: list }));
  assert.equal(lines.filter((l) => l.endsWith("(expired)")).length, 5);
  assert.equal(lines.at(-1), "… 2 more");
  // The oldest two are the ones folded.
  assert.equal(lines[1], "3> 2.0k miss (expired)");
});

test("miss rows are indented to the prompt column and never wider than a row", () => {
  const rows = new ContextMisses(
    () =>
      stats({
        misses: [
          {
            turn: { run: 12, call: 3 },
            missedTokens: 999_900,
            reason: "compaction: auto compaction: 190000 → 40000 tokens",
            harnessBug: false,
          },
        ],
      }),
    () => 4,
  ).render(80);
  for (const line of rows) {
    assert.ok(strip(line).startsWith("    "), strip(line));
    assert.ok(visibleWidth(line) <= 80, strip(line));
  }
});
