import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_context_summaries (
      thread_id TEXT NOT NULL,
      provider_thread_id TEXT,
      to_run_ordinal INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      summary_chars INTEGER NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, to_run_ordinal)
    ) WITHOUT ROWID
  `;
});
