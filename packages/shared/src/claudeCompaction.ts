/** Adapter and client match these dialog strings; reword them only here. */
export const CLAUDE_RESUME_COMPACTION_NEVER_ANSWER = "Don't ask again";
export const CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER = "Compact and continue";

export function formatClaudeResumeCompactionQuestion(input: {
  readonly ageMinutes: number;
  readonly estimatedTokens: number;
}): string {
  const ageLabel =
    input.ageMinutes >= 60
      ? `${Math.floor(input.ageMinutes / 60)}h ${input.ageMinutes % 60}m`
      : `${input.ageMinutes}m`;
  return `This session is ${ageLabel} old and uses ${input.estimatedTokens.toLocaleString("en-US")} tokens. Compact it before continuing?`;
}

const CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN =
  /^This session is (\d+h \d+m|\d+m) old and uses \d{1,3}(?:,\d{3})* tokens\. Compact it before continuing\?$/u;

export function isClaudeResumeCompactionQuestion(question: string): boolean {
  return CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN.test(question);
}

/**
 * The session age from an answered resume question whose answer was to compact, or null. Answers
 * are keyed by question id, and the id may itself be the question text.
 */
export function claudeResumeCompactionAge(questionAnswer: {
  readonly questionTextById?: Readonly<Record<string, string>> | undefined;
  readonly answers: Readonly<Record<string, unknown>>;
}): string | null {
  for (const [id, answer] of Object.entries(questionAnswer.answers)) {
    const age = CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN.exec(
      questionAnswer.questionTextById?.[id] ?? id,
    )?.[1];
    const chosen = Array.isArray(answer) ? answer : [answer];
    if (age !== undefined && chosen.includes(CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER)) return age;
  }
  return null;
}

/**
 * Context size below which T3 does not suggest or run a Claude compaction:
 * the stale-thread Compact chip and idle compaction. Matches Claude Code's
 * idleCompaction default of 200K.
 */
export const COMPACTION_SUGGESTION_MIN_TOKENS = 200_000;

// Claude caps the window at the model's context, so a setting at or above it never applies.
// Below that, Claude compacts 33,000 tokens short of the window: Claude Code 2.1.305's
// getContextUsage reports a 150,000 window as a 117,000 threshold, for every catalog model.
export const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;

/** The context size at which Claude compacts natively, when the usage report says enough to know. */
export function claudeAutoCompactAt(usage: {
  readonly autoCompactThreshold?: number | undefined;
  readonly maxTokens?: number | null | undefined;
}): number | undefined {
  if (usage.autoCompactThreshold !== undefined) return usage.autoCompactThreshold;
  return usage.maxTokens == null || usage.maxTokens <= CLAUDE_AUTO_COMPACT_RESERVE_TOKENS
    ? undefined
    : usage.maxTokens - CLAUDE_AUTO_COMPACT_RESERVE_TOKENS;
}

/** A turn ending at this share of Claude's compaction point compresses before Claude compacts. */
const AUTO_COMPRESS_THRESHOLD_RATIO = 0.7;

/** Subagents, side chats and workflow steps keep their session: their parent reads it. */
export function compressLineageListed(lineage: {
  readonly relationshipToParent?: string | null | undefined;
  readonly sideChat?: boolean | undefined;
  readonly workflowStep?: boolean | undefined;
}): boolean {
  return (
    lineage.relationshipToParent !== "subagent" &&
    lineage.sideChat !== true &&
    lineage.workflowStep !== true
  );
}

/** Whether auto-compress should replace the thread's session now: before a send, or at turn end. */
export function autoCompressDue(input: {
  readonly settings: {
    readonly autoCompress: boolean;
    readonly compressIdleMinutes: number;
    readonly providerInstances: Readonly<Record<string, { readonly driver: string }>>;
  };
  readonly thread: {
    readonly providerInstanceId: string;
    readonly lineage: {
      readonly relationshipToParent?: string | null | undefined;
      readonly sideChat?: boolean | undefined;
      readonly workflowStep?: boolean | undefined;
    };
  };
  readonly latestUsage:
    | {
        readonly usedTokens: number;
        readonly autoCompactThreshold?: number | undefined;
        readonly maxTokens?: number | null | undefined;
      }
    | null
    | undefined;
  readonly lastCompletedAtMs: number | null;
  readonly nowMs: number;
  readonly moment: "send" | "turn-end";
}): boolean {
  const { settings, thread, latestUsage } = input;
  const claudeInstance = Object.hasOwn(settings.providerInstances, thread.providerInstanceId)
    ? settings.providerInstances[thread.providerInstanceId]?.driver === "claudeAgent"
    : thread.providerInstanceId === "claudeAgent";
  const listed = compressLineageListed(thread.lineage);
  if (!settings.autoCompress || !claudeInstance || !listed || latestUsage == null) return false;
  if (input.moment === "send")
    return (
      input.lastCompletedAtMs !== null &&
      input.nowMs - input.lastCompletedAtMs >= settings.compressIdleMinutes * 60_000 &&
      latestUsage.usedTokens >= COMPACTION_SUGGESTION_MIN_TOKENS
    );
  const compactAt = claudeAutoCompactAt(latestUsage);
  return (
    compactAt !== undefined && latestUsage.usedTokens >= AUTO_COMPRESS_THRESHOLD_RATIO * compactAt
  );
}

/**
 * The /compress run that Undo would revert, or null: it is the thread's latest run that started
 * or was queued, it completed, and its fresh session has not reached the provider yet.
 */
export function compressUndoTarget<RunId extends string>(projection: {
  readonly runs: ReadonlyArray<{
    readonly id: RunId;
    readonly ordinal: number;
    readonly status: string;
    readonly startedAt: unknown;
    readonly restartContinuationOfRunId?: unknown;
    readonly compress?: true | undefined;
    readonly providerThreadId: string | null;
  }>;
  readonly providerThreads: ReadonlyArray<{
    readonly id: string;
    readonly nativeThreadRef: unknown;
  }>;
}): RunId | null {
  const latest = projection.runs
    .filter(
      (run) =>
        !(
          run.status === "cancelled" &&
          run.startedAt === null &&
          run.restartContinuationOfRunId === undefined
        ),
    )
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  if (latest === undefined || latest.compress !== true || latest.status !== "completed")
    return null;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === latest.providerThreadId,
  );
  return providerThread !== undefined && providerThread.nativeThreadRef === null ? latest.id : null;
}
