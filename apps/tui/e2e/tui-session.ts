// =============================================================================
// Drive the real TUI in tmux. Borrowed from freebuff's e2e harness
// (freebuff/e2e/utils/freebuff-session.ts).
//
// Every session gets its own HOME and project dir under the OS temp dir, so a
// test never reads or writes the developer's ~/.freecode (sessions, memory,
// keys). The TUI is the dev entry (`tsx src/index.ts`) with FREECODE_ROOT set,
// because outside the repo root it cannot find core otherwise. The command
// ends in an exit-code marker and a sleep, so the pane survives the process
// and a test can read how it exited.
// =============================================================================

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TUI_ENTRY = path.join(REPO_ROOT, "apps", "tui", "src", "index.ts");
const EXIT_MARKER = "__FREECODE_EXIT__=";

export function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Skip locally without tmux, with the reason; never skip in CI (a skipped suite reads as green). */
export function tmuxSkipReason(): string | false {
  if (tmuxAvailable()) return false;
  if (process.env.CI) throw new Error("tmux is required for the TUI e2e suite in CI");
  return "tmux not installed";
}

const tmux = (...args: string[]) =>
  execFileSync("tmux", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

let counter = 0;

export class TuiSession {
  private constructor(
    readonly name: string,
    readonly root: string,
    readonly projectDir: string,
  ) {}

  static start(opts: { files?: Record<string, string>; config?: object; env?: Record<string, string> } = {}): TuiSession {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-e2e-"));
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(home, ".freecode"), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "README.md"), "# E2E test project\n");
    for (const [rel, content] of Object.entries(opts.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
      fs.writeFileSync(path.join(project, rel), content);
    }
    if (opts.config) {
      fs.writeFileSync(path.join(home, ".freecode", "config.json"), JSON.stringify(opts.config));
    }
    // Env rides a 0600 file sourced by the shell: a key never lands in the
    // project the TUI indexes, nor in tmux's recorded command line.
    const envFile = path.join(root, "env.sh");
    const env = { HOME: home, FREECODE_ROOT: REPO_ROOT, ...opts.env };
    fs.writeFileSync(
      envFile,
      Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`).join("\n") + "\n",
      { mode: 0o600 },
    );
    const name = `freecode-e2e-${process.pid}-${++counter}`;
    const command =
      `. ${q(envFile)} && cd ${q(project)} && ${q(TSX)} ${q(TUI_ENTRY)} 2>${q(path.join(root, "stderr.log"))}; ` +
      `echo ${EXIT_MARKER}$?; sleep 600`;
    tmux("new-session", "-d", "-s", name, "-x", "120", "-y", "40", command);
    return new TuiSession(name, root, project);
  }

  /** The pane plus scrollback, as plain text. */
  capture(): string {
    return tmux("capture-pane", "-p", "-J", "-S", "-1000", "-t", this.name);
  }

  stderr(): string {
    const f = path.join(this.root, "stderr.log");
    return fs.existsSync(f)
      ? fs.readFileSync(f, "utf-8").split("\n").filter((l) => !/DEP0205|trace-deprecation/.test(l)).join("\n").trim()
      : "";
  }

  async waitFor(pattern: string | RegExp, timeoutMs = 60_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = this.capture();
      if (typeof pattern === "string" ? screen.includes(pattern) : pattern.test(screen)) return screen;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for ${pattern}\n--- screen ---\n${screen}\n--- stderr ---\n${this.stderr()}`,
        );
      }
      await sleep(250);
    }
  }

  /** Boot is done once the welcome line or the prompt footer is drawn. */
  waitForBoot(): Promise<string> {
    return this.waitFor(/>_ OmaCode \(v\d+\.\d+\.\d+\)/);
  }

  /** Literal text, no Enter. */
  type(text: string): void {
    tmux("send-keys", "-t", this.name, "-l", text);
  }

  keys(...keys: string[]): void {
    tmux("send-keys", "-t", this.name, ...keys);
  }

  /**
   * Close the first-run provider picker. Waits for it to be gone and pauses
   * before returning: a terminal reads ESC followed at once by another key as
   * Alt+key, so "Escape" then "/" arrived as Alt-/ and the command was lost.
   */
  async dismissPicker(): Promise<void> {
    this.keys("Escape");
    const deadline = Date.now() + 10_000;
    while (this.capture().includes("not configured")) {
      if (Date.now() > deadline) throw new Error(`provider picker did not close\n${this.capture()}`);
      await sleep(100);
    }
    await sleep(300);
  }

  async submit(text: string): Promise<void> {
    this.type(text);
    await sleep(300);
    this.keys("Enter");
  }

  /** The TUI's exit code once it has quit, or null while it runs. */
  exitCode(): number | null {
    const m = new RegExp(`${EXIT_MARKER}(\\d+)`).exec(this.capture());
    return m ? Number(m[1]) : null;
  }

  async waitForExit(timeoutMs = 20_000): Promise<number> {
    await this.waitFor(EXIT_MARKER, timeoutMs);
    return this.exitCode()!;
  }

  stop(): void {
    try {
      tmux("kill-session", "-t", this.name);
    } catch {
      // already gone
    }
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/** Markers that must never appear on a healthy screen. */
export const FATAL_MARKERS = [
  "could not locate the core backend",
  "Unhandled",
  "UnhandledPromiseRejection",
  "FATAL",
  "Segmentation fault",
  "Error: Cannot find module",
];
