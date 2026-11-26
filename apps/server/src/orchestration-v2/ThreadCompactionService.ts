import {
  CommandId,
  MessageId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  OrchestrationV2CompressThreadError,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { renderSummaryRun } from "@t3tools/provider-core/server/contextSummary";
import { estimateTextTokens } from "@t3tools/provider-core/server/handoffBudget";
import { autoCompressDue } from "@t3tools/shared/claudeCompaction";
import { parseCompressComposerCommand } from "@t3tools/shared/composerTrigger";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  buildCompressHandoffText,
  COMPRESS_TAIL_TOKENS,
  compressWorkingSet,
} from "./compressHandoff.ts";
import { contextBoundaryOrdinal, isScheduledFreshRun } from "./contextBoundary.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";
import * as RollingSummaryService from "./RollingSummaryService.ts";

const RECENCY_RUNS = 2;
const WORKING_SET_ITEM_TYPES = [
  "file_change",
  "dynamic_tool",
  "todo_list",
  "proposed_plan",
] as const;

export interface CompressOptions {
  readonly focus?: string | undefined;
  readonly trigger?: "manual" | "automatic" | undefined;
  readonly createdBy?: OrchestrationV2Actor | undefined;
  readonly creationSource?: OrchestrationV2CreationSource | undefined;
}

