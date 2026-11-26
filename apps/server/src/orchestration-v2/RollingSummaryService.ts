import {
  isListedThreadLineage,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
  type ServerSettingsError,
  type TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import {
  type ContextSummarySections,
  renderSummaryRun,
} from "@t3tools/provider-core/server/contextSummary";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { ThreadContextSummaryRepositoryError } from "../persistence/Errors.ts";
import * as ThreadContextSummaries from "../persistence/ThreadContextSummaries.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import {
  buildContextSummaryPrompt,
  formatPriorSummary,
} from "../textGeneration/contextSummaryPrompt.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { contextBoundaryOrdinal, isScheduledFreshRun } from "./contextBoundary.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";
import {
  calibrateCharsPerToken,
  INITIAL_CHARS_PER_TOKEN,
  type PendingRun,
  planSummaryChunks,
  PROMPT_WARNING_TOKENS,
  renderedChars,
} from "./rollingSummaryChunks.ts";

// Below this a cold re-read is cheap, so a summary is not worth its quota yet.
const MIN_CONTEXT_TOKENS = 80_000;
const BACKGROUND_CHUNK_TOKENS = 30_000;

export class RollingSummaryBudgetError extends Schema.TaggedError<RollingSummaryBudgetError>()(
  "RollingSummaryBudgetError",
  {
    threadId: ThreadId,
    priorSummaryChars: Schema.Int,
  },
) {
  override get message(): string {
    return "The rolling summary is too large to extend within one summary request.";
  }
}

export type RollingSummaryError =
  | RollingSummaryBudgetError
  | TextGenerationError
  | ThreadContextSummaryRepositoryError
  | ProjectionStore.ProjectionStoreV2Error
  | ServerSettingsError;

type SummaryRecords = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "turnItems" | "providerThreads" | "providerTurns"
>;

/** Whether background summarizing applies to this thread at all, before reading its history. */
function backgroundSummaryEnabled(
  settings: ServerSettings,
  thread: OrchestrationV2AppThread,
  nowMs: number,
): boolean {
  const claudeInstance = Object.hasOwn(settings.providerInstances, thread.providerInstanceId)
    ? settings.providerInstances[thread.providerInstanceId]?.driver === "claudeAgent"
    : thread.providerInstanceId === "claudeAgent";
  if (
    !claudeInstance ||
    !settings.autoCompress ||
    !resolveProjectProviderInstanceEnabled(settings, thread.projectId, thread.providerInstanceId)
  )
    return false;
  if (thread.deletedAt !== null || thread.archivedAt !== null) return false;
  if (thread.settledAt !== null || thread.settledOverride === "settled") return false;
  if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
    return false;
  return isListedThreadLineage(thread.lineage);
}

