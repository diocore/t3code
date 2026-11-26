import { renderSummaryTranscript } from "@t3tools/provider-core/server/contextSummary";

// Haiku 5.5 bills a request over 100K prompt tokens at 5x; 90K leaves room for a misestimate.
const REQUEST_TOKEN_TARGET = 90_000;
// Measured: `claude -p --tools ""` adds about 7.4K prompt tokens of its own.
const CLI_OVERHEAD_TOKENS = 7_500;
const INSTRUCTION_TOKENS = 1_500;
export const PROMPT_WARNING_TOKENS = 95_000;
// Rendered transcripts measured 1.8-1.9 chars per token, and one code-heavy chunk still crossed
// 100K at 1.85, so start lower and only ever move down.
export const INITIAL_CHARS_PER_TOKEN = 1.5;
const MIN_CHARS_PER_TOKEN = 0.5;

export interface PendingRun {
  readonly ordinal: number;
  readonly text: string;
}

export interface SummaryChunk {
  readonly pieces: ReadonlyArray<PendingRun>;
  readonly firstRunOrdinal: number;
  readonly lastRunOrdinal: number;
  readonly transcript: string;
  /** False when the last run continues in the next chunk. */
  readonly completesLastRun: boolean;
}

const pieceChars = (piece: PendingRun) => renderSummaryTranscript([piece]).length + 2;

export function estimatePromptTokens(input: {
  readonly transcriptChars: number;
  readonly priorSummaryChars: number;
  readonly charsPerToken: number;
}): number {
  return (
    CLI_OVERHEAD_TOKENS +
    INSTRUCTION_TOKENS +
    Math.ceil(input.priorSummaryChars / input.charsPerToken) +
    Math.ceil(input.transcriptChars / input.charsPerToken)
  );
}

function chunkCapChars(priorSummaryChars: number, charsPerToken: number): number {
  const priorSummaryTokens = Math.ceil(priorSummaryChars / charsPerToken);
  return Math.floor(
    (REQUEST_TOKEN_TARGET - CLI_OVERHEAD_TOKENS - priorSummaryTokens - INSTRUCTION_TOKENS) *
      charsPerToken,
  );
}

export const renderedChars = (runs: ReadonlyArray<PendingRun>) =>
  runs.reduce((sum, run) => sum + pieceChars(run), 0);

/**
 * Groups whole runs, in order, into chunks whose prompt stays under the request target; a run
 * larger than one chunk is split across several. Empty when the prior summary leaves no room.
 */
export function planSummaryChunks(input: {
  readonly runs: ReadonlyArray<PendingRun>;
  readonly priorSummaryChars: number;
  readonly charsPerToken: number;
}): ReadonlyArray<SummaryChunk> {
  const cap = chunkCapChars(input.priorSummaryChars, input.charsPerToken);
  const chunks: Array<SummaryChunk> = [];
  let current: Array<PendingRun> = [];
  let size = 0;
  const flush = (completesLastRun: boolean) => {
    if (current.length === 0) return;
    chunks.push({
      pieces: current,
      firstRunOrdinal: current[0]!.ordinal,
      lastRunOrdinal: current.at(-1)!.ordinal,
      transcript: renderSummaryTranscript(current),
      completesLastRun,
    });
    current = [];
    size = 0;
  };
  for (const run of input.runs.toSorted((left, right) => left.ordinal - right.ordinal)) {
    const headerChars = pieceChars({ ordinal: run.ordinal, text: "" });
    const textCap = cap - headerChars;
    if (textCap <= 0) return [];
    let text = run.text;
    if (pieceChars({ ordinal: run.ordinal, text }) > cap) {
      flush(true);
      while (text.length > textCap) {
        current = [{ ordinal: run.ordinal, text: text.slice(0, textCap) }];
        flush(false);
        text = text.slice(textCap);
      }
    }
    const piece = { ordinal: run.ordinal, text };
    if (size + pieceChars(piece) > cap) flush(true);
    current.push(piece);
    size += pieceChars(piece);
  }
  flush(true);
  return chunks;
}

// `claude -p --json-schema` counts its StructuredOutput round as a turn without a second API request.
export const summaryRequestCount = (turns: number) => Math.max(1, turns - 1);

/** Lowers the ratio when a request held fewer chars per token than assumed; never raises it. */
export function calibrateCharsPerToken(
  charsPerToken: number,
  observed: {
    readonly promptChars: number;
    readonly promptTokens: number;
    readonly requests: number;
  },
): number {
  const perRequestTokens = observed.promptTokens / observed.requests;
  const contentTokens = perRequestTokens - CLI_OVERHEAD_TOKENS;
  if (contentTokens <= 0) return charsPerToken;
  return Math.max(
    MIN_CHARS_PER_TOKEN,
    Math.min(charsPerToken, INITIAL_CHARS_PER_TOKEN, observed.promptChars / contentTokens),
  );
}
