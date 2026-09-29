import test from "node:test";
import assert from "node:assert/strict";
import { EGRESS_NETWORK, checkArgv, dockerArgv, forwardedEnvNames, setupArgv, type Containerize } from "./docker.js";

const c: Containerize = {
  image: "agent-bench",
  network: "agent-bench-internal",
  name: "trial-x",
  wsDir: "/tmp/ws",
  benchDir: "/repo/bench/agent-bench",
  envNames: ["ANTHROPIC_BASE_URL", "MINIMAX_API_KEY"],
  uid: 1000,
  gid: 1000,
};

test("dockerArgv: env rides as bare -e NAME — no secret ever lands in argv", () => {
  const argv = dockerArgv(c, ["freecode", "run", "fix it"]);
  assert.equal(argv.includes("MINIMAX_API_KEY"), true);
  assert.equal(argv.some((a) => a.includes("MINIMAX_API_KEY=")), false);
  assert.deepEqual(argv.slice(-3), ["freecode", "run", "fix it"]);
  assert.equal(argv[argv.indexOf("--network") + 1], "agent-bench-internal");
  assert.equal(argv[argv.indexOf("--user") + 1], "1000:1000");
  assert.equal(argv.includes("/tmp/ws:/workspace"), true);
  assert.equal(argv.includes("/repo/bench/agent-bench:/bench:ro"), true);
});

test("forwardedEnvNames: adapter names + meter names; \"\" (unset) is not forwarded", () => {
  const names = forwardedEnvNames(
    { XDG_CONFIG_HOME: "{configDir}", ANTHROPIC_API_KEY: "" },
    { MINIMAX_BASE_URL: "http://x", ANTHROPIC_BASE_URL: "http://x" },
  );
  assert.deepEqual(names, ["ANTHROPIC_BASE_URL", "MINIMAX_BASE_URL", "XDG_CONFIG_HOME"]);
});

test("dockerArgv: a configDir is mounted rw — opencode writes into XDG_CONFIG_HOME", () => {
  const base = {
    image: "agent-bench",
    network: "n",
    name: "t",
    wsDir: "/ws",
    benchDir: "/bench",
    envNames: [],
    uid: 1000,
    gid: 1000,
  };
  assert.ok(!dockerArgv(base, ["x"]).some((a) => a.includes("/agent-config")));
  const mounts = dockerArgv({ ...base, configDir: "/tmp/cfg" }, ["x"]);
  const i = mounts.indexOf("/tmp/cfg:/agent-config");
  assert.ok(i > 0, "configDir must be mounted at /agent-config");
  assert.equal(mounts[i - 1], "-v");
  // NOT :ro — a read-only mount breaks opencode's package install.
  assert.ok(!mounts.some((a) => a.startsWith("/tmp/cfg:") && a.endsWith(":ro")));
});

const tool = { image: "agent-bench", name: "bench-setup-x", wsDir: "/tmp/ws", uid: 1000, gid: 1000 };

test("setupArgv: the judged install runs in the agent's image, online, into an operator-owned store", () => {
  const argv = setupArgv(tool, "/repo/.cache/pnpm-store", "pnpm install --frozen-lockfile");
  const after = (flag: string) => argv[argv.indexOf(flag) + 1];
  assert.equal(after("--network"), EGRESS_NETWORK, "install scripts may fetch prebuilt binaries");
  assert.equal(after("--user"), "1000:1000");
  assert.equal(after("--name"), "bench-setup-x");
  assert.ok(argv.includes("/tmp/ws:/workspace"));
  assert.ok(argv.includes("/repo/.cache/pnpm-store:/pnpm-store"));
  assert.ok(argv.includes("npm_config_store_dir=/pnpm-store"));
  assert.deepEqual(argv.slice(-4), ["agent-bench", "sh", "-c", "pnpm install --frozen-lockfile"]);
});

test("checkArgv: final checks run in the same image with no network and no store", () => {
  const argv = checkArgv(tool, "pnpm -C apps/core test");
  assert.equal(argv[argv.indexOf("--network") + 1], "none");
  assert.equal(argv.some((a) => a.includes("pnpm-store")), false);
  assert.deepEqual(argv.slice(-4), ["agent-bench", "sh", "-c", "pnpm -C apps/core test"]);
});