/** Whether the live context is large enough for a summary to be worth its quota. */
function contextLargeEnoughToSummarize({
  thread,
  providerThreads,
  providerTurns,
}: Pick<SummaryRecords, "thread" | "providerThreads" | "providerTurns">): boolean {
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  const latestUsage = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread?.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  return (latestUsage?.usedTokens ?? 0) >= MIN_CONTEXT_TOKENS;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** The chain carries across a /compress, whose fresh session is seeded from it; /clear ends it. */
export function summaryChainBoundary(records: Pick<SummaryRecords, "runs" | "turnItems">): number {
  return contextBoundaryOrdinal({
    runs: records.runs.filter((run) => run.compress !== true),
    turnItems: records.turnItems,
  });
}

/**
 * Finished runs after `afterOrdinal`, rendered, up to the first run still in flight. Rolled-back
 * runs and runs cancelled before they started never reached the session, and a scheduled
 * fresh-session run is a side conversation, so they are skipped.
 */
function unsummarizedRuns(records: SummaryRecords, afterOrdinal: number) {
  const pending: Array<
    PendingRun & { readonly providerThreadId: OrchestrationV2Run["providerThreadId"] }
  > = [];
  for (const run of records.runs.toSorted((left, right) => left.ordinal - right.ordinal)) {
    if (run.ordinal <= afterOrdinal || run.compress === true) continue;
    if (ACTIVE_RUN_STATUSES.has(run.status)) break;
    if (
      run.status === "rolled_back" ||
      cancelledBeforeStart(run) ||
      isScheduledFreshRun(run, records.turnItems)
    )
      continue;
    const text = renderSummaryRun(records.turnItems.filter((item) => item.runId === run.id));
    if (text.length > 0)
      pending.push({ ordinal: run.ordinal, text, providerThreadId: run.providerThreadId });
  }
  return pending;
}

/**
 * The earliest run that makes this link stale: a run rolled back after the link was written, or
 * its last run when that run is gone.
 */
function staleFrom(
  row: ThreadContextSummaries.ThreadContextSummary,
  runs: SummaryRecords["runs"],
): number | undefined {
  const createdAtMs = DateTime.toEpochMillis(row.createdAt);
  const ordinals = runs
    .filter(
      (run) =>
        run.status === "rolled_back" &&
        run.ordinal <= row.toRunOrdinal &&
        run.completedAt !== null &&
        DateTime.toEpochMillis(run.completedAt) >= createdAtMs,
    )
    .map((run) => run.ordinal);
  if (!runs.some((run) => run.ordinal === row.toRunOrdinal)) ordinals.push(row.toRunOrdinal);
  return ordinals.length === 0 ? undefined : Math.min(...ordinals);
}

export class RollingSummaryService extends Context.Service<
  RollingSummaryService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Summarizes every finished run not yet covered, then returns the current summary. */
    readonly catchUp: (threadId: ThreadId) => Effect.Effect<
      {
        readonly summary: ContextSummarySections;
        readonly toRunOrdinal: number;
      } | null,
      RollingSummaryError
    >;
    /**
     * Summarizes the unsummarized runs only when they exceed `keepTailTokens`, then returns the
     * summary and the runs it does not cover, rendered.
     */
    readonly compressSnapshot: (
      threadId: ThreadId,
      options: { readonly keepTailTokens: number },
    ) => Effect.Effect<
      {
        readonly summary: ContextSummarySections | null;
        readonly summaryThrough: number | null;
        readonly tail: ReadonlyArray<{ readonly ordinal: number; readonly text: string }>;
      },
      RollingSummaryError
    >;
  }
