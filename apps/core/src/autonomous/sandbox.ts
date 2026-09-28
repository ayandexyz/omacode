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

const SENSITIVE_HOME_PARTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config",
  ".codex",
  ".freecode",
  ".kube",
  ".docker",
  "keyrings",
]);

// A PATH entry is often a small bin directory inside one of these managers.
// Mount the manager root so launchers can still find runtimes and package
// stores beside the executable. All mounts remain read-only.
const TOOLCHAIN_ROOTS = [
  ".local/share/mise",
  ".local/share/pnpm",
  ".nvm",
  ".cargo",
  ".volta",
  ".asdf",
  ".bun",
] as const;

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

/**
 * The main repository's git dir, when `tree` is a linked worktree.
 *
 * A worktree's `.git` is a FILE (`gitdir: <main>/.git/worktrees/<name>`), and
 * that directory usually lives under $HOME, which the sandbox hides — so every
 * git command inside failed with "not a git repository" (first live detached
 * night). Returning the COMMON dir covers both the per-worktree metadata and
 * the objects/refs it points at. Undefined for a plain checkout, whose `.git`
 * is inside the tree and already mounted.
 */
function worktreeGitDir(tree: string): string | undefined {
  let pointer: string;
  try {
    pointer = fs.readFileSync(path.join(tree, ".git"), "utf-8");
  } catch {
    return undefined; // a directory (plain checkout) or no repo at all
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return undefined;
  const gitdir = path.resolve(tree, match[1]!.trim());
  let common = gitdir;
  try {
    const rel = fs.readFileSync(path.join(gitdir, "commondir"), "utf-8").trim();
    common = path.resolve(gitdir, rel);
  } catch {
    // no commondir file: the gitdir is self-contained
  }
  try {
    return fs.realpathSync(common);
  } catch {
    return undefined;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isSensitiveHomePath(home: string, candidate: string): boolean {
  if (!isWithin(home, candidate)) return false;
  return path
    .relative(home, candidate)
    .split(path.sep)
    .some((part) => SENSITIVE_HOME_PARTS.has(part));
}

/**
 * Re-expose user-installed toolchains after the home tmpfs is mounted.
 *
 * Only existing PATH entries below home are considered. Known credential and
 * configuration roots stay hidden. Recognized version managers are mounted at
 * their root because their bin entries commonly dispatch to sibling installs.
 */
export function homeToolchainMounts(
  source: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string[] {
  let realHome: string;
  try {
    realHome = fs.realpathSync(home);
  } catch {
    return [];
  }

  const mounts = new Map<string, string>();
  for (const entry of (source.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const destination = path.resolve(entry);
    let realEntry: string;
    try {
      realEntry = fs.realpathSync(destination);
      if (!fs.statSync(realEntry).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!isWithin(realHome, destination)) continue;

    const relative = path.relative(realHome, destination);
    if (
      isSensitiveHomePath(realHome, destination) ||
      isSensitiveHomePath(realHome, realEntry)
    )
      continue;

    const manager = TOOLCHAIN_ROOTS.find(
      (root) => relative === root || relative.startsWith(`${root}${path.sep}`),
    );
    const mountAt = manager ? path.join(realHome, manager) : destination;
    let mountFrom: string;
    try {
      mountFrom = fs.realpathSync(mountAt);
      if (!fs.statSync(mountFrom).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isSensitiveHomePath(realHome, mountFrom)) continue;
    mounts.set(mountAt, mountFrom);

    // rustup keeps its installed toolchains beside ~/.cargo, not below it.
    if (manager === ".cargo") {
      const rustup = path.join(realHome, ".rustup");
      try {
        mounts.set(rustup, fs.realpathSync(rustup));
      } catch {
        // Cargo can also be installed without rustup.
      }
    }
  }

  const directories = new Set<string>();
  for (const destination of mounts.keys()) {
    let current = path.dirname(destination);
    while (current !== realHome && isWithin(realHome, current)) {
      directories.add(current);
      current = path.dirname(current);
    }
  }

  const args: string[] = [];
  for (const directory of [...directories].sort(
    (a, b) => a.length - b.length,
  )) {
    args.push("--dir", directory);
  }
  for (const [destination, sourcePath] of [...mounts].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    args.push("--ro-bind", sourcePath, destination);
  }
  return args;
}

export function sandboxPlan(
  command: string,
  cwd: string,
  projectPath: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): SandboxPlan {
  const tree = fs.realpathSync(projectPath);
  const working = fs.realpathSync(cwd);
  const relative = path.relative(tree, working);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `sandbox workdir ${cwd} is outside the run tree ${projectPath}`,
    );
  }
  // READ-only: git status/diff/log work, but history cannot be written from
  // inside — committing is the orchestrator's act, which runs unsandboxed.
  const gitDir = worktreeGitDir(tree);
  const gitMount = gitDir ? ["--ro-bind", gitDir, gitDir] : [];
  const toolchainMounts = homeToolchainMounts(sourceEnvironment, home);
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
      home,
      "--tmpfs",
      "/tmp",
      ...toolchainMounts,
      ...gitMount,
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
