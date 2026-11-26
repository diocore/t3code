import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProviderThreadId,
  RunId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import { estimateTextTokens } from "@t3tools/provider-core/server/handoffBudget";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as ServerSettings from "../serverSettings.ts";

import { contextBoundaryOrdinal } from "./contextBoundary.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RollingSummaryService from "./RollingSummaryService.ts";
import * as ThreadCompactionService from "./ThreadCompactionService.ts";
import {
  compactionItem,
  firstTurnThenCompress,
  runScenario,
  type Scenario,
  type ScenarioContext,
} from "./testkit/CompressScenario.ts";
import { CODEX_MODEL_SELECTION } from "./testkit/fixtures/shared.ts";

describe("ThreadCompactionService", () => {
  it.live("starts a compress run without a provider turn or a boundary move", () =>
    runScenario({ name: "start", threadId: ThreadId.make("thread:compress-start") }, (context) =>
      Effect.gen(function* () {
        yield* context.send("first");
        const before = yield* context.settle();
        const turnsBefore = (yield* Ref.get(context.capturedTurns)).length;
        const { runId } = yield* context.compaction.compress(before.thread.id, {
          focus: "keep the auth flow",
        });
        const after = yield* context.projection();
        const run = after.runs.find((candidate) => candidate.id === runId);
        assert.deepInclude(run, { status: "preparing", compress: true, startedAt: null });
        assert.equal(ProjectionStore.threadShellFromProjection(after).activityRunStatus, "running");
        assert.isUndefined(run?.freshContext);
        assert.deepInclude(compactionItem(after), {
          status: "running",
          method: "compress",
          beforeTokenCount: 90_000,
        });
        assert.include(
          after.messages.find((message) => message.id === run?.userMessageId)?.text,
          "/compress keep the auth flow",
        );
        assert.equal(contextBoundaryOrdinal(after), contextBoundaryOrdinal(before));
        assert.lengthOf(yield* Ref.get(context.capturedTurns), turnsBefore);
      }),
    ),
  );

  it.live("completes a compress into a fresh session carrying a summary handoff", () =>
    Effect.gen(function* () {
      const context = yield* firstTurnThenCompress(
        {
          name: "complete",
          threadId: ThreadId.make("thread:compress-complete"),
        },
        (started) => started.settle().pipe(Effect.map((after) => ({ ...started, after }))),
      );
      const { before, after, compressed } = context;
      const run = after.runs.find((candidate) => candidate.id === compressed.runId)!;
      assert.equal(run.status, "completed");
      assert.isTrue(run.freshContext);
      assert.isNotNull(run.startedAt);
      assert.equal(contextBoundaryOrdinal(after), run.ordinal);
      const fresh = after.providerThreads.find(
        (providerThread) => providerThread.id === run.providerThreadId,
      )!;
      assert.equal(after.thread.activeProviderThreadId, fresh.id);
      assert.isNull(fresh.nativeThreadRef);
      assert.notEqual(fresh.id, before.thread.activeProviderThreadId);
      const handoff = after.contextHandoffs.find((candidate) => candidate.targetRunId === run.id)!;
      assert.deepInclude(handoff, {
        strategy: "manual_context",
        status: "ready",
        compressedSummary: true,
        toProviderThreadId: fresh.id,
        transferId: null,
      });
      assert.deepEqual(handoff.fromProviderThreadIds, [before.thread.activeProviderThreadId!]);
      assert.include(handoff.summaryText, "User's priority for this compress: keep the auth flow");
      assert.include(handoff.summaryText, "### Goal\nthrough the long answer");
      assert.deepInclude(compactionItem(after), { status: "completed", method: "compress" });
      // The fresh session carries the old session's system prompt and tools again, not just the summary.
      assert.isAbove(compactionItem(after)?.afterTokenCount ?? 0, 90_000);
      assert.isFalse(after.turnItems.some((item) => item.type === "handoff"));
      const previousSessionId = before.providerThreads.find(
        (providerThread) => providerThread.id === before.thread.activeProviderThreadId,
      )?.providerSessionId;
      assert.isFalse(after.providerSessions.some((session) => session.id === previousSessionId));
      assert.isFalse(after.messages.some((message) => message.text.trim() === "/compact"));
    }),
  );

  it.live("counts the smallest context across every session, not the summary-seeded one", () =>
    firstTurnThenCompress(
      {
        name: "thread-wide-baseline",
        threadId: ThreadId.make("thread:compress-thread-wide-baseline"),
        tokenUsageByRunOrdinal: {
          1: { usedTokens: 40_000, maxTokens: 200_000 },
          3: { usedTokens: 90_000, maxTokens: 200_000 },
        },
      },
      ({ settle, send, compaction, capturedTurns }) =>
        Effect.gen(function* () {
          const afterFirstCompress = yield* settle();
          yield* send("second");
          yield* settle();
          const secondTurn = (yield* Ref.get(capturedTurns)).at(-1)!;
          assert.equal(secondTurn.runOrdinal, 3);
          assert.equal(
            secondTurn.providerThreadId,
            afterFirstCompress.thread.activeProviderThreadId,
          );
          const { runId } = yield* compaction.compress(afterFirstCompress.thread.id);
          const after = yield* settle();
          assert.deepEqual(
            after.providerTurns
              .filter((turn) => turn.providerThreadId === secondTurn.providerThreadId)
              .map((turn) => turn.tokenUsage?.usedTokens),
            [90_000],
          );
          const handoff = after.contextHandoffs.find(
            (candidate) => candidate.targetRunId === runId,
          )!;
          const secondCompaction = after.turnItems.find(
            (item) => item.type === "compaction" && item.runId === runId,
          );
          assert.deepInclude(secondCompaction, {
            status: "completed",
            afterTokenCount: estimateTextTokens(handoff.summaryText) + 40_000,
          });
          const conversationTurn = after.providerTurns[0]!;
          const conversationProviderThread = after.providerThreads.find(
            (candidate) => candidate.id === conversationTurn.providerThreadId,
          )!;
          const subagentProviderThread = {
            ...conversationProviderThread,
            id: ProviderThreadId.make(`${conversationTurn.providerThreadId}:subagent`),
            ownerNodeId: conversationTurn.nodeId,
          };
          assert.equal(
            Orchestrator.sessionBaselineTokens(
              {
                ...after,
                providerThreads: [...after.providerThreads, subagentProviderThread],
                providerTurns: [
                  ...after.providerTurns,
                  {
                    ...conversationTurn,
                    providerThreadId: subagentProviderThread.id,
                    tokenUsage: { ...conversationTurn.tokenUsage!, usedTokens: 5_000 },
                  },
                ],
              },
              conversationProviderThread,
            ),
            40_000,
          );
        }),
    ),
  );

  describe("never moves the boundary", () => {
    const assertUnchanged = (
      before: OrchestrationV2ThreadProjection,
      after: OrchestrationV2ThreadProjection,
      runId: string,
      itemStatus: "failed" | "cancelled",
    ) => {
      const run = after.runs.find((candidate) => candidate.id === runId)!;
      assert.deepInclude(run, { status: "cancelled", startedAt: null });
      assert.isUndefined(run.freshContext);
      assert.equal(compactionItem(after)?.status, itemStatus);
      assert.equal(contextBoundaryOrdinal(after), contextBoundaryOrdinal(before));
      assert.equal(after.thread.activeProviderThreadId, before.thread.activeProviderThreadId);
      assert.isFalse(after.contextHandoffs.some((handoff) => handoff.compressedSummary === true));
    };

    it.live(
      "when the summary fails: a manual failure notice, and a queued message on the old session",
      () =>
        firstTurnThenCompress(
          {
            name: "summary-fails",
            threadId: ThreadId.make("thread:compress-summary-fails"),
            summarize: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: "generateContextSummary",
                  detail: "Claude usage limit reached.",
                }),
              ),
          },
          ({ before, compressed, send, settle, capturedTurns }) =>
            Effect.gen(function* () {
              yield* send("queued");
              const queued = (yield* settle()).runs.at(-1)!;
              assert.notEqual(queued.id, compressed.runId);
              const after = yield* settle();
              assertUnchanged(before, after, compressed.runId, "failed");
              const notice = after.turnItems.find((item) => item.type === "system_notice");
              assert.deepInclude(notice, { level: "error" });
              assert.include(notice?.type === "system_notice" ? notice.message : "", "/compact");
              assert.isFalse(after.messages.some((message) => message.text.trim() === "/compact"));
              const ordinals = after.turnItems.map((item) => item.ordinal);
              assert.equal(new Set(ordinals).size, ordinals.length);
              const turns = yield* Ref.get(capturedTurns);
              assert.equal(turns.at(-1)?.text, "Prompt queued");
              assert.equal(turns.at(-1)?.nativeThreadId, turns[0]?.nativeThreadId);
            }),
        ),
    );

    it.live.each(["run.interrupt", "thread.stop"] as const)(
      "when %s lands while the summary runs, and interrupts it",
      (stop) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const interrupted = yield* Deferred.make<void>();
          return yield* firstTurnThenCompress(
            {
              name: `stopped-${stop}`,
              threadId: ThreadId.make(`thread:compress-stopped-${stop}`),
              summarize: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                ),
            },
            ({ before, compressed, worker, orchestrator, projection }) =>
              Effect.gen(function* () {
                const draining = yield* worker.drain().pipe(Effect.forkChild);
                yield* Deferred.await(started);
                yield* orchestrator.dispatch(
                  stop === "run.interrupt"
                    ? {
                        type: "run.interrupt",
                        commandId: CommandId.make(`command:compress:stop:${stop}`),
                        threadId: before.thread.id,
                        runId: compressed.runId,
                      }
                    : {
                        type: "thread.stop",
                        commandId: CommandId.make(`command:compress:stop:${stop}`),
                        threadId: before.thread.id,
                      },
                );
                yield* Deferred.await(interrupted);
                yield* Fiber.join(draining);
                assertUnchanged(before, yield* projection(), compressed.runId, "cancelled");
              }),
          );
        }),
    );

    it.live("when the thread is archived while the summary is pending", () =>
      firstTurnThenCompress(
        {
          name: "archived",
          threadId: ThreadId.make("thread:compress-archived"),
        },
        ({ before, compressed, orchestrator, worker, projection }) =>
          Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "thread.archive",
              commandId: CommandId.make("command:compress:archive"),
              threadId: before.thread.id,
            });
            yield* worker.drain();
            const after = yield* projection();
            assert.equal(
              after.runs.find((run) => run.id === compressed.runId)?.status,
              "cancelled",
            );
            assert.equal(compactionItem(after)?.status, "cancelled");
            assert.isFalse(
              after.contextHandoffs.some((handoff) => handoff.compressedSummary === true),
            );
          }),
      ),
    );

    it.live("when background work appears before the swap commits", () =>
      firstTurnThenCompress(
        {
          name: "late-background",
          threadId: ThreadId.make("thread:compress-late-background"),
        },
        ({ before, compressed, backgroundWork, settle }) =>
          Effect.gen(function* () {
            yield* Ref.set(backgroundWork, true);
            const after = yield* settle();
            assertUnchanged(before, after, compressed.runId, "failed");
            const notice = after.turnItems.find((item) => item.type === "system_notice");
            assert.include(notice?.type === "system_notice" ? notice.message : "", "/compact");
          }),
      ),
    );
  });

  it.live("queues a steer aimed at a compress run, then starts it on the fresh session", () =>
    firstTurnThenCompress(
      { name: "steer", threadId: ThreadId.make("thread:compress-steer") },
      ({ before, compressed, orchestrator, settle, capturedTurns, projection }) =>
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:compress:steer"),
            threadId: before.thread.id,
            messageId: MessageId.make("message:compress:steer"),
            text: "Prompt steer",
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId: compressed.runId },
          });
          assert.equal((yield* projection()).runs.at(-1)?.status, "queued");
          yield* settle();
          const [first, steer] = yield* Ref.get(capturedTurns);
          assert.notEqual(steer?.nativeThreadId, first?.nativeThreadId);
          assert.include(steer?.text, "User message:\nPrompt steer");
        }),
    ),
  );

  it.live("leaves a deleted thread's compress run cancelled, and its effect settles", () =>
    firstTurnThenCompress(
      { name: "deleted", threadId: ThreadId.make("thread:compress-deleted") },
      ({ before, compressed, orchestrator, worker }) =>
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("command:compress:delete"),
            threadId: before.thread.id,
          });
          yield* worker.drain();
          const { runs } = yield* orchestrator.getThreadRecords(before.thread.id, ["runs"]);
          assert.equal(runs.find((run) => run.id === compressed.runId)?.status, "cancelled");
          assert.equal(yield* worker.drain(), 0);
        }),
    ),
  );

  describe("refuses", () => {
    const refusal = <E>(
      scenario: Scenario,
      prepare: (context: ScenarioContext) => Effect.Effect<unknown, E>,
      options: ThreadCompactionService.CompressOptions = {},
    ) =>
      runScenario(scenario, (context) =>
        Effect.gen(function* () {
          yield* prepare(context);
          return yield* Effect.flip(context.compaction.compress(scenario.threadId, options));
        }),
      );

    it.live("an active run as busy", () =>
      refusal({ name: "busy", threadId: ThreadId.make("thread:compress-busy") }, (context) =>
        Effect.gen(function* () {
          yield* context.send("first");
          yield* context.settle();
          yield* context.compaction.compress(ThreadId.make("thread:compress-busy"));
        }),
      ).pipe(
        Effect.map((error) => {
          assert.equal(error.reason, "busy");
        }),
      ),
    );

    it.live("background work, naming /compact", () =>
      refusal(
        {
          name: "background",
          threadId: ThreadId.make("thread:compress-background"),
          backgroundWork: true,
        },
        (context) =>
          Effect.gen(function* () {
            yield* context.send("first");
            yield* context.settle();
          }),
      ).pipe(
        Effect.map((error) => {
          assert.equal(error.reason, "background-work");
          assert.include(error.message, "/compact");
        }),
      ),
    );

    it.live("a non-Claude thread as unsupported", () =>
      refusal(
        {
          name: "codex",
          threadId: ThreadId.make("thread:compress-codex"),
          modelSelection: CODEX_MODEL_SELECTION,
        },
        (context) =>
          Effect.gen(function* () {
            yield* context.send("first");
            yield* context.settle();
          }),
      ).pipe(
        Effect.map((error) => {
          assert.equal(error.reason, "unsupported");
        }),
      ),
    );

    it.live("a thread with no session yet as unsupported", () =>
      refusal(
        { name: "nothing", threadId: ThreadId.make("thread:compress-nothing") },
        () => Effect.void,
      ).pipe(
        Effect.map((error) => {
          assert.equal(error.reason, "unsupported");
        }),
      ),
    );

    it.live("a second compress right after the first as nothing to compress", () =>
      refusal(
        { name: "twice-empty", threadId: ThreadId.make("thread:compress-twice-empty") },
        (context) =>
          Effect.gen(function* () {
            yield* context.send("first");
            yield* context.settle();
            yield* context.compaction.compress(ThreadId.make("thread:compress-twice-empty"));
            yield* context.settle();
          }),
      ).pipe(
        Effect.map((error) => {
          assert.equal(error.reason, "nothing-to-compress");
        }),
      ),
    );

    it.live("an automatic compress that is not due", () =>
      refusal(
        { name: "not-due", threadId: ThreadId.make("thread:compress-not-due"), autoCompress: true },
        (context) =>
          Effect.gen(function* () {
            yield* context.send("first");
            yield* context.settle();
          }),
        { trigger: "automatic" },
      ).pipe(
        Effect.map((error) => {
          assert.equal(error.reason, "not-due");
        }),
      ),
    );
  });

  it.live(
    "compresses at turn end past 70% of Claude's compaction point, with a warning failure",
    () =>
      runScenario(
        {
          name: "turn-end",
          threadId: ThreadId.make("thread:compress-turn-end"),
          autoCompress: true,
          tokenUsageByRunOrdinal: { 1: { usedTokens: 150_000, maxTokens: 200_000 } },
          summarize: () =>
            Effect.fail(
              new TextGenerationError({ operation: "generateContextSummary", detail: "down" }),
            ),
        },
        (context) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* context.compaction.start();
              yield* context.send("first");
              yield* context.settle();
              const compressRun = yield* context.waitUntil((current) =>
                current.runs.some((run) => run.compress === true),
              );
              const run = compressRun.runs.find((candidate) => candidate.compress === true)!;
              const message = compressRun.messages.find((entry) => entry.id === run.userMessageId);
              assert.deepInclude(message, { createdBy: "agent", creationSource: "server" });
              const after = yield* context.settle();
              const notice = after.turnItems.find((item) => item.type === "system_notice");
              assert.deepInclude(notice, { level: "warning" });
              assert.isFalse(after.messages.some((entry) => entry.text.trim() === "/compact"));
            }),
          ),
      ).pipe(Effect.scoped),
  );
});

