import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  type ContextSummarySections,
  renderContextSummaryMarkdown,
  renderSummaryTranscript,
} from "@t3tools/provider-core/server/contextSummary";

/** Unsummarized history up to this size rides along verbatim instead of costing a summary call. */
export const COMPRESS_TAIL_TOKENS = 8_000;

const SUMMARY_BUDGET_BYTES = 48_000;
const RECENT_RUNS_BUDGET_BYTES = 32_000;
const WORKING_SET_BUDGET_BYTES = 8_000;
const PREVIEW_CHARS = 2_000;
const MAX_WORKING_SET_FILES = 30;
const PLAN_HEAD_CHARS = 1_500;

const RECENT_RUNS_HEADING = "## Recent runs";
const WORKING_SET_HEADING = "## Working set";
const TRUNCATED_MARKER =
  "\n\n[Summary truncated to fit this session; read earlier history with t3_thread_read.]";

export interface CompressWorkingSet {
  readonly files: ReadonlyArray<string>;
  readonly plan: string | null;
  readonly openSteps: ReadonlyArray<string>;
}

interface RenderedRun {
  readonly ordinal: number;
  readonly text: string;
}

const textBytes = (text: string) => Buffer.byteLength(text);
// Delivery measures context as JSON text, where newlines and quotes cost two bytes.
const deliveredBytes = (text: string) => Buffer.byteLength(JSON.stringify(text));

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

function toolFilePath(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const path = (input as { readonly file_path?: unknown }).file_path;
  return typeof path === "string" && path.trim().length > 0 ? path.trim() : null;
}

/** Files, the latest plan and open todo steps from the session's items, newest first. */
export function compressWorkingSet(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): CompressWorkingSet {
  const newestFirst = items.toSorted((left, right) => right.ordinal - left.ordinal);
  const files = new Set<string>();
  for (const item of newestFirst) {
    const paths =
      item.type === "file_change"
        ? item.changes?.length
          ? item.changes.map((change) => change.path)
          : [item.fileName]
        : item.type === "dynamic_tool" && item.toolName !== null && FILE_TOOLS.has(item.toolName)
          ? [toolFilePath(item.input)].filter((path): path is string => path !== null)
          : [];
    for (const path of paths) {
      if (files.size < MAX_WORKING_SET_FILES) files.add(path);
    }
  }
  const plan = newestFirst.find((item) => item.type === "proposed_plan");
  const todos = newestFirst.find((item) => item.type === "todo_list");
  return {
    files: [...files],
    plan: plan?.type === "proposed_plan" ? plan.markdown.slice(0, PLAN_HEAD_CHARS) : null,
    openSteps:
      todos?.type === "todo_list"
        ? todos.steps.filter((step) => step.status !== "completed").map((step) => step.text)
        : [],
  };
}

function renderWorkingSet(workingSet: CompressWorkingSet): string {
  const blocks = [
    workingSet.files.length === 0
      ? null
      : `Files:\n${workingSet.files.map((file) => `- ${file}`).join("\n")}`,
    workingSet.openSteps.length === 0
      ? null
      : `Open plan steps:\n${workingSet.openSteps.map((step) => `- ${step}`).join("\n")}`,
    workingSet.plan === null ? null : `Latest proposed plan (head):\n${workingSet.plan}`,
  ].filter((block): block is string => block !== null);
  return blocks.join("\n\n");
}

/** Drops files from the end, then the plan, then the steps, until the block fits. */
function fitWorkingSet(workingSet: CompressWorkingSet): string {
  let candidate = workingSet;
  while (textBytes(renderWorkingSet(candidate)) > WORKING_SET_BUDGET_BYTES) {
    candidate =
      candidate.files.length > 0
        ? { ...candidate, files: candidate.files.slice(0, -1) }
        : candidate.plan !== null
          ? { ...candidate, plan: null }
          : { ...candidate, openSteps: candidate.openSteps.slice(0, -1) };
  }
  return renderWorkingSet(candidate);
}

export type CompressHandoffText =
  | {
      readonly text: string;
      readonly preview: string;
      readonly coveredRunOrdinals: { readonly from: number; readonly to: number };
    }
  | { readonly overflow: "summary" | "tail" | "empty" };

/**
 * The fresh session's opening context: header, focus, summary, recent runs and working set, each
 * within its budget. Optional recent runs go first, then the working set; a summary or mandatory
 * tail over its budget makes the compress fail before anything is swapped.
 */