>()("t3/orchestration-v2/RollingSummaryService") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const repository = yield* ThreadContextSummaries.ThreadContextSummaryRepository;

  let charsPerToken = INITIAL_CHARS_PER_TOKEN;
  // One summarizer, invalidation or deletion per thread at a time, so a chain never forks.
  const lanes = new Map<ThreadId, Semaphore.Semaphore>();
  const lane = (threadId: ThreadId) => {
    const existing = lanes.get(threadId);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    lanes.set(threadId, created);
    return created;
  };

  const readContext = Effect.fn("RollingSummaryService.readContext")(function* (
    thread: OrchestrationV2AppThread,
  ) {
    const activeProviderThreadIds =
      thread.activeProviderThreadId === null ? [] : [thread.activeProviderThreadId];
    const records = yield* projections.getThreadRecords(
      thread.id,
      ["runs", "providerThreads", "providerTurns"],
      {
        providerThreadIds: activeProviderThreadIds,
        providerTurnThreadIds: activeProviderThreadIds,
        latestProviderTurnUsageOnly: true,
      },
    );
    return { ...records, thread };
  });

  // Rollbacks while the worker was not listening leave links that cover a rolled-back run.
  const latestCurrentLink = Effect.fn("RollingSummaryService.latestCurrentLink")(function* (
    threadId: ThreadId,
    runs: SummaryRecords["runs"],
  ) {
    while (true) {
      const latest = yield* repository.latest(threadId);
      const invalidFrom = Option.isNone(latest) ? undefined : staleFrom(latest.value, runs);
      if (invalidFrom === undefined) return latest;
      yield* repository.invalidateFrom(threadId, invalidFrom);
    }
  });

  const withTurnItems = Effect.fn("RollingSummaryService.withTurnItems")(function* (
    context: Omit<SummaryRecords, "turnItems">,
  ) {
    const latest = yield* latestCurrentLink(context.thread.id, context.runs);
    const afterOrdinal = Option.match(latest, {
      onNone: () => 0,
      onSome: (row) => row.toRunOrdinal,
    });
    const runIds = context.runs
      .filter((run) => run.ordinal > afterOrdinal || run.freshContext === true)
      .map((run) => run.id);
    const { turnItems } =
      runIds.length === 0
        ? { turnItems: [] }
        : yield* projections.getThreadRecords(context.thread.id, ["turnItems"], {
            turnItemRunIds: runIds,
          });
    return { ...context, turnItems } satisfies SummaryRecords;
  });

  const validLatest = Effect.fn("RollingSummaryService.validLatest")(function* (
    threadId: ThreadId,
    records: SummaryRecords,
  ) {
    const boundary = summaryChainBoundary(records);
    const latest = yield* latestCurrentLink(threadId, records.runs);
    // A link from before the current context boundary belongs to a conversation that ended.
    return Option.filter(latest, (row) => row.toRunOrdinal >= boundary);
  });

  const summarizePending = Effect.fn("RollingSummaryService.summarizePending")(function* (
    threadId: ThreadId,
    input: {
      readonly settings: ServerSettings;
      readonly records: SummaryRecords;
      readonly minTokens: number;
    },
  ) {
    const boundary = summaryChainBoundary(input.records);
    const prior = yield* validLatest(threadId, input.records);
    const afterOrdinal = Option.match(prior, {
      onNone: () => Math.max(0, boundary - 1),
      onSome: (row) => row.toRunOrdinal,
    });
    const pending = unsummarizedRuns(input.records, afterOrdinal);
    const pendingChars = renderedChars(pending);
    if (pendingChars === 0 || pendingChars < input.minTokens * charsPerToken) return;

    const modelSelection = input.settings.compactionSummaryModelSelection;
    let summary = Option.match(prior, { onNone: () => null, onSome: (row) => row.summary });
    let remaining: ReadonlyArray<PendingRun> = pending;
    let usage = { promptTokens: 0, outputTokens: 0 };
    while (remaining.length > 0) {
      const priorSummaryChars = formatPriorSummary(summary).length;
      const [chunk] = planSummaryChunks({ runs: remaining, priorSummaryChars, charsPerToken });
      if (chunk === undefined)
        return yield* new RollingSummaryBudgetError({ threadId, priorSummaryChars });
      const request = {
        priorSummary: summary,
        transcript: chunk.transcript,
        firstRunOrdinal: chunk.firstRunOrdinal,
        lastRunOrdinal: chunk.lastRunOrdinal,
      };
      const result = yield* textGeneration.generateContextSummary({ ...request, modelSelection });
      const perRequestTokens = result.usage.promptTokens / Math.max(1, result.usage.turns);
      if (perRequestTokens > PROMPT_WARNING_TOKENS)
        yield* Effect.logWarning("rolling summary request exceeded its prompt budget", {
          threadId,
          perRequestTokens,
          charsPerToken,
        });
      charsPerToken = calibrateCharsPerToken(charsPerToken, {
        promptChars: buildContextSummaryPrompt(request).length,
        promptTokens: result.usage.promptTokens,
        turns: result.usage.turns,
      });
      summary = result.sections;
      usage = {
        promptTokens: usage.promptTokens + result.usage.promptTokens,
        outputTokens: usage.outputTokens + result.usage.outputTokens,
      };
      let consumed = remaining;
      for (const piece of chunk.pieces) {
        const [head, ...rest] = consumed;
        consumed =
          head !== undefined && head.text.length > piece.text.length
            ? [{ ordinal: head.ordinal, text: head.text.slice(piece.text.length) }, ...rest]
            : rest;
      }
      remaining = consumed;
      // A run split across chunks is recorded once its last piece is in.
      if (!chunk.completesLastRun) continue;
      yield* repository.insert({
        threadId,
        providerThreadId:
          pending.find((run) => run.ordinal === chunk.lastRunOrdinal)?.providerThreadId ?? null,
        toRunOrdinal: chunk.lastRunOrdinal,
        summary,
        summaryChars: formatPriorSummary(summary).length,
        model: modelSelection.model,
        promptTokens: usage.promptTokens,
        outputTokens: usage.outputTokens,
        createdAt: yield* DateTime.now,
      });
      usage = { promptTokens: 0, outputTokens: 0 };
    }
  });

  const summarizeInBackground = Effect.fn("RollingSummaryService.summarizeInBackground")(
    function* (threadId: ThreadId, minTokens: number) {
      const settings = yield* serverSettings.getSettings;
      const thread = yield* projections.findThread(threadId);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (thread === null || !backgroundSummaryEnabled(settings, thread, nowMs)) return;
      const context = yield* readContext(thread);
      if (!contextLargeEnoughToSummarize(context)) return;
      const records = yield* withTurnItems(context);
      yield* summarizePending(threadId, { settings, records, minTokens });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) => Effect.logWarning("rolling summary skipped", { threadId, cause })),
      ),
  );

  const catchUp: RollingSummaryService["Service"]["catchUp"] = Effect.fn(
    "RollingSummaryService.catchUp",
  )(function* (threadId) {
    return yield* lane(threadId).withPermits(1)(
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const thread = yield* projections.getThread(threadId);
        const records = yield* withTurnItems(yield* readContext(thread));
        yield* summarizePending(threadId, { settings, records, minTokens: 0 });
        return Option.match(yield* validLatest(threadId, records), {
          onNone: () => null,
          onSome: (row) => ({ summary: row.summary, toRunOrdinal: row.toRunOrdinal }),
        });
      }),
    );
  });

  const compressSnapshot: RollingSummaryService["Service"]["compressSnapshot"] = Effect.fn(
    "RollingSummaryService.compressSnapshot",
  )(function* (threadId, { keepTailTokens }) {
    return yield* lane(threadId).withPermits(1)(
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const thread = yield* projections.getThread(threadId);
        const records = yield* withTurnItems(yield* readContext(thread));
        yield* summarizePending(threadId, { settings, records, minTokens: keepTailTokens });
        const latest = Option.getOrUndefined(yield* validLatest(threadId, records));
        const tail = unsummarizedRuns(
          records,
          latest?.toRunOrdinal ?? Math.max(0, summaryChainBoundary(records) - 1),
        ).map(({ ordinal, text }) => ({ ordinal, text }));
        return {
          summary: latest?.summary ?? null,
          summaryThrough: latest?.toRunOrdinal ?? null,
          tail,
        };
      }),
    );
  });

  const start = Effect.fn("RollingSummaryService.start")(function* () {
    const workers = yield* FiberSet.make();
    // Keyed by thread: a newer completed run restarts the idle wait.
    const idleTimers = yield* FiberMap.make<ThreadId>();
    // The waiting request per thread, by its minimum size; one waiter re-checks for them all.
    const queued = new Map<ThreadId, number>();

    const requestSummary = (threadId: ThreadId, minTokens: number) =>
      Effect.suspend(() => {
        const waiting = queued.get(threadId);
        queued.set(threadId, Math.min(waiting ?? Number.POSITIVE_INFINITY, minTokens));
        if (waiting !== undefined) return Effect.void;
        return FiberSet.run(
          workers,
          lane(threadId).withPermits(1)(
            Effect.suspend(() => {
              const requested = queued.get(threadId) ?? minTokens;
              queued.delete(threadId);
              return summarizeInBackground(threadId, requested);
            }),
          ),
        ).pipe(Effect.asVoid);
      });

    const onLane = (threadId: ThreadId, effect: Effect.Effect<void, RollingSummaryError>) =>
      FiberSet.run(
        workers,
        lane(threadId)
          .withPermits(1)(effect)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("rolling summary invalidation failed", { threadId, cause }),
            ),
          ),
      ).pipe(Effect.asVoid);

    const armIdleTail = (threadId: ThreadId) =>
      serverSettings.getSettings.pipe(
        Effect.flatMap((settings) =>
          FiberMap.run(
            idleTimers,
            threadId,
            // Hands off to the summarizer, so restarting this wait never cancels a summary.
            Effect.sleep(Duration.minutes(settings.compressIdleMinutes)).pipe(
              Effect.andThen(requestSummary(threadId, 0)),
            ),
          ),
        ),
        Effect.asVoid,
        Effect.catch((cause) => Effect.logWarning("rolling summary idle wait skipped", { cause })),
      );

    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (event.type === "run.updated" && event.payload.status === "completed")
          return armIdleTail(event.threadId).pipe(
            Effect.andThen(requestSummary(event.threadId, BACKGROUND_CHUNK_TOKENS)),
          );
        if (event.type === "run.updated" && event.payload.status === "rolled_back")
          return onLane(
            event.threadId,
            repository.invalidateFrom(event.threadId, event.payload.ordinal),
          );
        if (event.type === "thread.deleted")
          return FiberMap.remove(idleTimers, event.threadId).pipe(
            Effect.andThen(
              onLane(
                event.threadId,
                repository
                  .deleteThread(event.threadId)
                  .pipe(Effect.ensuring(Effect.sync(() => lanes.delete(event.threadId)))),
              ),
            ),
          );
        return Effect.void;
      }),
    );
  });

  return RollingSummaryService.of({ start, catchUp, compressSnapshot });
});

export const layer = Layer.effect(RollingSummaryService, make);
