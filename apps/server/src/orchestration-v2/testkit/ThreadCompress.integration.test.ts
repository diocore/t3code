import { assert, describe, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { contextBoundaryOrdinal } from "../contextBoundary.ts";
import { firstTurnThenCompress } from "./CompressScenario.ts";
import { CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";

const OPENING = "This is a fresh session continuing T3 thread";
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("ThreadCompress integration", () => {
  it.live("delivers the compress once, on a new native thread", () =>
    firstTurnThenCompress(
      { name: "delivers", threadId: ThreadId.make("thread:compress-delivers") },
      (context) =>
        Effect.gen(function* () {
          yield* context.settle();
          yield* context.send("second");
          yield* context.settle();
          yield* context.send("third");
          const after = yield* context.settle();
          const [first, second, third] = yield* Ref.get(context.capturedTurns);
          assert.notEqual(second?.nativeThreadId, first?.nativeThreadId);
          assert.equal(occurrences(second?.text ?? "", OPENING), 1);
          assert.include(second?.text, "User's priority for this compress: keep the auth flow");
          assert.include(second?.text, "### Goal\nthrough the long answer");
          assert.include(second?.text, "User message:\nPrompt second");
          assert.equal(third?.text, "Prompt third");
          assert.equal(third?.nativeThreadId, second?.nativeThreadId);
          const handoff = after.contextHandoffs.find((entry) => entry.compressedSummary === true);
          assert.deepInclude(handoff?.delivery, {
            status: "inline",
            nativeThreadId: second?.nativeThreadId ?? "",
          });
        }),
    ),
  );

  describe("undo", () => {
    it.live("restores the old session, and the next send resumes it without the summary", () =>
      firstTurnThenCompress(
        { name: "undo", threadId: ThreadId.make("thread:compress-undo") },
        (context) =>
          Effect.gen(function* () {
            yield* context.settle();
            yield* context.compaction.undoCompress(context.before.thread.id);
            const undone = yield* context.projection();
            assert.deepInclude(
              undone.runs.find((run) => run.id === context.compressed.runId),
              { status: "cancelled", startedAt: null },
            );
            assert.equal(contextBoundaryOrdinal(undone), contextBoundaryOrdinal(context.before));
            assert.equal(
              undone.thread.activeProviderThreadId,
              context.before.thread.activeProviderThreadId,
            );
            assert.equal(
              undone.contextHandoffs.find((entry) => entry.compressedSummary === true)?.status,
              "superseded",
            );
            yield* context.send("second");
            yield* context.settle();
            const [first, second] = yield* Ref.get(context.capturedTurns);
            assert.equal(second?.nativeThreadId, first?.nativeThreadId);
            assert.equal(second?.text, "Prompt second");
          }),
      ),
    );

    it.live("refuses once a send has reached the fresh session", () =>
      firstTurnThenCompress(
        { name: "undo-late", threadId: ThreadId.make("thread:compress-undo-late") },
        (context) =>
          Effect.gen(function* () {
            yield* context.settle();
            yield* context.send("second");
            yield* context.settle();
            const refused = yield* Effect.flip(
              context.compaction.undoCompress(context.before.thread.id),
            );
            assert.equal(refused.reason, "not-undoable");
          }),
      ),
    );
  });

  describe("keeps the compress", () => {
    it.live("after the native resume falls back to a fresh session", () =>
      firstTurnThenCompress(
        { name: "fallback", threadId: ThreadId.make("thread:compress-fallback") },
        (context) =>
          Effect.gen(function* () {
            yield* context.settle();
            yield* context.send("second");
            const delivered = yield* context.settle();
            // A new session resumes the native thread; this one fails to.
            const sessionId = delivered.providerThreads.find(
              (providerThread) => providerThread.id === delivered.thread.activeProviderThreadId,
            )?.providerSessionId;
            assert.isDefined(sessionId);
            yield* context.orchestrator.dispatch({
              type: "provider-session.detach",
              commandId: CommandId.make("command:compress:fallback:detach"),
              threadId: delivered.thread.id,
              providerSessionId: sessionId!,
            });
            yield* Ref.set(context.failResumeOnce, true);
            yield* context.send("third");
            yield* context.settle();
            const turns = yield* Ref.get(context.capturedTurns);
            const [, second, third] = turns;
            assert.isFalse(yield* Ref.get(context.failResumeOnce));
            assert.notEqual(third?.nativeThreadId, second?.nativeThreadId);
            assert.equal(occurrences(third?.text ?? "", OPENING), 1);
            assert.include(third?.text, "### Goal\nthrough the long answer");
          }),
      ),
    );

    it.live("after a switch to Codex, within its 64 KB cap", () =>
      firstTurnThenCompress(
        { name: "codex-switch", threadId: ThreadId.make("thread:compress-codex-switch") },
        (context) =>
          Effect.gen(function* () {
            yield* context.settle();
            yield* context.send("second", { modelSelection: CODEX_MODEL_SELECTION });
            yield* context.settle();
            const codexTurn = (yield* Ref.get(context.capturedTurns)).at(-1);
            assert.equal(codexTurn?.driver, "codex");
            assert.include(codexTurn?.text, OPENING);
            assert.include(codexTurn?.text, "User message:\nPrompt second");
            assert.isAtMost(Buffer.byteLength(codexTurn?.text ?? ""), 64_000);
          }),
      ),
    );
  });

  it.live("lands a message queued during the compress on the fresh session, with the summary", () =>
    firstTurnThenCompress(
      { name: "queued", threadId: ThreadId.make("thread:compress-queued") },
      (context) =>
        Effect.gen(function* () {
          yield* context.send("queued");
          yield* context.settle();
          const [first, queued] = yield* Ref.get(context.capturedTurns);
          assert.notEqual(queued?.nativeThreadId, first?.nativeThreadId);
          assert.include(queued?.text, OPENING);
          assert.include(queued?.text, "User message:\nPrompt queued");
        }),
    ),
  );

  it.live("compresses twice, carrying the earlier summary and every run since", () =>
    firstTurnThenCompress(
      { name: "twice", threadId: ThreadId.make("thread:compress-twice") },
      (context) =>
        Effect.gen(function* () {
          yield* context.settle();
          yield* context.send("second");
          yield* context.settle();
          yield* context.compaction.compress(context.before.thread.id);
          yield* context.settle();
          yield* context.send("third");
          yield* context.settle();
          const third = (yield* Ref.get(context.capturedTurns)).at(-1);
          assert.equal(occurrences(third?.text ?? "", OPENING), 1);
          assert.include(third?.text, "### Goal\nthrough the long answer");
          assert.include(third?.text, "## Recent runs");
          assert.include(third?.text, "[USER]\nPrompt second");
          assert.notInclude(third?.text, "User's priority for this compress");
        }),
    ),
  );

  describe("a summary over the default 16 KB handoff cap", () => {
    const goal = `Keep advisory locks. ${"g".repeat(30_000)}`;
    const largeSummary = () =>
      Effect.succeed({
        sections: {
          goal,
          userRequests: [],
          decisions: [],
          constraints: [],
          filesTouched: [],
          openTodos: [],
          currentState: "",
          unresolvedErrors: [],
        },
        usage: { promptTokens: 10_000, outputTokens: 8_000, turns: 1 },
      });

    it.live("arrives whole in Claude's fresh session", () =>
      firstTurnThenCompress(
        {
          name: "large-claude",
          threadId: ThreadId.make("thread:compress-large-claude"),
          summarize: largeSummary,
        },
        (context) =>
          Effect.gen(function* () {
            yield* context.settle();
            yield* context.send("second");
            yield* context.settle();
            const second = (yield* Ref.get(context.capturedTurns)).at(-1);
            assert.include(second?.text, goal);
            assert.notInclude(second?.text, "Summary truncated");
          }),
      ),
    );

    it.live("is truncated with a marker for Codex, within its cap", () =>
      firstTurnThenCompress(
        {
          name: "large-codex",
          threadId: ThreadId.make("thread:compress-large-codex"),
          summarize: largeSummary,
        },
        (context) =>
          Effect.gen(function* () {
            yield* context.settle();
            yield* context.send("second", { modelSelection: CODEX_MODEL_SELECTION });
            yield* context.settle();
            const codexTurn = (yield* Ref.get(context.capturedTurns)).at(-1);
            assert.equal(codexTurn?.driver, "codex");
            assert.include(codexTurn?.text, OPENING);
            assert.include(codexTurn?.text, "Summary truncated to fit this session");
            assert.isAtMost(Buffer.byteLength(codexTurn?.text ?? ""), 64_000);
          }),
      ),
    );
  });
});
