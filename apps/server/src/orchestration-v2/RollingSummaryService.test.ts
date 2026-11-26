import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ScheduledTaskId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type {
  ContextSummaryGenerationInput,
  ContextSummaryGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadContextSummaries from "../persistence/ThreadContextSummaries.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RollingSummaryService from "./RollingSummaryService.ts";

const threadId = ThreadId.make("summary-thread");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-opus-5-5" };
const at = DateTime.makeUnsafe(0);

type Records = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "turnItems" | "providerThreads" | "providerTurns"
>;

function records(input: {
  readonly runChars: ReadonlyArray<number>;
  readonly usedTokens: number;
}): Records {
  const runs = input.runChars.map((_, index) => ({
    id: RunId.make(`run-${index + 1}`),
    threadId,
    ordinal: index + 1,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make(`message-${index + 1}`),
    rootNodeId: NodeId.make(`root-${index + 1}`),
    activeAttemptId: null,
    status: "completed" as const,
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    checkpointId: null,
    contextHandoffId: null,
  }));
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Long thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at,
      deletedAt: null,
    },
    runs,
    turnItems: runs.map((run, index) => ({
      id: TurnItemId.make(`item-${run.ordinal}`),
      threadId,
      runId: run.id,
      nodeId: null,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: run.ordinal,
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "user_message",
      messageId: run.userMessageId,
      inputIntent: "turn_start",
      text: `request ${run.ordinal} ${"x".repeat(input.runChars[index]!)}`,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    })),
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: NodeId.make("root-1"),
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: runs.length,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at,
        updatedAt: at,
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("provider-turn"),
        providerThreadId,
        nodeId: NodeId.make("root-1"),
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: runs.length,
        status: "completed",
        startedAt: at,
        completedAt: at,
        tokenUsage: { usedTokens: input.usedTokens, updatedAt: DateTime.formatIso(at) },
      },
    ],
  };
}

const sections = (goal: string) => ({
  goal,
  userRequests: [],
  decisions: [],
  constraints: [],
  filesTouched: [],
  openTodos: [],
  currentState: "",
  unresolvedErrors: [],
});

