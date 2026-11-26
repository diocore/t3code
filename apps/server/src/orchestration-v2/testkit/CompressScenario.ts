import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProjectId,
  type RunId,
  ProviderDriverKind,
  type TextGenerationError,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  ContextSummaryGenerationInput,
  ContextSummaryGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ThreadCompactionService from "../ThreadCompactionService.ts";
import { type CompressCapturedTurn, makeCompressTestAdapter } from "./CompressTestAdapter.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
// Over COMPRESS_TAIL_TOKENS at the planner's 1.5 chars per token, so a compress summarizes.
const LONG_RESPONSE = `Long answer. ${"x".repeat(14_000)}`;

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

export type Summarize = (
  request: ContextSummaryGenerationInput,
) => Effect.Effect<ContextSummaryGenerationResult, TextGenerationError>;

const summarizeAs =
  (goal: string): Summarize =>
  () =>
    Effect.succeed({
      sections: sections(goal),
      usage: { promptTokens: 10_000, outputTokens: 500, turns: 1 },
    });

export const compactionItem = (projection: OrchestrationV2ThreadProjection) =>
  projection.turnItems.find(
    (item): item is Extract<OrchestrationV2TurnItem, { readonly type: "compaction" }> =>
      item.type === "compaction" && item.method === "compress",
  );

export interface Scenario {
  readonly name: string;
  readonly threadId: ThreadId;
  readonly modelSelection?: ModelSelection;
  readonly summarize?: Summarize;
  readonly autoCompress?: boolean;
  readonly backgroundWork?: boolean;
  readonly tokenUsageByRunOrdinal?: Readonly<
    Record<number, Omit<OrchestrationV2ProviderTurnTokenUsage, "updatedAt">>
  >;
}

const makeContext = (input: {
  readonly scenarioName: string;
  readonly threadId: ThreadId;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CompressCapturedTurn>>;
  readonly backgroundWork: Ref.Ref<boolean>;
  readonly failResumeOnce: Ref.Ref<boolean>;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const compaction = yield* ThreadCompactionService.ThreadCompactionService;
    const eventSink = yield* EventSink.EventSinkV2;
    const projection = () =>
      worker.drain().pipe(Effect.andThen(orchestrator.getThreadProjection(input.threadId)));
    // Projections commit with their events, so each later event is the only time to re-read.
    const waitUntil = (predicate: (current: OrchestrationV2ThreadProjection) => boolean) =>
      Effect.gen(function* () {
        const afterSequence = yield* eventSink.latestSequence();
        const current = yield* projection();
        if (predicate(current)) return current;
        const [reached] = yield* eventSink
          .stream({ afterSequence })
          .pipe(
            Stream.mapEffect(projection),
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runCollect,
          );
        return reached!;
      });
    const settle = () =>
      waitUntil((current) =>
        current.runs.every(
          (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
        ),
      );
    const send = (name: string, options: { readonly modelSelection?: ModelSelection } = {}) =>
      orchestrator
        .dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:compress:${input.scenarioName}:${name}`),
          threadId: input.threadId,
          messageId: MessageId.make(`message:compress:${input.scenarioName}:${name}`),
          text: `Prompt ${name}`,
          attachments: [],
          ...options,
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.asVoid);
    return {
      orchestrator,
      worker,
      compaction,
      capturedTurns: input.capturedTurns,
      backgroundWork: input.backgroundWork,
      failResumeOnce: input.failResumeOnce,
      send,
      settle,
      projection: () => orchestrator.getThreadProjection(input.threadId),
      waitUntil,
    };
  });

export type ScenarioContext = Effect.Success<ReturnType<typeof makeContext>>;

export const runScenario = <A, E>(
  scenario: Scenario,
  body: (context: ScenarioContext) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(`compress-${scenario.name}`);
    const capturedTurns = yield* Ref.make<ReadonlyArray<CompressCapturedTurn>>([]);
    const backgroundWork = yield* Ref.make(scenario.backgroundWork ?? false);
    const failResumeOnce = yield* Ref.make(false);
    const summarize = scenario.summarize ?? summarizeAs("through the long answer");
    const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
      makeCompressTestAdapter({
        instanceId: CLAUDE_MODEL_SELECTION.instanceId,
        driver: CLAUDE_DRIVER,
        capabilities: ClaudeProviderCapabilitiesV2,
        modelSelection: CLAUDE_MODEL_SELECTION,
        capturedTurns,
        backgroundWork,
        failResumeOnce,
        responseByRunOrdinal: { 1: LONG_RESPONSE },
        tokenUsageByRunOrdinal: scenario.tokenUsageByRunOrdinal ?? {
          1: { usedTokens: 90_000, maxTokens: 200_000 },
        },
      }),
      makeCompressTestAdapter({
        instanceId: CODEX_MODEL_SELECTION.instanceId,
        driver: CODEX_DRIVER,
        capabilities: CodexProviderCapabilitiesV2,
        modelSelection: CODEX_MODEL_SELECTION,
        capturedTurns,
        responseByRunOrdinal: { 1: LONG_RESPONSE },
      }),
    ]);
    return yield* Effect.gen(function* () {
      const context = yield* makeContext({
        scenarioName: scenario.name,
        threadId: scenario.threadId,
        capturedTurns,
        backgroundWork,
        failResumeOnce,
      });
      yield* context.orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:compress:${scenario.name}:create`),
        threadId: scenario.threadId,
        projectId: ProjectId.make(`project:compress:${scenario.name}`),
        title: "Compress",
        modelSelection: scenario.modelSelection ?? CLAUDE_MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
      });
      return yield* body(context);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          {
            name: `compress-${scenario.name}`,
            runtimePolicyOverride: {
              cwd,
              approvalPolicy: "never",
              sandboxPolicy: { type: "readOnly" },
            },
          },
          layerRegistry,
          {
            runEffectWorker: false,
            serverSettings: { autoCompress: scenario.autoCompress ?? false },
            textGeneration: { generateContextSummary: summarize },
          },
        ),
      ),
    );
  });

export const firstTurnThenCompress = <A, E>(
  scenario: Scenario,
  then: (
    context: ScenarioContext & {
      readonly before: OrchestrationV2ThreadProjection;
      readonly compressed: { readonly runId: RunId; readonly sequence: number };
    },
  ) => Effect.Effect<A, E, never>,
) =>
  runScenario(scenario, (context) =>
    Effect.gen(function* () {
      yield* context.send("first");
      const before = yield* context.settle();
      const compressed = yield* context.compaction.compress(scenario.threadId, {
        focus: "keep the auth flow",
      });
      return yield* then({ ...context, before, compressed });
    }),
  );