export function buildCompressHandoffText(input: {
  readonly threadId: string;
  readonly summary: ContextSummarySections | null;
  readonly summaryThrough: number | null;
  readonly firstRunOrdinal: number;
  readonly mandatoryTail: ReadonlyArray<RenderedRun>;
  readonly recencyRuns: ReadonlyArray<RenderedRun>;
  readonly workingSet: CompressWorkingSet;
  readonly focus: string | undefined;
}): CompressHandoffText {
  const summaryMarkdown = input.summary === null ? "" : renderContextSummaryMarkdown(input.summary);
  if (textBytes(summaryMarkdown) > SUMMARY_BUDGET_BYTES) return { overflow: "summary" };
  if (textBytes(renderSummaryTranscript(input.mandatoryTail)) > RECENT_RUNS_BUDGET_BYTES)
    return { overflow: "tail" };
  const coveredTo = Math.max(
    input.summaryThrough ?? 0,
    ...input.mandatoryTail.map((run) => run.ordinal),
  );
  if (coveredTo === 0 || (summaryMarkdown === "" && input.mandatoryTail.length === 0))
    return { overflow: "empty" };

  let recency = input.recencyRuns.filter(
    (run) => !input.mandatoryTail.some((tail) => tail.ordinal === run.ordinal),
  );
  const recentRuns = () =>
    renderSummaryTranscript(
      [...recency, ...input.mandatoryTail].toSorted((left, right) => left.ordinal - right.ordinal),
    );
  while (recency.length > 0 && textBytes(recentRuns()) > RECENT_RUNS_BUDGET_BYTES)
    recency = recency.slice(1);

  const focus = input.focus?.trim() ?? "";
  const recent = recentRuns();
  const workingSet = fitWorkingSet(input.workingSet);
  const text = [
    `This is a fresh session continuing T3 thread ${input.threadId}. The earlier conversation was compressed into the summary below. Read its full history with t3_thread_read({threadId:"${input.threadId}",view:"activity",afterPosition:-1}) when you need detail the summary leaves out.`,
    focus === "" ? null : `User's priority for this compress: ${focus}`,
    summaryMarkdown === ""
      ? null
      : `## Summary (through run ${input.summaryThrough})\n${summaryMarkdown}`,
    recent === "" ? null : `${RECENT_RUNS_HEADING}\n${recent}`,
    workingSet === "" ? null : `${WORKING_SET_HEADING}\n${workingSet}`,
  ]
    .filter((block): block is string => block !== null)
    .join("\n\n");
  return {
    text,
    preview: summaryMarkdown.slice(0, PREVIEW_CHARS),
    coveredRunOrdinals: {
      from: Math.max(1, Math.min(input.firstRunOrdinal, coveredTo)),
      to: coveredTo,
    },
  };
}

/** Sections are written in a fixed order and removed from the end, so each cut drops the rest. */
function withoutSection(text: string, heading: string): string {
  const start = text.lastIndexOf(`\n\n${heading}\n`);
  return start < 0 ? text : text.slice(0, start);
}

/**
 * Fits a compress handoff into a delivery budget: drops the working set, then the recent runs,
 * then truncates the summary with a marker. Never returns less than the opening and the marker.
 */
export function fitCompressHandoffText(text: string, budgetBytes: number): string {
  if (deliveredBytes(text) <= budgetBytes) return text;
  const withoutWorkingSet = withoutSection(text, WORKING_SET_HEADING);
  if (deliveredBytes(withoutWorkingSet) <= budgetBytes) return withoutWorkingSet;
  const summaryOnly = withoutSection(withoutWorkingSet, RECENT_RUNS_HEADING);
  if (deliveredBytes(summaryOnly) <= budgetBytes) return summaryOnly;
  const opening = summaryOnly.indexOf("\n\n");
  const minimum = opening < 0 ? summaryOnly.length : opening;
  let low = minimum;
  let high = summaryOnly.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (deliveredBytes(summaryOnly.slice(0, middle) + TRUNCATED_MARKER) <= budgetBytes)
      low = middle;
    else high = middle - 1;
  }
  const end = /[\uD800-\uDBFF]/u.test(summaryOnly.charAt(low - 1)) ? low - 1 : low;
  return summaryOnly.slice(0, end) + TRUNCATED_MARKER;
}
