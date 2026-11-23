import {
  MarginStatsPayload,
  type MarginStatsInput,
  type MarginStatsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";

import { customClaudeApiEndpointHost } from "../provider/Drivers/ClaudeSkills.ts";

const REQUEST_TIMEOUT = Duration.millis(2_500);

export class MarginStatsService extends Context.Service<
  MarginStatsService,
  {
    readonly readStats: (input: MarginStatsInput) => Effect.Effect<MarginStatsResult>;
  }
>()("t3/usage/MarginStatsService") {}

function resolveMarginEndpoint(rawBaseUrl: string | undefined): string | undefined {
  if (customClaudeApiEndpointHost(rawBaseUrl) === undefined) return undefined;
  const parsed = URL.parse(rawBaseUrl?.trim() ?? "");
  return parsed?.origin;
}

export const make = Effect.fnUntraced(function* (options?: {
  readonly getBaseUrl?: () => string | undefined;
}) {
  const httpClient = yield* HttpClient.HttpClient;
  const getBaseUrl = options?.getBaseUrl ?? (() => process.env.ANTHROPIC_BASE_URL);

  const readStats = Effect.fn("MarginStatsService.readStats")(function* (input: MarginStatsInput) {
    const endpoint = resolveMarginEndpoint(getBaseUrl());
    if (!endpoint) {
      return { status: "unconfigured" } satisfies MarginStatsResult;
    }

    const url = new URL("/stats", endpoint);
    if (input.since && input.since.trim().length > 0) {
      url.searchParams.set("since", input.since.trim());
    }

    const response = yield* httpClient
      .execute(HttpClientRequest.get(url.toString()))
      .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.result);

    if (response._tag === "Failure") {
      return {
        status: "unavailable",
        endpoint,
        message: String(response.failure),
      } satisfies MarginStatsResult;
    }

    const res = response.success;
    if (res.status === 404 || res.status === 405) {
      return { status: "unconfigured" } satisfies MarginStatsResult;
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        status: "unavailable",
        endpoint,
        message: `HTTP ${res.status}`,
      } satisfies MarginStatsResult;
    }

    const decoded = yield* HttpClientResponse.schemaBodyJson(MarginStatsPayload)(res).pipe(
      Effect.map((stats) => ({ status: "ready", endpoint, stats }) satisfies MarginStatsResult),
      Effect.orElseSucceed(() => ({ status: "unconfigured" }) satisfies MarginStatsResult),
    );

    return decoded;
  });

  return MarginStatsService.of({ readStats });
});

export const layer = Layer.effect(MarginStatsService, make());
