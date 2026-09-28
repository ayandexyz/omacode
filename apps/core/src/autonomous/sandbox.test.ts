import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sandboxEnvironment, sandboxPlan } from "./sandbox.js";

test("bubblewrap plan exposes only the run tree read-write and uses a private tmp", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "night-sandbox-"));
  const cwd = path.join(tree, "packages", "app");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const plan = sandboxPlan("pnpm test", cwd, tree);
    assert.equal(plan.command, "bwrap");
    assert.deepEqual(plan.args.slice(plan.args.indexOf("--bind"), plan.args.indexOf("--setenv")), [
      "--bind",
      fs.realpathSync(tree),
      fs.realpathSync(tree),
    ]);
    assert.ok(plan.args.includes("--ro-bind"));
    assert.ok(plan.args.includes("--tmpfs"));
    assert.ok(plan.args.includes(os.homedir()));
    assert.deepEqual(plan.args.slice(-3), ["/bin/bash", "-c", "pnpm test"]);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("sandbox refuses a shell workdir outside the run tree", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "night-sandbox-"));
  try {
    assert.throws(
      () => sandboxPlan("pwd", os.tmpdir(), tree),
      /outside the run tree/,
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("sandboxed shells do not inherit credentials", () => {
  const old = process.env.FREECODE_TEST_SECRET_TOKEN;
  process.env.FREECODE_TEST_SECRET_TOKEN = "do-not-forward";
  try {
    assert.equal(sandboxEnvironment().FREECODE_TEST_SECRET_TOKEN, undefined);
    assert.equal(
      process.env.FREECODE_TEST_SECRET_TOKEN,
      "do-not-forward",
    );
    assert.ok(sandboxEnvironment().PATH, "ordinary execution variables remain");
  } finally {
    if (old === undefined) delete process.env.FREECODE_TEST_SECRET_TOKEN;
    else process.env.FREECODE_TEST_SECRET_TOKEN = old;
  }
});
