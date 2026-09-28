// =============================================================================
// Linux filesystem sandbox for an unattended shell.
//
// Bubblewrap sees the host root read-only and overlays exactly the run's project
// tree read-write. /tmp is private. Network is deliberately shared: web/package
// access remains governed by the permission envelope, while filesystem escape is
// the gap this phase closes. Attended shells never pass a sandbox configuration.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

export interface SandboxPlan {
  command: string;
  args: string[];
}

const SENSITIVE_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** Provider credentials stay in FreeCode and never enter arbitrary bash. */
export function sandboxEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !SENSITIVE_ENV.test(name)),
  );
}

export function bubblewrapAvailable(): boolean {
  if (process.platform !== "linux") return false;
  // `--version` succeeds even when the kernel forbids the user namespace that
  // a real sandbox needs. Probe the smallest useful sandbox instead.
  const found = spawnSync(
    "bwrap",
    ["--die-with-parent", "--ro-bind", "/", "/", "--", "/bin/true"],
    { stdio: "ignore" },
  );
  return !found.error && found.status === 0;
}

export function sandboxPlan(
  command: string,
  cwd: string,
  projectPath: string,
): SandboxPlan {
  const tree = fs.realpathSync(projectPath);
  const working = fs.realpathSync(cwd);
  const relative = path.relative(tree, working);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`sandbox workdir ${cwd} is outside the run tree ${projectPath}`);
  }
  return {
    command: "bwrap",
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--ro-bind",
      "/",
      "/",
      // Hide the user's home (credentials, ssh keys, config) and make temp
      // private before re-exposing only the project tree below.
      "--tmpfs",
      os.homedir(),
      "--tmpfs",
      "/tmp",
      "--bind",
      tree,
      tree,
      "--setenv",
      "HOME",
      "/tmp",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--chdir",
      working,
      "/bin/bash",
      "-c",
      command,
    ],
  };
}
