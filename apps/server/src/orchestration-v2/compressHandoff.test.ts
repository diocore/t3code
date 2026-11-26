import {
  MessageId,
  PlanId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCompressHandoffText,
  compressWorkingSet,
  fitCompressHandoffText,
} from "./compressHandoff.ts";

const at = DateTime.makeUnsafe(0);
const summary = {
  goal: "Ship /compress.",
  userRequests: ["Keep auth working"],
  decisions: [],
  constraints: [],
  filesTouched: [],
  openTodos: [],
  currentState: "Phase 2.",
  unresolvedErrors: [],
};
const emptyWorkingSet = { files: [], plan: null, openSteps: [] };
const run = (ordinal: number, text = `work ${ordinal}`) => ({ ordinal, text: `[USER]\n${text}` });

const base = {
  threadId: "thread-1",
  summary,
  summaryThrough: 4,
  firstRunOrdinal: 1,
  mandatoryTail: [run(5)],
  recencyRuns: [run(3), run(4)],
  workingSet: { files: ["src/a.ts"], plan: null, openSteps: ["Write tests"] },
  focus: "keep auth",
};

const built = (input: Partial<Parameters<typeof buildCompressHandoffText>[0]> = {}) => {
  const result = buildCompressHandoffText({ ...base, ...input });
  if ("overflow" in result) throw new Error(`overflow: ${result.overflow}`);
  return result;
};

const item = (
  ordinal: number,
  fields: Record<string, unknown> & { readonly type: OrchestrationV2TurnItem["type"] },
) =>
  ({
    id: TurnItemId.make(`item-${ordinal}`),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    ...fields,
  }) as OrchestrationV2TurnItem;

describe("buildCompressHandoffText", () => {
  it("orders header, focus, summary, recent runs and working set", () => {
    const { text, preview, coveredRunOrdinals } = built();
    const order = [
      "This is a fresh session continuing T3 thread thread-1",
      "User's priority for this compress: keep auth",
      "## Summary (through run 4)\n### Goal\nShip /compress.",
      "## Recent runs\n=== RUN 3 ===",
      "=== RUN 5 ===",
      "## Working set\nFiles:\n- src/a.ts",
    ].map((marker) => text.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((left, right) => left - right));
    expect(text).toContain('t3_thread_read({threadId:"thread-1"');
    expect(preview).toBe(
      "### Goal\nShip /compress.\n\n### User requests\n- Keep auth working\n\n### Current state\nPhase 2.",
    );
    expect(coveredRunOrdinals).toEqual({ from: 1, to: 5 });
  });

  it("leaves the focus note out without a focus and the summary out without one", () => {
    const { text, preview } = built({ focus: "  ", summary: null, summaryThrough: null });
    expect(text).not.toContain("User's priority");
    expect(text).not.toContain("## Summary");
    expect(text).toContain("## Recent runs");
    expect(preview).toBe("");
  });

  it("drops optional recent runs oldest first before the mandatory tail", () => {
    const { text } = built({
      recencyRuns: [run(3, "a".repeat(20_000)), run(4, "b".repeat(10_000))],
      mandatoryTail: [run(5, "c".repeat(15_000))],
    });
    expect(text).not.toContain("=== RUN 3 ===");
    expect(text).toContain("=== RUN 4 ===");
    expect(text).toContain("=== RUN 5 ===");
  });

  it("keeps the working set within its budget", () => {
    const { text } = built({
      workingSet: {
        files: Array.from({ length: 30 }, (_, index) => `src/${"d".repeat(400)}/${index}.ts`),
        plan: "p".repeat(1_500),
        openSteps: ["Write tests"],
      },
    });
    const workingSet = text.slice(text.indexOf("## Working set"));
    expect(Buffer.byteLength(workingSet)).toBeLessThanOrEqual(8_000 + "## Working set\n".length);
    expect(workingSet).toContain("Open plan steps:\n- Write tests");
  });

  it.each([
    ["summary", { summary: { ...summary, goal: "g".repeat(48_001) } }],
    ["tail", { mandatoryTail: [run(5, "t".repeat(32_001))] }],
    ["empty", { summary: null, summaryThrough: null, mandatoryTail: [] }],
  ] as const)("fails before any swap when the %s alone does not fit", (overflow, input) => {
    expect(buildCompressHandoffText({ ...base, ...input })).toEqual({ overflow });
  });
});

