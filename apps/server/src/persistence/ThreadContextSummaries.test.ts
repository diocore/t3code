import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "./Sqlite.ts";
import * as ThreadContextSummaries from "./ThreadContextSummaries.ts";

const threadId = ThreadId.make("thread-summaries");
const otherThreadId = ThreadId.make("thread-other");

const row = (thread: ThreadId, toRunOrdinal: number) => ({
  threadId: thread,
  providerThreadId: null,
  toRunOrdinal,
  summary: {
    goal: `through run ${toRunOrdinal}`,
    userRequests: [],
    decisions: [],
    constraints: [],
    filesTouched: [],
    openTodos: [],
    currentState: "",
    unresolvedErrors: [],
  },
  summaryChars: 100,
  model: "claude-haiku-5-5",
  promptTokens: 60_000,
  outputTokens: 3_000,
  createdAt: DateTime.makeUnsafe("2026-11-26T00:00:00.000Z"),
});

it.layer(ThreadContextSummaries.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ThreadContextSummaryRepository",
  (it) => {
    it.effect("keeps a chain whose latest link is current and invalidation leaves the prefix", () =>
      Effect.gen(function* () {
        const repository = yield* ThreadContextSummaries.ThreadContextSummaryRepository;
        assert.isTrue(Option.isNone(yield* repository.latest(threadId)));
        for (const ordinal of [4, 9, 15]) yield* repository.insert(row(threadId, ordinal));
        yield* repository.insert(row(otherThreadId, 20));

        const latest = Option.getOrThrow(yield* repository.latest(threadId));
        assert.strictEqual(latest.toRunOrdinal, 15);
        assert.strictEqual(latest.summary.goal, "through run 15");

        yield* repository.invalidateFrom(threadId, 9);
        assert.strictEqual(Option.getOrThrow(yield* repository.latest(threadId)).toRunOrdinal, 4);
        assert.strictEqual(
          Option.getOrThrow(yield* repository.latest(otherThreadId)).toRunOrdinal,
          20,
        );

        yield* repository.deleteThread(threadId);
        assert.isTrue(Option.isNone(yield* repository.latest(threadId)));
        assert.isTrue(Option.isSome(yield* repository.latest(otherThreadId)));
      }),
    );
  },
);