describe("ThreadCompactionService with a scripted orchestrator", () => {
  const threadId = ThreadId.make("thread:compress-scripted");
  const runId = RunId.make("run:compress-scripted");
  const providerThreadId = ProviderThreadId.make("provider-thread:compress-scripted");

  const scripted = (input: {
    readonly autoCompress: boolean;
    readonly usedTokens: number;
    readonly preparing?: Ref.Ref<boolean>;
    readonly failDispatch?: boolean;
  }) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const checked = yield* Queue.unbounded<void>();
      const dispatched: Array<string> = [];
      const warnings: Array<unknown> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (...args) => {
            end(...args);
            if (span.name === "ThreadCompactionService.compressAtTurnEnd")
              Queue.offerUnsafe(checked, undefined);
          };
          return span;
        },
      });
      const preparing = input.preparing ?? (yield* Ref.make(true));
      const records = Effect.gen(function* () {
        return {
          runs: [
            {
              id: runId,
              ordinal: 2,
              status: (yield* Ref.get(preparing)) ? "preparing" : "cancelled",
              compress: true,
              startedAt: null,
              completedAt: null,
              userMessageId: MessageId.make("message:compress-scripted"),
            },
          ],
          messages: [],
          providerTurns: [
            {
              providerThreadId,
              tokenUsage: {
                usedTokens: input.usedTokens,
                maxTokens: 200_000,
                updatedAt: "2026-11-26T10:00:00.000Z",
              },
            },
          ],
        } as never;
      });
      const context = yield* Layer.build(
        ThreadCompactionService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({
                streamDomainEvents: Stream.fromQueue(events),
                dispatch: (command) =>
                  Effect.suspend(() => {
                    dispatched.push(command.type);
                    return input.failDispatch === true
                      ? Effect.fail(
                          new Orchestrator.OrchestratorDispatchError({
                            commandId: command.commandId,
                            commandType: command.type,
                          }),
                        )
                      : Effect.succeed({
                          sequence: 1,
                          storedEvents: [
                            {
                              sequence: 1,
                              commandId: command.commandId,
                              event: { type: "run.created", payload: { id: runId } },
                            },
                          ],
                        } as never);
                  }),
              }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThread: () =>
                  Effect.succeed({
                    id: threadId,
                    providerInstanceId: "claudeAgent",
                    activeProviderThreadId: providerThreadId,
                    lineage: { relationshipToParent: null },
                  } as never),
                getThreadRecords: () => records,
              }),
              ServerSettings.layerTest({ autoCompress: input.autoCompress }),
              Layer.mock(RollingSummaryService.RollingSummaryService)({
                compressSnapshot: (id) =>
                  Effect.fail(
                    new RollingSummaryService.RollingSummaryBudgetError({
                      threadId: id,
                      priorSummaryChars: 1,
                    }),
                  ),
              }),
              NodeCrypto.layer,
              Logger.layer(
                [
                  Logger.make((entry) => {
                    if (entry.logLevel === "Warn") warnings.push(entry.message);
                  }),
                ],
                { mergeWithExisting: false },
              ),
            ),
          ),
        ),
      );
      const service = Context.get(context, ThreadCompactionService.ThreadCompactionService);
      yield* service.start().pipe(Effect.withTracer(tracer));
      const completed: OrchestrationV2DomainEvent = {
        id: EventId.make("event:compress-scripted"),
        type: "run.updated",
        threadId,
        runId: RunId.make("run:completed"),
        occurredAt: DateTime.makeUnsafe(0),
        payload: { id: RunId.make("run:completed"), status: "completed" } as never,
      };
      return {
        service,
        dispatched,
        warnings,
        preparing,
        completeTurn: Queue.offer(events, completed).pipe(Effect.andThen(Queue.take(checked))),
      };
    });

  it.effect.each([
    {
      name: "below 70% of the compaction point",
      autoCompress: true,
      usedTokens: 100_000,
      starts: 0,
    },
    { name: "with auto-compress off", autoCompress: false, usedTokens: 150_000, starts: 0 },
    { name: "at 70% of the compaction point", autoCompress: true, usedTokens: 150_000, starts: 1 },
  ])("turn end $name starts $starts compress runs", ({ autoCompress, usedTokens, starts }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* scripted({ autoCompress, usedTokens });
        yield* test.completeTurn;
        assert.lengthOf(
          test.dispatched.filter((type) => type === "thread.compress.start"),
          starts,
        );
      }),
    ),
  );

  it.effect("failure keeps retrying the fail command while the run holds the queue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* scripted({ autoCompress: false, usedTokens: 0, failDispatch: true });
        const running = yield* test.service
          .executeCompress({ threadId, runId })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust("2 seconds");
        yield* TestClock.adjust("4 seconds");
        const attempts = test.dispatched.filter((type) => type === "thread.compress.fail").length;
        assert.isAtLeast(attempts, 3);
        yield* Ref.set(test.preparing, false);
        yield* TestClock.adjust("30 seconds");
        yield* Fiber.join(running);
        assert.deepEqual(test.warnings, []);
      }),
    ),
  );
});
