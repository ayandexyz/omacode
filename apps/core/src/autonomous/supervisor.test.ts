import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { launchDetachedNight } from "./supervisor.js";
import { pidAlive } from "./night-ops.js";
import { readManifest } from "./run-store.js";

test("detached worker receives a persisted pid and keeps progressing independently", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "night-supervisor-"));
  const marker = path.join(root, "worker-finished");
  const previous = process.env.FREECODE_RUNS_HOME;
  process.env.FREECODE_RUNS_HOME = path.join(root, "runs");
  try {
    const launched = launchDetachedNight(
      {
        objective: "exercise the supervisor",
        projectPath: root,
        maxIterations: 1,
        sandbox: false,
        commitStyle: "night",
      },
      {
        command: process.execPath,
        args: [
          "-e",
          `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "ok"), 100)`,
        ],
      },
    );
    assert.ok(pidAlive(launched.pid));
    assert.equal(readManifest(launched.runId)?.pid, launched.pid);

    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.readFileSync(marker, "utf-8"), "ok");
  } finally {
    if (previous === undefined) delete process.env.FREECODE_RUNS_HOME;
    else process.env.FREECODE_RUNS_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