const runUpdated = (run: Records["runs"][number]): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event-${run.id}-${run.status}`),
  type: "run.updated",
  threadId,
  runId: run.id,
  occurredAt: at,
  payload: run,
});

const harness = Effect.fn("harness")(function* (input: {
  readonly data: Records;
  readonly autoCompress?: boolean;
  readonly summarize?: (
    request: ContextSummaryGenerationInput,
  ) => Effect.Effect<ContextSummaryGenerationResult, TextGenerationError>;
}) {
  const fixture = { data: input.data };
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const repositoryWrites = yield* Queue.unbounded<string>();
  const backgroundAttempts = yield* Queue.unbounded<void>();
  const calls: Array<ContextSummaryGenerationInput> = [];
  const warnings: Array<unknown> = [];
  const chunkLogs: Array<unknown> = [];
  let dispatches = 0;
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (...args) => {
        end(...args);
        if (span.name === "RollingSummaryService.summarizeInBackground")
          Queue.offerUnsafe(backgroundAttempts, undefined);
      };
      return span;
    },
  });
  const summarize =
    input.summarize ??
    ((request: ContextSummaryGenerationInput) =>
      Effect.succeed({
        sections: sections(`through ${request.lastRunOrdinal}`),
        usage: { promptTokens: 60_000, outputTokens: 6_000, turns: 2 },
      }));
  const repositoryLayer = Layer.effect(
    ThreadContextSummaries.ThreadContextSummaryRepository,
    Effect.gen(function* () {
      const real = yield* ThreadContextSummaries.ThreadContextSummaryRepository;
      return ThreadContextSummaries.ThreadContextSummaryRepository.of({
        ...real,
        insert: (row) =>
          real
            .insert(row)
            .pipe(Effect.tap(() => Queue.offer(repositoryWrites, `insert:${row.toRunOrdinal}`))),
        invalidateFrom: (thread, ordinal) =>
          real
            .invalidateFrom(thread, ordinal)
            .pipe(Effect.tap(() => Queue.offer(repositoryWrites, `invalidate:${ordinal}`))),
      });
    }),
  ).pipe(Layer.provide(ThreadContextSummaries.layer));
  const filterRecords = (filter: ProjectionStore.ProjectionRecordFilter | undefined) => ({
    ...fixture.data,
    turnItems: fixture.data.turnItems.filter(
      (item) => filter?.turnItemRunIds === undefined || filter.turnItemRunIds.includes(item.runId),
    ),
  });
  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromQueue(events),
      dispatch: () =>
        Effect.sync(() => {
          dispatches++;
          return { sequence: 1, storedEvents: [] };
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThread: () => Effect.sync(() => fixture.data.thread),
      findThread: () => Effect.sync(() => fixture.data.thread),
      getThreadRecords: (_threadId, _fields, filter) =>
        Effect.sync(() => filterRecords(filter) as never),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        autoCompress: input.autoCompress ?? true,
      }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateContextSummary: (request) =>
        Effect.suspend(() => {
          calls.push(request);
          return summarize(request);
        }),
    }),
    Logger.layer(
      [
        Logger.make((entry) => {
          if (entry.logLevel === "Warn") warnings.push(entry.message);
          if (
            entry.logLevel === "Info" &&
            Array.isArray(entry.message) &&
            entry.message[0] === "rolling summary chunk"
          )
            chunkLogs.push(entry.message[1]);
        }),
      ],
      {
        mergeWithExisting: false,
      },
    ),
  );
  const context = yield* Layer.build(
    RollingSummaryService.layer.pipe(
      Layer.provideMerge(repositoryLayer),
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provideMerge(dependencies),
    ),
  );
  const service = Context.get(context, RollingSummaryService.RollingSummaryService);
  const repository = Context.get(context, ThreadContextSummaries.ThreadContextSummaryRepository);
  yield* service.start().pipe(Effect.provide(context), Effect.withTracer(tracer));
  return {
    fixture,
    service,
    repository,
    calls,
    warnings,
    chunkLogs,
    dispatches: () => dispatches,
    send: (event: OrchestrationV2DomainEvent) => Queue.offer(events, event),
    nextWrite: Queue.take(repositoryWrites),
    nextBackgroundAttempt: Queue.take(backgroundAttempts),
  };
});

const longHistory = () => records({ runChars: [60_000, 60_000, 60_000], usedTokens: 100_000 });

/** Marks runs as a /compress (`compress`) or a /clear (`clear`) fresh-context run. */
function withFreshRuns(
  data: Records,
  fresh: Readonly<
    Record<number, { readonly kind: "compress" | "clear"; readonly status?: "preparing" }>
  >,
): Records {
  const byRunId = new Map(
    data.runs.flatMap((run) => (fresh[run.ordinal] ? [[run.id, fresh[run.ordinal]!]] : [])),
  );
  return {
    ...data,
    runs: data.runs.map((run) => {
      const mark = byRunId.get(run.id);
      if (mark === undefined) return run;
      return {
        ...run,
        freshContext: true,
        ...(mark.kind === "compress" ? { compress: true as const } : {}),
        ...(mark.status === "preparing"
          ? { status: "preparing" as const, startedAt: null, completedAt: null }
          : {}),
      };
    }),
    turnItems: data.turnItems.map((item) =>
      item.type === "user_message" && byRunId.get(item.runId!)?.kind === "compress"
        ? { ...item, freshContext: true, text: "/compress" }
        : item.type === "user_message" && byRunId.has(item.runId!)
          ? { ...item, freshContext: true }
          : item,
    ),
  };
}

const snapshotOrdinals = (snapshot: {
  readonly summaryThrough: number | null;
  readonly tail: ReadonlyArray<{ readonly ordinal: number }>;
}) => ({ summaryThrough: snapshot.summaryThrough, tail: snapshot.tail.map((run) => run.ordinal) });

describe("RollingSummaryService", () => {
  it.effect("summarizes long history chunk by chunk, each on the prior summary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* harness({ data: longHistory() });
        yield* test.send(runUpdated(test.fixture.data.runs[2]!));

        expect(yield* test.nextWrite).toBe("insert:2");
        expect(yield* test.nextWrite).toBe("insert:3");
        expect(
          test.calls.map(({ firstRunOrdinal, lastRunOrdinal, priorSummary }) => ({
            firstRunOrdinal,
            lastRunOrdinal,
            prior: priorSummary?.goal ?? null,
          })),
        ).toEqual([
          { firstRunOrdinal: 1, lastRunOrdinal: 2, prior: null },
          { firstRunOrdinal: 3, lastRunOrdinal: 3, prior: "through 2" },
        ]);
        const chunkUsage = {
          threadId,
          turns: 2,
          requests: 1,
          promptTokens: 60_000,
          outputTokens: 6_000,
          charsPerToken: expect.any(Number),
        };
        expect(test.chunkLogs).toEqual([
          { ...chunkUsage, firstRunOrdinal: 1, lastRunOrdinal: 2 },
          { ...chunkUsage, firstRunOrdinal: 3, lastRunOrdinal: 3 },
        ]);
        expect(test.warnings).toEqual([]);
        expect(test.calls[0]!.modelSelection.model).toBe("claude-haiku-5-5");
        expect(test.calls[0]!.transcript).toContain("=== RUN 2 ===\n[USER]\nrequest 2");
        const latest = Option.getOrThrow(yield* test.repository.latest(threadId));
        expect(latest).toMatchObject({ toRunOrdinal: 3, model: "claude-haiku-5-5" });
        expect(latest.summary.goal).toBe("through 3");
        expect(test.dispatches()).toBe(0);

        const rolledBack = { ...test.fixture.data.runs[2]!, status: "rolled_back" as const };
        test.fixture.data = {
          ...test.fixture.data,
          runs: [...test.fixture.data.runs.slice(0, 2), rolledBack],
        };
        yield* test.send(runUpdated(rolledBack));
        expect(yield* test.nextWrite).toBe("invalidate:3");
        expect(Option.getOrThrow(yield* test.repository.latest(threadId)).toRunOrdinal).toBe(2);
      }),
    ),
  );

  it.effect.each([
    { name: "below 80K context tokens", autoCompress: true, usedTokens: 79_999 },
    { name: "with automatic compress off", autoCompress: false, usedTokens: 100_000 },
  ] as const)("does no background work $name, but catchUp still summarizes", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* harness({
          data: records({ runChars: [60_000, 60_000, 60_000], usedTokens: scenario.usedTokens }),
          autoCompress: scenario.autoCompress,
        });
        yield* test.send(runUpdated(test.fixture.data.runs[2]!));
        yield* test.nextBackgroundAttempt;
        expect(test.calls).toHaveLength(0);

        const caughtUp = yield* test.service.catchUp(threadId);
        expect(caughtUp?.toRunOrdinal).toBe(3);
        expect(caughtUp?.summary.goal).toBe("through 3");
        expect(test.calls).toHaveLength(2);
      }),
    ),
  );

  it.effect("summarizes a small tail once the thread has been idle for compressIdleMinutes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* harness({ data: records({ runChars: [2_000], usedTokens: 100_000 }) });
        yield* test.send(runUpdated(test.fixture.data.runs[0]!));
        yield* test.nextBackgroundAttempt;
        expect(test.calls).toHaveLength(0);

        yield* TestClock.adjust("30 minutes");
        expect(yield* test.nextWrite).toBe("insert:1");
        expect(test.calls).toHaveLength(1);
      }),
    ),
  );

  it.effect("drops links that cover a run rolled back while no event arrived", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* harness({ data: longHistory() });
        expect((yield* test.service.catchUp(threadId))?.toRunOrdinal).toBe(3);
        expect(yield* test.nextWrite).toBe("insert:2");
        expect(yield* test.nextWrite).toBe("insert:3");

        yield* TestClock.adjust("1 minute");
        const [first, second, third] = test.fixture.data.runs;
        test.fixture.data = {
          ...test.fixture.data,
          runs: [
            first!,
            { ...second!, status: "rolled_back", completedAt: yield* DateTime.now },
            { ...third!, status: "rolled_back", completedAt: yield* DateTime.now },
          ],
        };
        const caughtUp = yield* test.service.catchUp(threadId);

        expect(yield* test.nextWrite).toBe("invalidate:2");
        expect(yield* test.nextWrite).toBe("insert:1");
        expect(caughtUp?.toRunOrdinal).toBe(1);
        expect(test.calls).toHaveLength(3);
        expect(test.calls[2]).toMatchObject({ firstRunOrdinal: 1, lastRunOrdinal: 1 });
      }),
    ),
  );

  it.effect("leaves scheduled fresh-session runs out of the summary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = records({ runChars: [100, 100, 100], usedTokens: 100_000 });
        const scheduledRunId = base.runs[1]!.id;
        const test = yield* harness({
          data: {
            ...base,
            runs: base.runs.map((run) =>
              run.id === scheduledRunId ? { ...run, freshContext: true } : run,
            ),
            turnItems: base.turnItems.map((item) =>
              item.runId === scheduledRunId && item.type === "user_message"
                ? { ...item, freshContext: true, scheduledTaskId: ScheduledTaskId.make("task") }
                : item,
            ),
          },
        });

        expect((yield* test.service.catchUp(threadId))?.toRunOrdinal).toBe(3);
        expect(test.calls).toHaveLength(1);
        expect(test.calls[0]!.transcript).toContain("=== RUN 1 ===");
        expect(test.calls[0]!.transcript).not.toContain("=== RUN 2 ===");
        expect(test.calls[0]!.transcript).toContain("=== RUN 3 ===");
      }),
    ),
  );

  it.effect.each([
    { turns: 2, promptTokens: 100_000, perRequestTokens: 100_000, isOverBudget: true },
    { turns: 3, promptTokens: 180_000, perRequestTokens: 90_000, isOverBudget: false },
  ])(
    "counts the structured-output turn as part of one request ($turns turns)",
    ({ turns, promptTokens, perRequestTokens, isOverBudget }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* harness({
            data: longHistory(),
            summarize: (request) =>
              Effect.succeed({
                sections: sections(`through ${request.lastRunOrdinal}`),
                usage: { promptTokens, outputTokens: 6_000, turns },
              }),
          });
          yield* test.send(runUpdated(test.fixture.data.runs[2]!));
          expect(yield* test.nextWrite).toBe("insert:2");
          expect(yield* test.nextWrite).toBe("insert:3");

          expect(test.chunkLogs).toContainEqual(
            expect.objectContaining({ turns, requests: turns - 1, promptTokens }),
          );
          expect(test.warnings).toEqual(
            isOverBudget
              ? Array.from({ length: 2 }, () => [
                  "rolling summary request exceeded its prompt budget",
                  { threadId, perRequestTokens, charsPerToken: expect.any(Number) },
                ])
              : [],
          );
        }),
      ),
  );

  it.effect("persists nothing and never compacts when the summary call fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = new TextGenerationError({
          operation: "generateContextSummary",
          detail: "Claude usage limit reached.",
        });
        const test = yield* harness({ data: longHistory(), summarize: () => Effect.fail(failure) });
        yield* test.send(runUpdated(test.fixture.data.runs[2]!));
        yield* test.nextBackgroundAttempt;

        expect(test.calls).toHaveLength(1);
        expect(test.warnings).toEqual([["rolling summary skipped", { threadId, cause: failure }]]);
        expect(yield* Effect.flip(test.service.catchUp(threadId))).toBe(failure);
        expect(Option.isNone(yield* test.repository.latest(threadId))).toBe(true);
        expect(test.dispatches()).toBe(0);
      }),
    ),
  );

  it.effect(
    "compressSnapshot keeps a tail under keepTailTokens verbatim without a summary call",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* harness({
            data: withFreshRuns(records({ runChars: [100, 100, 0], usedTokens: 100_000 }), {
              3: { kind: "compress", status: "preparing" },
            }),
          });
          const snapshot = yield* test.service.compressSnapshot(threadId, {
            keepTailTokens: 8_000,
          });

          expect(test.calls).toHaveLength(0);
          expect(snapshot.summary).toBeNull();
          expect(snapshotOrdinals(snapshot)).toEqual({ summaryThrough: null, tail: [1, 2] });
          expect(snapshot.tail[0]!.text).toContain("[USER]\nrequest 1");
        }),
      ),
  );

  it.effect("compressSnapshot summarizes a tail over keepTailTokens", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* harness({ data: longHistory() });
        const snapshot = yield* test.service.compressSnapshot(threadId, { keepTailTokens: 8_000 });

        expect(test.calls).toHaveLength(2);
        expect(snapshot.summary?.goal).toBe("through 3");
        expect(snapshotOrdinals(snapshot)).toEqual({ summaryThrough: 3, tail: [] });
      }),
    ),
  );

  it.effect("compressSnapshot twice covers every run before the second compress", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = records({ runChars: [100, 100, 0, 100, 20_000, 0], usedTokens: 100_000 });
        const test = yield* harness({
          data: withFreshRuns(
            { ...base, runs: base.runs.slice(0, 3) },
            { 3: { kind: "compress", status: "preparing" } },
          ),
        });
        const first = yield* test.service.compressSnapshot(threadId, { keepTailTokens: 8_000 });
        expect(snapshotOrdinals(first)).toEqual({ summaryThrough: null, tail: [1, 2] });

        test.fixture.data = withFreshRuns(base, {
          3: { kind: "compress" },
          6: { kind: "compress", status: "preparing" },
        });
        const second = yield* test.service.compressSnapshot(threadId, { keepTailTokens: 8_000 });

        expect(test.calls).toHaveLength(1);
        expect(test.calls[0]!.priorSummary).toBeNull();
        expect(test.calls[0]!.transcript).toContain("=== RUN 1 ===");
        expect(test.calls[0]!.transcript).toContain("=== RUN 2 ===");
        expect(test.calls[0]!.transcript).not.toContain("=== RUN 3 ===");
        expect(test.calls[0]!.transcript).toContain("=== RUN 5 ===");
        expect(snapshotOrdinals(second)).toEqual({ summaryThrough: 5, tail: [] });
      }),
    ),
  );

  it.effect("across a compress boundary the chain reuses its prior link; /clear resets it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = records({
          runChars: [60_000, 60_000, 60_000, 0, 60_000, 60_000, 60_000],
          usedTokens: 100_000,
        });
        const test = yield* harness({ data: { ...base, runs: base.runs.slice(0, 3) } });
        expect((yield* test.service.catchUp(threadId))?.toRunOrdinal).toBe(3);

        test.fixture.data = withFreshRuns(
          { ...base, runs: base.runs.slice(0, 5) },
          { 4: { kind: "compress" } },
        );
        expect((yield* test.service.catchUp(threadId))?.toRunOrdinal).toBe(5);
        expect(test.calls[2]).toMatchObject({ firstRunOrdinal: 5, lastRunOrdinal: 5 });
        expect(test.calls[2]!.priorSummary?.goal).toBe("through 3");

        test.fixture.data = withFreshRuns(base, { 4: { kind: "compress" }, 6: { kind: "clear" } });
        expect((yield* test.service.catchUp(threadId))?.toRunOrdinal).toBe(7);
        expect(test.calls[3]).toMatchObject({ firstRunOrdinal: 6, priorSummary: null });
      }),
    ),
  );
});
