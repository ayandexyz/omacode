// =============================================================================
// agent(run_in_background): the tool returns before the subagent runs, the
// roster records the prompt, and the finished result reaches the parent as a
// task notification. Real AgentLoop, fake provider, HOME in a temp dir (the
// tool opens the session store under ~/.freecode).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freecode-agent-bg-home-"));
process.env.HOME = home;
process.env.FREECODE_TASK_NOTIFY = "1";

const { registerProvider } = await import("../providers/registry.js");
const { tools } = await import("./index.js");
const AgentTool = tools.agent;
const { getAgentRegistry } = await import("../agent/registry/index.js");
const { setTaskNotificationSink, formatTaskNotification, taskNotificationsEnabled } =
  await import("../agent/task-notify.js");
const { createHookRuntime } = await import("../hooks/runtime.js");

const info = {
  id: "bg-fake",
  name: "bg-fake",
  defaultModel: "fake-model",
  supportsStreaming: true,
  supportsTools: true,
};

registerProvider("bg-fake" as never, {
  info,
  create: () => ({
    info,
    execute: async () => ({
      content: "",
      stopReason: "stop",
      provider: "bg-fake",
      model: "fake-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    stream: async function* () {
      yield { type: "text", text: "Found 2 callers." };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    },
  }),
} as never);

test.after(() => rmSync(home, { recursive: true, force: true }));

test("a background agent returns at once and reports back through the sink", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-bg-project-"));
  const delivered: Array<{ sessionId: string; text: string; notice: string }> = [];
  let resolveDelivered!: () => void;
  const arrived = new Promise<void>((r) => (resolveDelivered = r));
  const prev = setTaskNotificationSink((sessionId, text, notice) => {
    delivered.push({ sessionId, text, notice });
    resolveDelivered();
  });

  try {
    const result = await AgentTool.execute(
      {
        task: "Find callers",
        prompt: "Find every caller of runSessionTurn",
        agentType: "bg-fake",
        run_in_background: true,
      },
      {
        sessionId: "root-bg",
        cwd: project,
        projectPath: project,
        hooks: createHookRuntime(),
      } as never,
    );

    assert.equal(result.success, true);
    assert.ok(result.success && result.result.metadata?.background);
    assert.match(result.success ? result.result.output : "", /Started in the background/);

    const [agent] = getAgentRegistry().listForRoot("root-bg");
    assert.equal(agent?.prompt, "Find every caller of runSessionTurn");
    assert.equal(agent?.background, true);

    await arrived;
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.sessionId, "root-bg");
    assert.match(delivered[0]!.text, /<status>completed<\/status>/);
    assert.match(delivered[0]!.text, /Subagent: Find callers\nStatus: SUCCESS/);
    assert.match(delivered[0]!.notice, /Background agent completed: Find callers/);
  } finally {
    setTaskNotificationSink(prev);
    getAgentRegistry().disposeRoot("root-bg");
    rmSync(project, { recursive: true, force: true });
  }
});

test("notifications off: run_in_background runs in the foreground and says so", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-bg-project-"));
  process.env.FREECODE_TASK_NOTIFY = "0";
  try {
    const result = await AgentTool.execute(
      {
        task: "Find callers",
        prompt: "Find every caller",
        agentType: "bg-fake",
        run_in_background: true,
      },
      {
        sessionId: "root-fg",
        cwd: project,
        projectPath: project,
        hooks: createHookRuntime(),
      } as never,
    );
    assert.equal(result.success, true);
    const output = result.success ? result.result.output : "";
    assert.match(output, /Status: SUCCESS/, "the result came back inline");
    assert.match(output, /Ran in the foreground/);
  } finally {
    process.env.FREECODE_TASK_NOTIFY = "1";
    getAgentRegistry().disposeRoot("root-fg");
    rmSync(project, { recursive: true, force: true });
  }
});

test("the notification carries status, summary and result", () => {
  const text = formatTaskNotification({
    taskId: "a1",
    kind: "agent",
    status: "failed",
    summary: "Run evals",
    result: "boom",
  });
  assert.match(text, /<task-id>a1<\/task-id>/);
  assert.match(text, /<status>failed<\/status>/);
  assert.match(text, /<summary>Run evals<\/summary>/);
  assert.match(text, /boom/);
});

test("the env flag beats the settings files; default is on", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-notify-settings-"));
  try {
    assert.equal(taskNotificationsEnabled(dir, {}), true);
    assert.equal(taskNotificationsEnabled(dir, { FREECODE_TASK_NOTIFY: "0" }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a subagent runs on the parent run's model, not the provider default", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-bg-project-"));
  const { createSessionStore } = await import("../session/store.js");
  try {
    const result = await AgentTool.execute(
      { task: "t", prompt: "p" },
      {
        sessionId: "root-model",
        cwd: project,
        projectPath: project,
        provider: "bg-fake",
        model: "fake-model-x",
        hooks: createHookRuntime(),
      } as never,
    );
    assert.equal(result.success, true);
    const id = result.success ? String(result.result.metadata?.subagentId) : "";
    const store = await createSessionStore(join(home, ".freecode"));
    const meta = await store.getMeta(id, project);
    assert.equal(meta?.provider, "bg-fake");
    assert.equal(meta?.model, "fake-model-x");
  } finally {
    getAgentRegistry().disposeRoot("root-model");
    rmSync(project, { recursive: true, force: true });
  }
});