describe("fitCompressHandoffText", () => {
  const { text } = built({
    summary: { ...summary, currentState: "s".repeat(4_000) },
    recencyRuns: [run(3, "r".repeat(4_000))],
    workingSet: { files: ["src/a.ts"], plan: "plan", openSteps: [] },
  });
  const delivered = (fitted: string) => Buffer.byteLength(JSON.stringify(fitted));

  it("returns the text whole when it fits", () => {
    expect(fitCompressHandoffText(text, delivered(text))).toBe(text);
  });

  it("drops the working set first", () => {
    const fitted = fitCompressHandoffText(text, delivered(text) - 1);
    expect(fitted).not.toContain("## Working set");
    expect(fitted).toContain("## Recent runs");
  });

  it("then drops the recent runs, keeping the summary whole", () => {
    const fitted = fitCompressHandoffText(text, delivered(text) - 4_000);
    expect(fitted).not.toContain("## Recent runs");
    expect(fitted).toContain("s".repeat(4_000));
    expect(fitted).not.toContain("truncated");
  });

  it("then truncates the summary with a marker, never past the budget", () => {
    const fitted = fitCompressHandoffText(text, 2_000);
    expect(delivered(fitted)).toBeLessThanOrEqual(2_000);
    expect(fitted).toContain("## Summary (through run 4)");
    expect(fitted).toMatch(
      /Summary truncated to fit this session; read earlier history with t3_thread_read\.\]$/u,
    );
  });

  it.each([0, 1, 100])("keeps the opening and the marker at budget %i", (budget) => {
    const fitted = fitCompressHandoffText(text, budget);
    expect(fitted.startsWith("This is a fresh session continuing T3 thread thread-1.")).toBe(true);
    expect(fitted).toContain("Summary truncated");
    expect(fitted).not.toContain("## Summary");
  });
});

describe("compressWorkingSet", () => {
  it("lists unique files newest first, the latest plan head and open todo steps", () => {
    const workingSet = compressWorkingSet([
      item(1, { type: "file_change", fileName: "old.ts" }),
      item(2, {
        type: "file_change",
        fileName: "ignored.ts",
        changes: [{ operation: "update", path: "src/a.ts" }],
      }),
      item(3, { type: "dynamic_tool", toolName: "Read", input: { file_path: "src/b.ts" } }),
      item(4, { type: "dynamic_tool", toolName: "Bash", input: { file_path: "nope.ts" } }),
      item(5, { type: "dynamic_tool", toolName: "Edit", input: { file_path: "src/a.ts" } }),
      item(6, { type: "proposed_plan", planId: PlanId.make("plan-1"), markdown: "old plan" }),
      item(7, {
        type: "proposed_plan",
        planId: PlanId.make("plan-2"),
        markdown: "x".repeat(2_000),
      }),
      item(8, {
        type: "todo_list",
        planId: PlanId.make("todo-1"),
        steps: [
          { id: "1", text: "Done", status: "completed" },
          { id: "2", text: "Doing", status: "running" },
          { id: "3", text: "Next", status: "pending" },
        ],
      }),
      item(9, {
        type: "user_message",
        messageId: MessageId.make("message-1"),
        inputIntent: "turn_start",
        text: "hi",
        attachments: [],
      }),
    ]);
    expect(workingSet).toEqual({
      files: ["src/a.ts", "src/b.ts", "old.ts"],
      plan: "x".repeat(1_500),
      openSteps: ["Doing", "Next"],
    });
  });

  it("is empty without file, plan or todo items", () => {
    expect(compressWorkingSet([])).toEqual(emptyWorkingSet);
  });
});