export class ThreadCompactionService extends Context.Service<
  ThreadCompactionService,
  {
    /** Starts a server-run /compress: a fresh session seeded with the thread's summary. */
    readonly compress: (
      threadId: ThreadId,
      options?: CompressOptions,
    ) => Effect.Effect<
      { readonly runId: RunId; readonly sequence: number },
      OrchestrationV2CompressThreadError
    >;
    /** Restores the session a compress replaced, before anything reached the fresh one. */
    readonly undoCompress: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationV2CompressThreadError>;
    /** The `thread-compress.summarize` effect: completes or fails the run, and never fails itself. */
    readonly executeCompress: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/ThreadCompactionService") {}

const isFinishedRun = (run: OrchestrationV2Run) =>
  (run.status === "completed" || run.status === "interrupted" || run.status === "failed") &&
  !cancelledBeforeStart(run);

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const rollingSummary = yield* RollingSummaryService.RollingSummaryService;
  const random = yield* SecureRandom.SecureRandom;

  const toCompressError = (threadId: ThreadId) => (cause: Orchestrator.OrchestratorV2Error) =>
    cause._tag === "OrchestratorCompressRefusedError"
      ? new OrchestrationV2CompressThreadError({ threadId, reason: cause.reason })
      : new OrchestrationV2CompressThreadError({ threadId, cause });

  const compressDue = Effect.fn("ThreadCompactionService.compressDue")(function* (
    threadId: ThreadId,
    moment: "send" | "turn-end",
  ) {
    const settings = yield* serverSettings.getSettings;
    const thread = yield* projections.getThread(threadId);
    const activeProviderThreadIds =
      thread.activeProviderThreadId === null ? [] : [thread.activeProviderThreadId];
    const records = yield* projections.getThreadRecords(threadId, ["runs", "providerTurns"], {
      providerTurnThreadIds: activeProviderThreadIds,
      latestProviderTurnUsageOnly: true,
    });
    const latestUsage = records.providerTurns
      .filter((turn) => turn.providerThreadId === thread.activeProviderThreadId && turn.tokenUsage)
      .map((turn) => turn.tokenUsage!)
      .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    const lastCompleted = records.runs
      .filter((run) => run.status === "completed" && run.completedAt !== null)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    return autoCompressDue({
      settings,
      thread,
      latestUsage,
      lastCompletedAtMs:
        lastCompleted?.completedAt == null
          ? null
          : DateTime.toEpochMillis(lastCompleted.completedAt),
      nowMs: DateTime.toEpochMillis(yield* DateTime.now),
      moment,
    });
  });

  const dispatchStart = Effect.fn("ThreadCompactionService.dispatchStart")(function* (
    threadId: ThreadId,
    input: {
      readonly commandId: CommandId;
      readonly focus: string | undefined;
      readonly trigger: "manual" | "automatic";
      readonly createdBy: OrchestrationV2Actor;
      readonly creationSource: OrchestrationV2CreationSource;
    },
  ) {
    const focus = input.focus?.trim();
    const result = yield* orchestrator
      .dispatch({
        type: "thread.compress.start",
        commandId: input.commandId,
        threadId,
        messageId: MessageId.make(`compress:${input.commandId}`),
        ...(focus ? { focus } : {}),
        trigger: input.trigger,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      })
      .pipe(Effect.mapError(toCompressError(threadId)));
    const created = result.storedEvents.find((stored) => stored.event.type === "run.created");
    if (created?.event.type !== "run.created")
      return yield* new OrchestrationV2CompressThreadError({ threadId });
    return { runId: created.event.payload.id, sequence: result.sequence };
  });

  const compress: ThreadCompactionService["Service"]["compress"] = Effect.fn(
    "ThreadCompactionService.compress",
  )(function* (threadId, options = {}) {
    const trigger = options.trigger ?? "manual";
    if (trigger === "automatic") {
      const due = yield* compressDue(threadId, "send").pipe(
        Effect.mapError((cause) => new OrchestrationV2CompressThreadError({ threadId, cause })),
      );
      if (!due)
        return yield* new OrchestrationV2CompressThreadError({ threadId, reason: "not-due" });
    }
    const uuid = yield* random.uuidV4().pipe(Effect.orDie);
    return yield* dispatchStart(threadId, {
      commandId: CommandId.make(`server:compress:${threadId}:${uuid}`),
      focus: options.focus,
      trigger,
      createdBy: options.createdBy ?? (trigger === "automatic" ? "agent" : "user"),
      creationSource: trigger === "automatic" ? "server" : (options.creationSource ?? "web"),
    });
  });

  const undoCompress: ThreadCompactionService["Service"]["undoCompress"] = Effect.fn(
    "ThreadCompactionService.undoCompress",
  )(function* (threadId) {
    const { runs } = yield* projections
      .getThreadRecords(threadId, ["runs"])
      .pipe(
        Effect.mapError((cause) => new OrchestrationV2CompressThreadError({ threadId, cause })),
      );
    const run = runs
      .filter((candidate) => !cancelledBeforeStart(candidate))
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (run?.compress !== true)
      return yield* new OrchestrationV2CompressThreadError({ threadId, reason: "not-undoable" });
    const result = yield* orchestrator
      .dispatch({
        type: "thread.compress.undo",
        commandId: yield* attemptCommandId(threadId, run.id, "undo"),
        threadId,
        runId: run.id,
      })
      .pipe(Effect.mapError(toCompressError(threadId)));
    return { sequence: result.sequence };
  });

  const runIsPreparing = (threadId: ThreadId, runId: RunId) =>
    projections.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map(({ runs }) => runs.some((run) => run.id === runId && run.status === "preparing")),
      Effect.orElseSucceed(() => false),
    );

  // A rejected command id stays rejected, so each attempt carries its own.
  const attemptCommandId = (threadId: ThreadId, runId: RunId, step: string) =>
    random.uuidV4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:compress:${threadId}:${runId}:${step}:${uuid}`)),
    );

  const dispatchFail = (threadId: ThreadId, runId: RunId, reason: string) =>
    attemptCommandId(threadId, runId, "fail").pipe(
      Effect.flatMap((commandId) =>
        orchestrator.dispatch({
          type: "thread.compress.fail",
          commandId,
          threadId,
          runId,
          reason,
        }),
      ),
    );

  /** Retries while the run still holds the queue, as nothing else would end it before a restart. */
  const failCompress = (threadId: ThreadId, runId: RunId, reason: string) =>
    dispatchFail(threadId, runId, reason).pipe(
      Effect.catch((cause) =>
        runIsPreparing(threadId, runId).pipe(
          Effect.flatMap((preparing) => (preparing ? Effect.fail(cause) : Effect.void)),
        ),
      ),
      Effect.retry(
        Schedule.exponential("1 second").pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(Duration.min(duration, Duration.seconds(30))),
          ),
        ),
      ),
      Effect.asVoid,
    );

  const buildHandoff = Effect.fn("ThreadCompactionService.buildHandoff")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
    focus: string | undefined,
  ) {
    const snapshot = yield* rollingSummary.compressSnapshot(threadId, {
      keepTailTokens: COMPRESS_TAIL_TOKENS,
    });
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    const freshRunIds = runs
      .filter((candidate) => candidate.freshContext === true)
      .map((r) => r.id);
    const freshUserItems =
      freshRunIds.length === 0
        ? []
        : (yield* projections.getThreadRecords(threadId, ["turnItems"], {
            turnItemTypes: ["user_message"],
            turnItemRunIds: freshRunIds,
          })).turnItems;
    const chainBoundary = RollingSummaryService.summaryChainBoundary({
      runs,
      turnItems: freshUserItems,
    });
    const boundary = contextBoundaryOrdinal({ runs, turnItems: freshUserItems });
    const conversationRuns = runs.filter(
      (candidate) =>
        candidate.ordinal >= boundary &&
        candidate.ordinal < run.ordinal &&
        candidate.compress !== true &&
        candidate.status !== "rolled_back" &&
        !isScheduledFreshRun(candidate, freshUserItems),
    );
    const recencyRuns =
      snapshot.summaryThrough === null
        ? []
        : conversationRuns
            .filter(
              (candidate) =>
                isFinishedRun(candidate) && candidate.ordinal <= snapshot.summaryThrough!,
            )
            .toSorted((left, right) => left.ordinal - right.ordinal)
            .slice(-RECENCY_RUNS);
    const recencyItems =
      recencyRuns.length === 0
        ? []
        : (yield* projections.getThreadRecords(threadId, ["turnItems"], {
            turnItemRunIds: recencyRuns.map((candidate) => candidate.id),
          })).turnItems;
    const workingSetItems =
      conversationRuns.length === 0
        ? []
        : (yield* projections.getThreadRecords(threadId, ["turnItems"], {
            turnItemTypes: [...WORKING_SET_ITEM_TYPES],
            turnItemRunIds: conversationRuns.map((candidate) => candidate.id),
          })).turnItems;
    return buildCompressHandoffText({
      threadId,
      summary: snapshot.summary,
      summaryThrough: snapshot.summaryThrough,
      firstRunOrdinal: Math.max(1, chainBoundary),
      mandatoryTail: snapshot.tail,
      recencyRuns: recencyRuns.map((candidate) => ({
        ordinal: candidate.ordinal,
        text: renderSummaryRun(recencyItems.filter((item) => item.runId === candidate.id)),
      })),
      workingSet: compressWorkingSet(workingSetItems),
      focus,
    });
  });

  const OVERFLOW_REASONS = {
    summary: "The thread's summary is too large for a fresh session.",
    tail: "The latest runs are too large to carry into a fresh session.",
    empty: "There is no history to carry into a fresh session.",
  } as const;

  const executeCompress: ThreadCompactionService["Service"]["executeCompress"] = Effect.fn(
    "ThreadCompactionService.executeCompress",
  )(
    function* ({ threadId, runId }) {
      const { runs, messages } = yield* projections.getThreadRecords(
        threadId,
        ["runs", "messages"],
        {
          messageRoles: ["user"],
        },
      );
      const run = runs.find((candidate) => candidate.id === runId);
      if (run === undefined) return;
      if (run.status !== "preparing") {
        // A Stop or restart ended the run first; its item may still show as running.
        yield* dispatchFail(threadId, runId, "The compress was stopped.").pipe(Effect.ignore);
        return;
      }
      const focus = parseCompressComposerCommand(
        messages.find((message) => message.id === run.userMessageId)?.text ?? "",
      )?.focus;
      const built = yield* buildHandoff(threadId, run, focus || undefined).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((cause) =>
          Effect.succeed({
            ok: false as const,
            reason: cause instanceof Error ? cause.message : "The summary could not be produced.",
          }),
        ),
      );
      if (!built.ok) return yield* failCompress(threadId, runId, built.reason);
      if ("overflow" in built.value)
        return yield* failCompress(threadId, runId, OVERFLOW_REASONS[built.value.overflow]);
      const { text, preview, coveredRunOrdinals } = built.value;
      yield* orchestrator
        .dispatch({
          type: "thread.compress.complete",
          commandId: CommandId.make(`server:compress:${threadId}:${runId}:complete`),
          threadId,
          runId,
          summaryText: text,
          summaryPreview: preview,
          coveredRunOrdinals,
          afterTokenCount: estimateTextTokens(text),
        })
        .pipe(
          Effect.catch((cause) =>
            failCompress(
              threadId,
              runId,
              cause._tag === "OrchestratorCompressRefusedError"
                ? cause.message
                : "The fresh session could not be started.",
            ),
          ),
        );
    },
    (effect, { threadId, runId }) =>
      effect.pipe(
        Effect.catch((cause) => Effect.logWarning("compress failed", { threadId, runId, cause })),
      ),
  );

  const compressAtTurnEnd = Effect.fn("ThreadCompactionService.compressAtTurnEnd")(
    function* (threadId: ThreadId, completedRunId: RunId) {
      if (!(yield* serverSettings.getSettings).autoCompress) return;
      if (!(yield* compressDue(threadId, "turn-end"))) return;
      yield* dispatchStart(threadId, {
        // One automatic compress per completed run, even across duplicate events.
        commandId: CommandId.make(`server:auto-compress:${threadId}:${completedRunId}`),
        focus: undefined,
        trigger: "automatic",
        createdBy: "agent",
        creationSource: "server",
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          cause._tag === "OrchestrationV2CompressThreadError" && cause.reason !== undefined
            ? Effect.void
            : Effect.logWarning("automatic compress skipped", { threadId, cause }),
        ),
      ),
  );

  const start = Effect.fn("ThreadCompactionService.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" &&
        event.payload.status === "completed" &&
        event.payload.compress !== true
          ? compressAtTurnEnd(event.threadId, event.payload.id)
          : Effect.void,
      ),
    );
  });

  return ThreadCompactionService.of({ compress, undoCompress, executeCompress, start });
});

export const layer = Layer.effect(ThreadCompactionService, make);
