import test from "node:test";
import assert from "node:assert/strict";
import { parseStartAt } from "./night.js";

test("parseStartAt accepts durations and future ISO timestamps", () => {
  const now = Date.parse("2026-09-28T12:00:00.000Z");
  assert.equal(parseStartAt("90m", now), now + 90 * 60_000);
  assert.equal(
    parseStartAt("2026-09-29T01:00:00.000Z", now),
    Date.parse("2026-09-29T01:00:00.000Z"),
  );
  assert.equal(parseStartAt("2026-09-27T01:00:00.000Z", now), undefined);
  assert.equal(parseStartAt("eventually", now), undefined);
});

test("parseStartAt rolls a local clock time to tomorrow when needed", () => {
  const now = new Date(2026, 8, 28, 23, 0, 0, 0).getTime();
  const expected = new Date(2026, 8, 29, 7, 30, 0, 0).getTime();
  assert.equal(parseStartAt("07:30", now), expected);
});
