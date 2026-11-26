import { describe, expect, it } from "vite-plus/test";

import { autoCompressDue, claudeAutoCompactAt, compressUndoTarget } from "./claudeCompaction.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const settings = {
  autoCompress: true,
  compressIdleMinutes: 30,
  providerInstances: { work: { driver: "claudeAgent" }, cursor: { driver: "cursor" } },
};
const thread = { providerInstanceId: "claudeAgent", lineage: {} };

describe("claudeAutoCompactAt", () => {
  it.each([
    [{ autoCompactThreshold: 117_000, maxTokens: 200_000 }, 117_000],
    [{ maxTokens: 200_000 }, 167_000],
    [{ maxTokens: null }, undefined],
    [{}, undefined],
    [{ maxTokens: 33_000 }, undefined],
  ])("%j → %s", (usage, expected) => {
    expect(claudeAutoCompactAt(usage)).toBe(expected);
  });
});

describe("autoCompressDue", () => {
  const due = (overrides: Partial<Parameters<typeof autoCompressDue>[0]>) =>
    autoCompressDue({
      settings,
      thread,
      latestUsage: { usedTokens: 250_000, maxTokens: 1_000_000 },
      lastCompletedAtMs: NOW - 31 * 60_000,
      nowMs: NOW,
      moment: "send",
      ...overrides,
    });

  it.each([
    ["an idle large Claude thread", {}, true],
    ["a named Claude instance", { thread: { ...thread, providerInstanceId: "work" } }, true],
    ["auto-compress off", { settings: { ...settings, autoCompress: false } }, false],
    ["a Cursor instance", { thread: { ...thread, providerInstanceId: "cursor" } }, false],
    [
      "an unknown non-Claude instance",
      { thread: { ...thread, providerInstanceId: "codex" } },
      false,
    ],
    ["a subagent", { thread: { ...thread, lineage: { relationshipToParent: "subagent" } } }, false],
    ["a side chat", { thread: { ...thread, lineage: { sideChat: true } } }, false],
    ["no usage", { latestUsage: null }, false],
    ["idle under the setting", { lastCompletedAtMs: NOW - 29 * 60_000 }, false],
    ["no completed run", { lastCompletedAtMs: null }, false],
    ["under 200K", { latestUsage: { usedTokens: 199_999 } }, false],
  ] as const)("before a send: %s → %s", (_name, overrides, expected) => {
    expect(due(overrides)).toBe(expected);
  });

  it.each([
    ["at 70% of the threshold", { usedTokens: 81_900, autoCompactThreshold: 117_000 }, true],
    ["just under 70%", { usedTokens: 81_899, autoCompactThreshold: 117_000 }, false],
    ["from the window when no threshold", { usedTokens: 116_900, maxTokens: 200_000 }, true],
    ["without a window", { usedTokens: 900_000 }, false],
  ] as const)("at turn end: %s → %s", (_name, latestUsage, expected) => {
    expect(due({ moment: "turn-end", latestUsage, lastCompletedAtMs: NOW })).toBe(expected);
  });
});

describe("compressUndoTarget", () => {
  const run = (
    ordinal: number,
    overrides: Partial<Parameters<typeof compressUndoTarget>[0]["runs"][number]> = {},
  ) => ({
    id: `run-${ordinal}`,
    ordinal,
    status: "completed",
    startedAt: "2026-11-26T11:00:00.000Z",
    providerThreadId: "provider-thread-1",
    ...overrides,
  });
  const fresh = { id: "provider-thread-2", nativeThreadRef: null };
  const started = { id: "provider-thread-2", nativeThreadRef: { nativeId: "native-2" } };
  const compressRun = run(2, { compress: true, providerThreadId: "provider-thread-2" });

  it.each([
    ["the latest completed compress run", [run(1), compressRun], [fresh], "run-2"],
    ["after a send started the fresh session", [run(1), compressRun], [started], null],
    ["a later run", [run(1), compressRun, run(3)], [fresh], null],
    [
      "a later run cancelled before it started",
      [run(1), compressRun, run(3, { status: "cancelled", startedAt: null })],
      [fresh],
      "run-2",
    ],
    [
      "a later run queued",
      [run(1), compressRun, run(3, { status: "queued", startedAt: null })],
      [fresh],
      null,
    ],
    [
      "a compress run still preparing",
      [run(1), { ...compressRun, status: "preparing", startedAt: null }],
      [fresh],
      null,
    ],
    ["a plain completed run", [run(1)], [fresh], null],
  ] as const)("%s", (_name, runs, providerThreads, expected) => {
    expect(compressUndoTarget({ runs, providerThreads })).toBe(expected);
  });
});
