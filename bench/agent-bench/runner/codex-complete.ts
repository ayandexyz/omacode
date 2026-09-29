// =============================================================================
// `codex exec` on the owner's Codex (ChatGPT) subscription: the GPT judge's
// transport, and the screen + task generator's (gen-tasks.ts). Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.6.
//
// This is OpenAI's own client in its documented headless mode, not freecode
// presenting itself as something else. What keeps every call contained:
//   - `--output-schema`: the final reply is schema-constrained, the same
//     guarantee BuffBench's `set_output` tool gave their judges;
//   - a read-only sandbox and `--ephemeral`: nothing is written or kept. A
//     judge runs in an empty dir (nothing to read); the generator runs in a
//     throwaway checkout of the parent commit, which it is meant to explore;
//   - `--ignore-user-config --ignore-rules` and the `--disable` list: the
//     owner's own hooks, plugins, skills and tools must not run inside, or
//     leak into, a judgement. Measured 2026-09-29: this drops the preamble from
//     ~12.2K to ~10.4K input tokens and stops the SessionEnd hook firing. The
//     remaining ~10K is Codex's built-in instructions, which cannot be
//     removed. Spec §6 discloses it.
// =============================================================================

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { JudgeUsage } from "./core-complete.js";
import type { Complete } from "./judge.js";

const score = (what: string) => ({
  type: "number",
  minimum: 0,
  maximum: 10,
  description: `${what}, on a 0 to 10 scale (not 0 to 1)`,
});

/** BuffBench's judge output schema, as JSON Schema for `--output-schema`. */
export const JUDGE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "analysis",
    "strengths",
    "weaknesses",
    "completionScore",
    "codeQualityScore",
    "overallScore",
  ],
  properties: {
    analysis: {
      type: "string",
      description: "Detailed analysis comparing agent changes to ground truth",
    },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    completionScore: score("How completely the prompt was addressed"),
    codeQualityScore: score("Code structure and maintainability"),
    overallScore: score("Combined assessment"),
  },
};

/** Features that would let the judge act, browse or run the owner's extensions. */
const DISABLED_FEATURES = [
  "hooks",
  "plugins",
  "apps",
  "multi_agent",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "skill_search",
];

export function codexArgs(
  model: string,
  dir: string,
  schemaFile: string,
  outFile: string,
): string[] {
  return [
    "exec",
    "-m",
    model,
    "--ignore-user-config",
    "--ignore-rules",
    ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-C",
    dir,
    "--output-schema",
    schemaFile,
    "-o",
    outFile,
    "--json",
    // The message goes on stdin, never argv: Linux caps one argument at 128KB
    // (MAX_ARG_STRLEN), and a screen input or a generator's diff exceeds it —
    // `spawn E2BIG` on 2 of 6 pilot screens, 2026-09-29.
    "-",
  ];
}

/** Token usage from the last `turn.completed` event of `--json` output. */
export function codexUsage(jsonl: string): { inputTokens: number; outputTokens: number } {
  let usage = { inputTokens: 0, outputTokens: 0 };
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"turn.completed"')) continue;
    try {
      const u = JSON.parse(line).usage ?? {};
      usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
    } catch {
      // a torn line is not a usage record
    }
  }
  return usage;
}

export interface CodexCall {
  model: string;
  /** Working directory: an empty scratch dir for a judge, a parent checkout for the generator. */
  cwd: string;
  schema: object;
  message: string;
  signal: AbortSignal;
  /** Tokens are added to `usage[usageKey]`. */
  usage: JudgeUsage;
  usageKey: string;
  bin?: string;
}

/** One `codex exec` call with a schema-constrained final reply. */
export function runCodex(call: CodexCall): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-call-"));
    const schemaFile = path.join(tmp, "schema.json");
    const outFile = path.join(tmp, "last.json");
    const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
    fs.writeFileSync(schemaFile, JSON.stringify(call.schema));

    const child = spawn(
      call.bin ?? "codex",
      codexArgs(call.model, call.cwd, schemaFile, outFile),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    // Written, then closed: with stdin left open, `codex exec` waits forever.
    child.stdin.on("error", () => {}); // a child that exits early closes the pipe; `close` reports it
    child.stdin.end(call.message);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const onAbort = () => child.kill("SIGTERM");
    call.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      call.signal.removeEventListener("abort", onAbort);
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      call.signal.removeEventListener("abort", onAbort);
      const u = (call.usage[call.usageKey] ??= { inputTokens: 0, outputTokens: 0, calls: 0 });
      const turn = codexUsage(stdout);
      u.inputTokens += turn.inputTokens;
      u.outputTokens += turn.outputTokens;
      u.calls += 1;
      const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf-8") : "";
      cleanup();
      if (code !== 0 || !text) {
        reject(new Error(`codex exec exited ${code}: ${stderr.trim().slice(-300)}`));
      } else {
        resolve(text);
      }
    });
  });
}

export function codexComplete(usage: JudgeUsage, bin = "codex"): Complete {
  return async (judge, system, prompt, signal) => {
    // A judge reads nothing from disk: an empty dir leaves it nothing to find.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-judge-"));
    try {
      return await runCodex({
        model: judge.model,
        cwd: dir,
        schema: JUDGE_OUTPUT_SCHEMA,
        // No system-prompt flag, so the judge's system prompt leads the message.
        message: `${system}\n\n---\n\n${prompt}`,
        signal,
        usage,
        usageKey: judge.id,
        bin,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
