import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { make } from "./MarginStatsService.ts";

const SAMPLE_STATS = {
  since: "today",
  savings: { tokens_est: 1200, cost_usd_est: 0.42, pct_est: 25.5 },
  totals: {
    requests: 10,
    tokens: { input: 100, output: 200, cache_read: 5000, cache_creation: 300 },
    cost_usd: 1.23,
    cost_unknown: 0,
    tier2_blocks_skipped: 4,
    tier2_chars_before: 10000,
    tier2_chars_reduced: 2500,
    tier2c_chars_reduced: 0,
    checkpoint_chars_reduced: 1500,
    pruning_chars_reduced: 0,
    secrets_redacted: 2,
  },
  by_model: [
    {
      model: "claude-sonnet-5-5",
      requests: 10,
      input_tokens: 100,
      output_tokens: 200,
      cache_read_tokens: 5000,
      cache_creation_tokens: 300,
      cost_usd: 1.23,
    },
  ],
  cache_breaks: {
    ttl_expiry: { count: 1, tokens_lost: 4000 },
  },
};

describe("MarginStatsService", () => {
  it.effect("returns unconfigured when ANTHROPIC_BASE_URL is unset or first-party", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() => Effect.die("must not call HTTP when unconfigured"));

      const unset = yield* make({ getBaseUrl: () => undefined }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      assert.deepStrictEqual(yield* unset.readStats({}), { status: "unconfigured" });

      const firstParty = yield* make({ getBaseUrl: () => "https://api.anthropic.com" }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      assert.deepStrictEqual(yield* firstParty.readStats({}), { status: "unconfigured" });
    }),
  );

  it.effect("reads /stats from a running margin proxy with optional since parameter", () =>
    Effect.gen(function* () {
      let seenUrl: string | undefined;
      const client = HttpClient.make((request) => {
        seenUrl = request.url;
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(SAMPLE_STATS)));
      });

      const service = yield* make({ getBaseUrl: () => "http://127.0.0.1:8787" }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const result = yield* service.readStats({ since: "today" });

      assert.strictEqual(seenUrl, "http://127.0.0.1:8787/stats?since=today");
      assert.deepStrictEqual(result, {
        status: "ready",
        endpoint: "http://127.0.0.1:8787",
        stats: SAMPLE_STATS,
      });
    }),
  );

  it.effect("returns unconfigured when endpoint returns 404 (non-margin proxy)", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
          ),
        ),
      );

      const service = yield* make({ getBaseUrl: () => "http://127.0.0.1:8787" }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const result = yield* service.readStats({});
      assert.deepStrictEqual(result, { status: "unconfigured" });
    }),
  );

  it.effect("returns unavailable when margin endpoint is unreachable", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("ECONNREFUSED"),
            }),
          }),
        ),
      );

      const service = yield* make({ getBaseUrl: () => "http://127.0.0.1:8787" }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const result = yield* service.readStats({});
      assert.strictEqual(result.status, "unavailable");
    }),
  );
});
