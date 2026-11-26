import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const SummaryEntries = Schema.Array(Schema.String);

export const ContextSummarySections = Schema.Struct({
  goal: Schema.String,
  userRequests: SummaryEntries,
  decisions: SummaryEntries,
  constraints: SummaryEntries,
  filesTouched: SummaryEntries,
  openTodos: SummaryEntries,
  currentState: Schema.String,
  unresolvedErrors: SummaryEntries,
});
export type ContextSummarySections = typeof ContextSummarySections.Type;

function trim(text: string | undefined, head: number, tail: number): string {
  const value = text ?? "";
  if (value.length <= head + tail + 40) return value;
  const omitted = `…[${value.length - head - tail} chars omitted]…`;
  return tail === 0
    ? `${value.slice(0, head)}\n${omitted}`
    : `${value.slice(0, head)}\n${omitted}\n${value.slice(-tail)}`;
}

const asText = (value: unknown): string =>
  value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const answerText = (answer: unknown): string =>
  Array.isArray(answer) ? answer.map(asText).join(", ") : asText(answer);

function askedAndAnswered(question: string, answer: string): string {
  return `[AGENT ASKED] ${question}\n[USER ANSWERED] ${answer}`;
}

function renderAskUserQuestion(item: { readonly input: unknown; readonly output?: unknown }) {
  const output = asRecord(item.output);
  if (output === undefined && item.output !== undefined) {
    return `[QUESTION→USER] ${trim(asText(item.output), 1500, 1500)}`;
  }
  const answers = asRecord(output?.answers) ?? {};
  const rendered = Object.entries(answers).map(([question, answer]) =>
    askedAndAnswered(question, answerText(answer)),
  );
  if (rendered.length > 0) return rendered.join("\n");
  const questions = asRecord(item.input)?.questions;
  return Array.isArray(questions)
    ? questions
        .map((question) => `[AGENT ASKED] ${asText(asRecord(question)?.question)}`)
        .join("\n")
    : null;
}

function renderUserInputRequest(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "user_input_request" }>,
  answeredElsewhere: ReadonlySet<string>,
) {
  const answers = item.questionAnswer?.answers;
  if (answers === undefined) {
    return `[QUESTION→USER] ${trim(JSON.stringify(item.questions).slice(0, 1500), 800, 300)}`;
  }
  return item.questions
    .filter((question) => !answeredElsewhere.has(question.question))
    .map((question) => {
      const optionLabel = (value: unknown) =>
        question.options.find((option) => (option.value ?? option.label) === value)?.label ??
        asText(value);
      const chosen = answers[question.id];
      const other = asText(answers[`${question.id}_other`]).trim();
      const answer = [
        ...(Array.isArray(chosen) ? chosen : chosen === undefined ? [] : [chosen]).map(optionLabel),
        ...(other.length > 0 ? [other] : []),
      ].join("; ");
      return askedAndAnswered(`${question.header}: ${question.question}`, answer);
    })
    .join("\n");
}

function hunkHeaders(diff: string | undefined): string {
  return (diff ?? "")
    .split("\n")
    .filter((line) => line.startsWith("@@"))
    .slice(0, 6)
    .join(" ");
}

function renderSummaryItem(
  item: OrchestrationV2TurnItem,
  answeredElsewhere: ReadonlySet<string>,
): string | null {
  switch (item.type) {
    case "user_message":
      return `[USER]\n${item.text}`;
    case "assistant_message":
      return `[ASSISTANT]\n${item.text}`;
    case "proposed_plan":
      return `[PLAN]\n${trim(item.markdown, 3000, 1000)}`;
    case "command_execution": {
      const failed = item.exitCode !== undefined && item.exitCode !== 0;
      const output = failed ? trim(item.output, 300, 300) : trim(item.output, 120, 120);
      return `[CMD exit=${item.exitCode ?? "unknown"}] ${trim(item.input, 300, 0)}\n${output}`;
    }
    case "dynamic_tool":
      if (item.toolName === "AskUserQuestion") return renderAskUserQuestion(item);
      if (item.toolName === "ExitPlanMode") {
        const plan = asRecord(item.input)?.plan;
        return `[PLAN PROPOSED]\n${trim(typeof plan === "string" ? plan : asText(item.input), 3000, 500)}`;
      }
      return `[TOOL ${item.toolName}] ${trim(asText(item.input), 250, 0)} → ${trim(asText(item.output), 200, 100)}`;
    case "file_change":
      return `[EDIT ${item.fileName}] ${hunkHeaders(item.diffStr)}`.trimEnd();
    case "web_search":
      return `[WEB SEARCH] ${trim((item.patterns ?? []).join(", "), 200, 0)}`;
    case "error":
      return `[ERROR] ${trim(JSON.stringify(item.failure), 400, 0)}`;
    case "user_input_request":
      return renderUserInputRequest(item, answeredElsewhere);
    default:
      return null;
  }
}

/** One run's transcript for the rolling summary, without its `=== RUN n ===` header. */
export function renderSummaryRun(items: ReadonlyArray<OrchestrationV2TurnItem>): string {
  // Claude records an answered question twice: as its AskUserQuestion tool call and as the request.
  const answeredElsewhere = new Set(
    items.flatMap((item) =>
      item.type === "dynamic_tool" && item.toolName === "AskUserQuestion"
        ? Object.keys(asRecord(asRecord(item.output)?.answers) ?? {})
        : [],
    ),
  );
  return items
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((item) => renderSummaryItem(item, answeredElsewhere))
    .filter((rendered): rendered is string => rendered !== null && rendered.length > 0)
    .join("\n");
}

export function renderSummaryTranscript(
  pieces: ReadonlyArray<{ readonly ordinal: number; readonly text: string }>,
): string {
  return pieces.map(({ ordinal, text }) => `=== RUN ${ordinal} ===\n${text}`).join("\n\n");
}

const SUMMARY_LIST_HEADINGS = [
  ["userRequests", "User requests"],
  ["decisions", "Decisions"],
  ["constraints", "Constraints"],
  ["filesTouched", "Files touched"],
  ["openTodos", "Open todos"],
  ["unresolvedErrors", "Unresolved errors"],
] as const;

/** The summary as markdown for a fresh session: a `###` heading per non-empty section. */
export function renderContextSummaryMarkdown(sections: ContextSummarySections): string {
  const paragraph = (heading: string, text: string) =>
    text.trim().length === 0 ? [] : [`### ${heading}\n${text.trim()}`];
  return [
    ...paragraph("Goal", sections.goal),
    ...SUMMARY_LIST_HEADINGS.flatMap(([key, heading]) =>
      sections[key].length === 0
        ? []
        : [`### ${heading}\n${sections[key].map((entry) => `- ${entry}`).join("\n")}`],
    ),
    ...paragraph("Current state", sections.currentState),
  ].join("\n\n");
}
