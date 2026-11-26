import {
  MessageId,
  type OrchestrationV2TurnItem,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  renderContextSummaryMarkdown,
  renderSummaryRun,
  renderSummaryTranscript,
} from "./contextSummary.ts";

const now = DateTime.makeUnsafe("2026-11-26T00:00:00.000Z");
let nextOrdinal = 0;
const base = () => {
  nextOrdinal += 1;
  return {
    id: TurnItemId.make(`item:${nextOrdinal}`),
    threadId: ThreadId.make("thread:summary"),
    runId: RunId.make("run:1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: nextOrdinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
};

describe("renderSummaryRun", () => {
  it("keeps messages and question answers whole, drops reasoning, trims commands and diffs", () => {
    const longAnswer = `Use the staging cluster. ${"detail ".repeat(400)}Not local Redpanda.`;
    const items: ReadonlyArray<OrchestrationV2TurnItem> = [
      {
        ...base(),
        type: "user_message",
        messageId: MessageId.make("message:1"),
        inputIntent: "turn_start",
        text: "Speed up the consumer",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      { ...base(), type: "reasoning", text: "secret chain of thought", streaming: false },
      {
        ...base(),
        type: "dynamic_tool",
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Where do reports go? Local Redpanda?" }] },
        output: { answers: { "Where do reports go? Local Redpanda?": longAnswer } },
      },
      {
        ...base(),
        type: "user_input_request",
        requestId: RuntimeRequestId.make("request:1"),
        questions: [
          {
            id: "q0",
            header: "Reports",
            question: "Where do reports go? Local Redpanda?",
            options: [{ label: "Staging", description: "staging cluster" }],
          },
          {
            id: "q1",
            header: "Install",
            question: "Where should the UI live?",
            options: [
              { label: "~/.local/bin", description: "standalone", value: "1" },
              { label: "repo", description: "in repo", value: "2" },
            ],
          },
        ],
        questionAnswer: {
          requestId: "request:1",
          answers: { q0: "Staging", q1: "1", q1_other: "and add a symlink" },
          attachmentsByQuestionId: {},
        },
      },
      {
        ...base(),
        type: "command_execution",
        input: "pnpm test",
        output: `${"a".repeat(1000)}TAIL`,
        exitCode: 1,
      },
      {
        ...base(),
        type: "file_change",
        fileName: "src/consumer.ts",
        diffStr: "--- a/src/consumer.ts\n+++ b/src/consumer.ts\n@@ -1,3 +1,4 @@\n-old\n+new line",
      },
      {
        ...base(),
        type: "assistant_message",
        messageId: MessageId.make("message:2"),
        text: "Done.",
        streaming: false,
      },
    ];

    const rendered = renderSummaryRun(items);

    expect(rendered).toContain("[USER]\nSpeed up the consumer");
    expect(rendered).not.toContain("secret chain of thought");
    expect(rendered).toContain(
      `[AGENT ASKED] Where do reports go? Local Redpanda?\n[USER ANSWERED] ${longAnswer}`,
    );
    expect(rendered.match(/Local Redpanda\?/g)).toHaveLength(1);
    expect(rendered).toContain(
      "[AGENT ASKED] Install: Where should the UI live?\n[USER ANSWERED] ~/.local/bin; and add a symlink",
    );
    expect(rendered).toContain("[CMD exit=1] pnpm test\n");
    expect(rendered).toContain("chars omitted");
    expect(rendered).toContain("TAIL");
    expect(rendered).not.toContain("a".repeat(400));
    expect(rendered).toContain("[EDIT src/consumer.ts] @@ -1,3 +1,4 @@");
    expect(rendered).not.toContain("+new line");
    expect(rendered.endsWith("[ASSISTANT]\nDone.")).toBe(true);
  });

  it("keeps a long command line to its head", () => {
    const rendered = renderSummaryRun([
      { ...base(), type: "command_execution", input: `echo ${"x".repeat(1000)}`, exitCode: 0 },
    ]);
    expect(rendered.length).toBeLessThan(400);
  });
});

describe("renderSummaryTranscript", () => {
  it("heads each run with its ordinal", () => {
    expect(
      renderSummaryTranscript([
        { ordinal: 3, text: "a" },
        { ordinal: 4, text: "b" },
      ]),
    ).toBe("=== RUN 3 ===\na\n\n=== RUN 4 ===\nb");
  });
});

describe("renderContextSummaryMarkdown", () => {
  it("renders non-empty sections in order, lists as bullets and prose as paragraphs", () => {
    expect(
      renderContextSummaryMarkdown({
        goal: " Ship /compress. ",
        userRequests: ["Keep auth"],
        decisions: [],
        constraints: ["No sleeps in tests", "Bytes, not tokens"],
        filesTouched: [],
        openTodos: [],
        currentState: "Phase 2 in progress.",
        unresolvedErrors: [],
      }),
    ).toBe(
      [
        "### Goal\nShip /compress.",
        "### User requests\n- Keep auth",
        "### Constraints\n- No sleeps in tests\n- Bytes, not tokens",
        "### Current state\nPhase 2 in progress.",
      ].join("\n\n"),
    );
  });
});
