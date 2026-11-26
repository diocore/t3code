import { describe, expect, it } from "vite-plus/test";

import {
  calibrateCharsPerToken,
  estimatePromptTokens,
  INITIAL_CHARS_PER_TOKEN,
  planSummaryChunks,
} from "./rollingSummaryChunks.ts";

const run = (ordinal: number, chars: number) => ({ ordinal, text: "x".repeat(chars) });

describe("planSummaryChunks", () => {
  it.each([
    { priorSummaryChars: 0, charsPerToken: INITIAL_CHARS_PER_TOKEN },
    { priorSummaryChars: 30_000, charsPerToken: INITIAL_CHARS_PER_TOKEN },
    { priorSummaryChars: 30_000, charsPerToken: 1.1 },
  ])(
    "keeps every chunk under 90K estimated tokens with $priorSummaryChars prior chars at $charsPerToken",
    ({ priorSummaryChars, charsPerToken }) => {
      const runs = [run(1, 20_000), run(2, 70_000), run(3, 400_000), run(4, 5_000), run(5, 90_000)];
      const chunks = planSummaryChunks({ runs, priorSummaryChars, charsPerToken });

      for (const chunk of chunks) {
        expect(
          estimatePromptTokens({
            transcriptChars: chunk.transcript.length,
            priorSummaryChars,
            charsPerToken,
          }),
        ).toBeLessThan(90_000);
      }
      const covered = chunks.flatMap((chunk) => chunk.pieces);
      for (const { ordinal, text } of runs) {
        expect(
          covered
            .filter((piece) => piece.ordinal === ordinal)
            .map((piece) => piece.text)
            .join(""),
        ).toBe(text);
      }
      const splitChunks = chunks.filter((chunk) => !chunk.completesLastRun);
      expect(splitChunks.length).toBeGreaterThan(0);
      expect(splitChunks.every((chunk) => chunk.firstRunOrdinal === chunk.lastRunOrdinal)).toBe(
        true,
      );
      expect(chunks.at(-1)?.completesLastRun).toBe(true);
    },
  );

  it("groups small runs whole, in order", () => {
    const chunks = planSummaryChunks({
      runs: [run(2, 10), run(1, 10)],
      priorSummaryChars: 0,
      charsPerToken: INITIAL_CHARS_PER_TOKEN,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      firstRunOrdinal: 1,
      lastRunOrdinal: 2,
      completesLastRun: true,
    });
  });

  it("plans nothing when the prior summary leaves no room", () => {
    expect(
      planSummaryChunks({
        runs: [run(1, 10)],
        priorSummaryChars: 200_000,
        charsPerToken: INITIAL_CHARS_PER_TOKEN,
      }),
    ).toEqual([]);
  });
});

describe("calibrateCharsPerToken", () => {
  it("lowers the ratio for dense prompts and never raises it", () => {
    const dense = calibrateCharsPerToken(INITIAL_CHARS_PER_TOKEN, {
      promptChars: 120_000,
      promptTokens: 2 * (7_500 + 100_000),
      requests: 2,
    });
    expect(dense).toBeCloseTo(1.2);
    expect(
      calibrateCharsPerToken(dense, { promptChars: 190_000, promptTokens: 107_500, requests: 1 }),
    ).toBe(dense);
    expect(
      calibrateCharsPerToken(INITIAL_CHARS_PER_TOKEN, {
        promptChars: 190_000,
        promptTokens: 107_500,
        requests: 1,
      }),
    ).toBe(INITIAL_CHARS_PER_TOKEN);
  });
});
