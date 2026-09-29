// =============================================================================
// The judge's prompt, taken from BuffBench.
// Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.5.
//
// Derived from Codebuff's BuffBench (evals/buffbench/judge.ts),
// Copyright 2025 Codebuff, licensed under the Apache License 2.0.
// JUDGE_SYSTEM is their system prompt verbatim. renderJudgePrompt keeps their
// user-prompt layout section for section. The one addition is OUTPUT_FORMAT:
// their judges return a structured `set_output` tool call enforced by a
// schema. Ours are plain completions through core's providers, so the schema
// is stated in words and checked by `parseJudging`. It is appended to the user
// prompt rather than the system prompt, so the system prompt stays verbatim.
// =============================================================================

export const JUDGE_SYSTEM = `You are an expert software engineer evaluating AI-generated code changes with empathy for the task given.

## Your Role

You will receive:
1. The user prompt that the coding agent was given
2. Context files from the codebase
3. The ground truth changes (expected outcome)
4. The agent's actual changes

## Evaluation Philosophy

**Judge based on what the agent was asked to do, not on perfection.**

- If the prompt is vague or high-level (e.g., "add authentication"), be lenient and accept any reasonable implementation that achieves the goal
- If the prompt is specific and detailed, expect the implementation to match those details more closely
- Focus on whether the agent understood and addressed the user's intent
- Consider that there are often multiple valid ways to implement the same feature

## Evaluation Criteria

- **Completion** (0-10): How well did the agent address what was asked in the prompt? Consider the specificity of the prompt.
- **Code Quality** (0-10): How well-structured and maintainable is the code?
- **Overall** (0-10): Combined assessment of whether the agent successfully completed the task as requested

## Ground Truth

The ground truth shows ONE valid implementation, but it's not the only correct answer. The agent's implementation should be judged on:
- Does it achieve the same functional outcome?
- Is it a reasonable approach given the prompt?
- Does it maintain code quality?

Provide detailed analysis, strengths, weaknesses, and numerical scores.`;

const OUTPUT_FORMAT = `## Output Format

Reply with a single JSON object and nothing else:
{"analysis": string, "strengths": string[], "weaknesses": string[], "completionScore": number 0-10, "codeQualityScore": number 0-10, "overallScore": number 0-10}`;

export interface FinalCheckOutput {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface JudgeInput {
  prompt: string;
  /** path → content at the parent commit */
  contextFiles: Record<string, string>;
  groundTruth: { path: string; diff: string }[];
  agentDiff: string;
  error?: string;
  finalCheckOutputs?: FinalCheckOutput[];
}

function formatFinalChecks(outputs: FinalCheckOutput[]): string {
  return outputs
    .map(
      (o) =>
        `### ${o.command}\nExit code: ${o.exitCode}\n\`\`\`\n${o.stdout}\n\`\`\`` +
        (o.stderr ? `\nstderr:\n\`\`\`\n${o.stderr}\n\`\`\`` : ""),
    )
    .join("\n\n");
}

export function renderJudgePrompt(input: JudgeInput): string {
  const groundTruthDiffs = input.groundTruth
    .map(({ path, diff }) => `### ${path}\n\`\`\`diff\n${diff}\n\`\`\``)
    .join("\n\n");
  const contextFilesContent = Object.entries(input.contextFiles)
    .map(([filePath, content]) => `### ${filePath}\n\`\`\`\n${content}\n\`\`\``)
    .join("\n\n");
  const finalChecks =
    input.finalCheckOutputs && input.finalCheckOutputs.length > 0
      ? formatFinalChecks(input.finalCheckOutputs)
      : "";

  return `## User Prompt (What the agent was asked to do)
${input.prompt}

## Context Files (from parent commit)
${contextFilesContent || "(No context files)"}

## Ground Truth Changes (One valid implementation)
${groundTruthDiffs}

## Agent's Changes (What the agent actually did)
\`\`\`diff
${input.agentDiff || "(No changes made)"}
\`\`\`
${input.error ? `\n## Error Encountered\n${input.error}` : ""}
${finalChecks ? `\n## Final Check Command Outputs\n${finalChecks}` : ""}

${OUTPUT_FORMAT}`;
}
