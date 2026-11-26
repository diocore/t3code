import {
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurnTokenUsage,
  type ProviderDriverKind,
  type ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export interface CompressCapturedTurn {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly nativeThreadId: string | null;
  readonly runOrdinal: number;
  readonly text: string;
}

/** A provider that answers every turn at once and records each prompt it was sent. */
export function makeCompressTestAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly modelSelection: ModelSelection;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CompressCapturedTurn>>;
  readonly responseByRunOrdinal?: Readonly<Record<number, string>>;
  readonly tokenUsageByRunOrdinal?: Readonly<
    Record<number, Omit<OrchestrationV2ProviderTurnTokenUsage, "updatedAt">>
  >;
  readonly backgroundWork?: Ref.Ref<boolean>;
  readonly failResumeOnce?: Ref.Ref<boolean>;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  const unused = (detail: string) =>
    Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver: input.driver, detail }));
  const nativeThreads = Ref.makeUnsafe(0);
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ...(input.backgroundWork === undefined
            ? {}
            : {
                hasPendingBackgroundWork: Ref.get(input.backgroundWork),
                hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
              }),
          // Like Claude, the native id exists before the first turn runs.
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const generation = yield* Ref.getAndUpdate(nativeThreads, (value) => value + 1);
              const nativeThreadId = `${input.driver}:${threadInput.threadId}:${generation}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                contextUsage: null,
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) =>
            Effect.gen(function* () {
              if (
                input.failResumeOnce !== undefined &&
                (yield* Ref.getAndSet(input.failResumeOnce, false))
              )
                return yield* unused("simulated native resume failure");
              return providerThread;
            }),
          compactThread: (turnInput) => runtime.startTurn(turnInput),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  driver: input.driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                  runOrdinal: turnInput.runOrdinal,
                  text: turnInput.message.text,
                },
              ]);
              const at = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const providerTurn = {
                id: providerTurnId,
                providerThreadId: turnInput.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: {
                  driver: input.driver,
                  nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                  strength: "strong" as const,
                },
                ordinal: turnInput.runOrdinal,
                startedAt: at,
              };
              const usage = input.tokenUsageByRunOrdinal?.[turnInput.runOrdinal];
              if (usage !== undefined)
                yield* PubSub.publish(events, {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    ...providerTurn,
                    status: "running",
                    completedAt: null,
                    tokenUsage: { ...usage, updatedAt: DateTime.formatIso(at) },
                  },
                });
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver: input.driver,
                providerTurn: { ...providerTurn, status: "completed", completedAt: at },
              });
              yield* PubSub.publish(events, {
                type: "turn_item.updated",
                driver: input.driver,
                turnItem: {
                  id: TurnItemId.make(
                    `turn-item:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                  ),
                  threadId: turnInput.threadId,
                  runId: turnInput.runId,
                  nodeId: turnInput.rootNodeId,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: turnInput.runOrdinal * 100 + 1,
                  status: "completed",
                  title: null,
                  startedAt: at,
                  completedAt: at,
                  updatedAt: at,
                  type: "assistant_message",
                  messageId: MessageId.make(
                    `message:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                  ),
                  text:
                    input.responseByRunOrdinal?.[turnInput.runOrdinal] ??
                    `${input.driver} response for run ${turnInput.runOrdinal}`,
                  streaming: false,
                },
              });
              yield* PubSub.publish(events, {
                type: "turn.terminal",
                driver: input.driver,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                runOrdinal: turnInput.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unused("readThreadSnapshot"),
          rollbackThread: () => unused("rollbackThread"),
          forkThread: () => unused("forkThread"),
        };
        return runtime;
      }),
  };
}
