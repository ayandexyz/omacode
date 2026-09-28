import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import {
  bubblewrapAvailable,
  homeToolchainMounts,
  sandboxEnvironment,
  sandboxPlan,
} from "./sandbox.js";

test("bubblewrap plan exposes only the run tree read-write and uses a private tmp", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "night-sandbox-"));
  const cwd = path.join(tree, "packages", "app");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const plan = sandboxPlan("pnpm test", cwd, tree);
    assert.equal(plan.command, "bwrap");
    assert.deepEqual(
      plan.args.slice(
        plan.args.indexOf("--bind"),
        plan.args.indexOf("--setenv"),
      ),
      ["--bind", fs.realpathSync(tree), fs.realpathSync(tree)],
    );
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
    assert.equal(process.env.FREECODE_TEST_SECRET_TOKEN, "do-not-forward");
    assert.ok(sandboxEnvironment().PATH, "ordinary execution variables remain");
  } finally {
    if (old === undefined) delete process.env.FREECODE_TEST_SECRET_TOKEN;
    else process.env.FREECODE_TEST_SECRET_TOKEN = old;
  }
});

test("home toolchains on PATH are mounted read-only while credential roots stay hidden", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "night-sandbox-home-"));
  const miseBin = path.join(
    home,
    ".local",
    "share",
    "mise",
    "installs",
    "node",
    "1",
    "bin",
  );
  const secretBin = path.join(home, ".config", "private", "bin");
  const disguisedSecretBin = path.join(home, ".local", "disguised-secret");
  fs.mkdirSync(miseBin, { recursive: true });
  fs.mkdirSync(secretBin, { recursive: true });
  fs.symlinkSync(secretBin, disguisedSecretBin, "dir");
  try {
    const args = homeToolchainMounts(
      {
        PATH: [miseBin, secretBin, disguisedSecretBin, "/usr/bin"].join(
          path.delimiter,
        ),
      },
      home,
    );
    const miseRoot = path.join(home, ".local", "share", "mise");
    const at = args.findIndex(
      (arg, i) => arg === "--ro-bind" && args[i + 2] === miseRoot,
    );
    assert.ok(at >= 0, "mise is exposed from its manager root");
    assert.equal(args[at + 1], fs.realpathSync(miseRoot));
    assert.ok(
      !args.includes(secretBin),
      "configuration directories remain hidden",
    );
    assert.ok(
      !args.includes(disguisedSecretBin),
      "symlinks into configuration directories remain hidden",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a sandboxed shell can execute a user toolchain while the rest of home stays hidden", () => {
  if (!bubblewrapAvailable()) return;
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "night-sandbox-toolchain-"),
  );
  const home = path.join(root, "home");
  const tree = path.join(root, "tree");
  const bin = path.join(home, ".local", "tool", "bin");
  const command = path.join(bin, "night-tool");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(tree);
  fs.writeFileSync(command, "#!/bin/sh\nprintf toolchain-visible\n");
  fs.chmodSync(command, 0o755);
  fs.writeFileSync(path.join(home, "secret.txt"), "hidden");
  const env = { PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter) };
  try {
    const plan = sandboxPlan(
      `night-tool && test ! -e ${JSON.stringify(path.join(home, "secret.txt"))}`,
      tree,
      tree,
      env,
      home,
    );
    const out = spawnSync(plan.command, plan.args, { encoding: "utf-8", env });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "toolchain-visible");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree's git metadata is mounted read-only, so git works inside", () => {
  // Every detached night runs in a worktree, whose `.git` is a FILE pointing
  // into the main repo's .git — under $HOME, which the sandbox hides. The
  // first live run's model got "not a git repository" for every git command.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "night-sandbox-repo-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "wt");
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
  try {
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(
      repo,
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=a",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    git(repo, "worktree", "add", "-q", "-b", "night/x", worktree);

    const plan = sandboxPlan(
      "git status --short && git log --oneline -1",
      worktree,
      worktree,
    );
    const common = fs.realpathSync(path.join(repo, ".git"));
    const at = plan.args.findIndex(
      (arg, i) => arg === "--ro-bind" && plan.args[i + 1] === common,
    );
    assert.ok(at > 0, "the main repo's .git is bound read-only");
    assert.equal(plan.args[at + 2], common);

    if (bubblewrapAvailable()) {
      const out = spawnSync(plan.command, plan.args, { encoding: "utf-8" });
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /init/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a plain checkout needs no extra git mount", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "night-sandbox-"));
  try {
    const plan = sandboxPlan("pwd", tree, tree, { PATH: "/usr/bin" });
    assert.equal(plan.args.filter((a) => a === "--ro-bind").length, 1);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});
