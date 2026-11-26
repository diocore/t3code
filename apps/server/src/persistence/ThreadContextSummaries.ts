import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { ProviderThreadId, ThreadId } from "@t3tools/contracts";
import { ContextSummarySections } from "@t3tools/provider-core/server/contextSummary";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ThreadContextSummaryRepositoryError,
} from "./Errors.ts";

/** One link of a thread's summary chain: everything from the context boundary through `toRunOrdinal`. */
export const ThreadContextSummary = Schema.Struct({
  threadId: ThreadId,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  toRunOrdinal: Schema.Int,
  summary: Schema.fromJsonString(ContextSummarySections),
  summaryChars: Schema.Int,
  model: Schema.String,
  promptTokens: Schema.Int,
  outputTokens: Schema.Int,
  createdAt: Schema.DateTimeUtcFromString,
});
export type ThreadContextSummary = typeof ThreadContextSummary.Type;

export class ThreadContextSummaryRepository extends Context.Service<
  ThreadContextSummaryRepository,
  {
    readonly latest: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ThreadContextSummary>, ThreadContextSummaryRepositoryError>;
    readonly insert: (
      row: ThreadContextSummary,
    ) => Effect.Effect<void, ThreadContextSummaryRepositoryError>;
    /** Drops every link whose coverage reaches `runOrdinal`, leaving the valid prefix. */
    readonly invalidateFrom: (
      threadId: ThreadId,
      runOrdinal: number,
    ) => Effect.Effect<void, ThreadContextSummaryRepositoryError>;
    readonly deleteThread: (
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadContextSummaryRepositoryError>;
  }
>()("t3/persistence/ThreadContextSummaries/ThreadContextSummaryRepository") {}

const toRepositoryError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError("ThreadContextSummary", cause)
    : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findLatest = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: ThreadContextSummary,
    execute: (threadId) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_thread_id AS "providerThreadId",
          to_run_ordinal AS "toRunOrdinal",
          summary_json AS "summary",
          summary_chars AS "summaryChars",
          model AS "model",
          prompt_tokens AS "promptTokens",
          output_tokens AS "outputTokens",
          created_at AS "createdAt"
        FROM thread_context_summaries
        WHERE thread_id = ${threadId}
        ORDER BY to_run_ordinal DESC
        LIMIT 1
      `,
  });
  const insertRow = SqlSchema.void({
    Request: ThreadContextSummary,
    execute: (row) =>
      sql`
        INSERT INTO thread_context_summaries (
          thread_id,
          provider_thread_id,
          to_run_ordinal,
          summary_json,
          summary_chars,
          model,
          prompt_tokens,
          output_tokens,
          created_at
        )
        VALUES (
          ${row.threadId},
          ${row.providerThreadId},
          ${row.toRunOrdinal},
          ${row.summary},
          ${row.summaryChars},
          ${row.model},
          ${row.promptTokens},
          ${row.outputTokens},
          ${row.createdAt}
        )
      `,
  });

  return ThreadContextSummaryRepository.of({
    latest: Effect.fn("ThreadContextSummaryRepository.latest")(function (threadId) {
      return findLatest(threadId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toRepositoryError("latestThreadContextSummary")),
      );
    }),
    insert: Effect.fn("ThreadContextSummaryRepository.insert")(function (row) {
      return insertRow(row).pipe(Effect.mapError(toRepositoryError("insertThreadContextSummary")));
    }),
    invalidateFrom: Effect.fn("ThreadContextSummaryRepository.invalidateFrom")(
      function (threadId, runOrdinal) {
        return sql`
          DELETE FROM thread_context_summaries
          WHERE thread_id = ${threadId} AND to_run_ordinal >= ${runOrdinal}
        `.pipe(
          Effect.asVoid,
          Effect.mapError(toRepositoryError("invalidateThreadContextSummaries")),
        );
      },
    ),
    deleteThread: Effect.fn("ThreadContextSummaryRepository.deleteThread")(function (threadId) {
      return sql`DELETE FROM thread_context_summaries WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(toRepositoryError("deleteThreadContextSummaries")),
      );
    }),
  });
});

export const layer = Layer.effect(ThreadContextSummaryRepository, make);
