// =============================================================================
// agent-fold tests — the payload mappers, then the bus round-trip against a
// fake bridge (a loopback HTTP server found through port.json, as in prod).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  permissionToPayload,
  questionToPayload,
  registerAgentFold,
  replyToAnswers,
  replyToDecision,
} from "./agent-fold.js";
import {
  askPermission,
  askQuestion,
  answerQuestion,
  BusEvents,
} from "../../bus/index.js";

const session = { cwd: "/home/me/proj", title: "Fix the parser" };

// --- mappers -----------------------------------------------------------------

test("a permission carries the session, request id, and only the displayed detail", () => {
  const payload = permissionToPayload(
    {
      type: "permission.asked",
      requestId: "r1",
      sessionId: "s1",
      toolName: "bash",
      args: { command: "rm -rf build", env: { SECRET: "x" } },
      description: "rm -rf build",
    },
    session,
  );
  assert.deepEqual(payload, {
    session_id: "s1",
    cwd: "/home/me/proj",
    session_title: "Fix the parser",
    hook_event_name: "PermissionRequest",
    request_id: "r1",
    tool_name: "bash",
    tool_input: { command: "rm -rf build", description: "rm -rf build" },
  });
});

test("long permission detail is capped", () => {
  const payload = permissionToPayload(
    {
      type: "permission.asked",
      requestId: "r1",
      sessionId: "s1",
      toolName: "write",
      args: { path: `/p/${"a".repeat(1000)}` },
      description: "write",
    },
    null,
  );
  const detail = payload.tool_input as Record<string, string>;
  assert.equal(detail.file_path?.length, 320);
  assert.equal(payload.cwd, undefined);
});

test("questions keep headers, options, and multi-select", () => {
  const payload = questionToPayload(
    {
      type: "question.asked",
      requestId: "q1",
      sessionId: "s1",
      questions: [
        {
          question: "Which?",
          header: "Pick",
          multiple: true,
          options: [
            { label: "A", description: "first" },
            { label: "B", description: "" },
          ],
        },
      ],
    },
    session,
  );
  assert.deepEqual(payload.questions, [
    {
      question: "Which?",
      header: "Pick",
      options: [{ label: "A", description: "first" }, { label: "B" }],
      multiple: true,
    },
  ]);
});

test("only an explicit allow or deny is a decision", () => {
  const reply = (behavior: string) => ({
    hookSpecificOutput: { decision: { behavior } },
  });
  assert.equal(replyToDecision(reply("allow")), "allow");
  assert.equal(replyToDecision(reply("deny")), "deny");
  assert.equal(replyToDecision(reply("unchanged")), null);
  assert.equal(replyToDecision({}), null);
  assert.equal(replyToDecision(undefined), null);
});

test("label arrays become one answer string per question", () => {
  assert.deepEqual(replyToAnswers({ answers: [["A", "B"], ["x"]] }, 2), [
    "A, B",
    "x",
  ]);
  assert.equal(replyToAnswers({ answers: [["A"]] }, 2), null);
  assert.equal(replyToAnswers({ answers: [[1]] }, 1), null);
  assert.equal(replyToAnswers({}, 1), null);
});

// --- bus round-trip ------------------------------------------------------------

test("the bar answers questions and permissions; pane answers and turn ends are reported", async () => {
  const received: Array<{ path: string; body: Record<string, unknown> }> = [];
  const replies: Record<string, unknown> = {
    "/v1/providers/omacode/question": { answers: [["Red", "Blue"]] },
    "/v1/providers/omacode/permission": {
      hookSpecificOutput: { decision: { behavior: "deny" } },
    },
  };
  // A path left out of `replies` is held open until the test answers it in
  // the pane — the bridge's behaviour while the user has not picked yet.
  const held: Array<() => void> = [];
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    assert.equal(req.headers["x-agent-fold-token"], "tok");
    received.push({ path: req.url ?? "", body });
    const reply = replies[req.url ?? ""];
    const send = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply ?? { ok: true }));
    };
    if (reply === undefined && req.url?.endsWith("/question")) held.push(send);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dataDir = await mkdtemp(join(tmpdir(), "agent-fold-omacode-"));
  const { port } = server.address() as AddressInfo;
  await writeFile(join(dataDir, "port.json"), JSON.stringify({ port, token: "tok" }));
  process.env.AGENT_FOLD_DATA_DIR = dataDir;

  try {
    const integration = registerAgentFold({
      describe: async () => session,
      lastAssistantText: async () => "Refactor done. All tests pass.",
    });

    const answers = await askQuestion(
      "q1",
      [{ question: "Colors?", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }], multiple: true }],
      "s1",
    );
    assert.deepEqual(answers, ["Red, Blue"]);

    const verdict = await askPermission("p1", {
      sessionId: "s1",
      toolName: "bash",
      args: { command: "ls" },
      description: "ls",
    });
    assert.deepEqual(verdict, { decision: "deny" });

    // Answered in the pane while the bar is still showing it: the bar is told.
    delete replies["/v1/providers/omacode/question"];
    const pending = askQuestion("q2", [{ question: "Go?", options: [{ label: "Yes", description: "" }] }], "s1");
    await waitUntil(() => held.length === 1);
    answerQuestion("q2", ["Yes"]);
    assert.deepEqual(await pending, ["Yes"]);
    await waitUntil(() => received.some((r) => r.path.endsWith("/question/resolved")));
    assert.deepEqual(
      received.find((r) => r.path.endsWith("/question/resolved"))?.body,
      { session_id: "s1", request_id: "q2" },
    );
    held.forEach((release) => release());

    integration.turnStarted("s1");
    BusEvents.stream("s1", { type: "done", content: "Done" });
    BusEvents.stream("s2", { type: "done", content: "Interrupted" });
    BusEvents.sessionError("s3", "boom");
    BusEvents.stream("s3", { type: "done", content: "boom" });
    await waitUntil(() => received.some((r) => r.path.endsWith("/stop")));
    await waitUntil(() => received.filter((r) => r.path.endsWith("/resume")).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stops = received.filter((r) => r.path.endsWith("/stop"));
    assert.equal(stops.length, 1, "a failed turn is not reported as finished");
    assert.deepEqual(stops[0]?.body, {
      session_id: "s1",
      cwd: "/home/me/proj",
      session_title: "Fix the parser",
      hook_event_name: "Stop",
      last_assistant_message: "Refactor done. All tests pass.",
    });
    assert.deepEqual(
      received.filter((r) => r.path.endsWith("/resume")).map((r) => r.body.session_id).sort(),
      ["s1", "s2"],
    );
  } finally {
    delete process.env.AGENT_FOLD_DATA_DIR;
    server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("without a running bridge nothing is sent and the pane still answers", async () => {
  process.env.AGENT_FOLD_DATA_DIR = join(tmpdir(), "agent-fold-missing");
  try {
    registerAgentFold({
      describe: async () => session,
      lastAssistantText: async () => null,
    });
    const pending = askQuestion("q-alone", [{ question: "Go?", options: [] }], "s1");
    answerQuestion("q-alone", ["yes"]);
    assert.deepEqual(await pending, ["yes"]);
  } finally {
    delete process.env.AGENT_FOLD_DATA_DIR;
  }
});

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  return body;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition never became true");
}
