import { createMemoryHistory } from "@tanstack/react-router";
import {
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2CompressThreadInput,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  answerRpc,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const CURSOR_PROVIDER = {
  ...CODEX_PROVIDER,
  instanceId: "cursor",
  driver: "cursor",
  models: [{ slug: "composer-2", name: "Composer 2", isCustom: false, capabilities: null }],
  slashCommands: [{ name: "compress" }],
};

const THREADS = {
  claude: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4-6" },
  codex: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  cursor: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
} as const;

async function openThread(provider: keyof typeof THREADS) {
  const stack = new AsyncDisposableStack();
  const thread = threadWithHistory(`thread-compress-${provider}`, 2, THREADS[provider]);
  stack.use(
    installFakeEnvironment([thread], {
      acceptCommands: true,
      providers: [CLAUDE_PROVIDER, CODEX_PROVIDER, CURSOR_PROVIDER],
    }),
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  stack.use(
    await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    }),
  );
  await expect.element(page.getByText(`Answer 1 for ${thread.id}.`)).toBeVisible();
  return { thread, screen: stack.move() };
}

function recordCompressCalls() {
  const calls: OrchestrationV2CompressThreadInput[] = [];
  const answer = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.compressThread,
    (input: { readonly threadId: OrchestrationV2CompressThreadInput["threadId"] }) => {
      calls.push(input as OrchestrationV2CompressThreadInput);
      return Effect.succeed({ runId: RunId.make("compress-run"), sequence: 1 });
    },
  );
  return { calls, [Symbol.dispose]: () => answer[Symbol.dispose]() };
}

const sentTexts = () =>
  dispatchedCommands().flatMap((command) =>
    command.type === "message.dispatch" ? [command.text] : [],
  );

async function typeIntoComposer(text: string) {
  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.type(editor, text);
}

it("runs /compress with its focus on a Claude thread instead of sending it", async () => {
  using compress = recordCompressCalls();
  const { thread, screen } = await openThread("claude");
  await using _screen = screen;

  await typeIntoComposer("/compre");
  await expect.element(page.getByText("/compress", { exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await userEvent.type(page.getByTestId("composer-editor"), "ss keep the API notes");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(compress.calls).toEqual([
      { threadId: thread.id, trigger: "manual", focus: "keep the API notes" },
    ]),
  );
  expect(sentTexts()).toEqual([]);
});

it("sends /recap to Claude as typed", async () => {
  using compress = recordCompressCalls();
  const { screen } = await openThread("claude");
  await using _screen = screen;

  await typeIntoComposer("/recap");
  await userEvent.keyboard("{Escape}");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => expect(sentTexts()).toEqual(["/recap"]));
  expect(compress.calls).toEqual([]);
});

it("sends /compress to Cursor as typed, and offers only Cursor's own command", async () => {
  using compress = recordCompressCalls();
  const { screen } = await openThread("cursor");
  await using _screen = screen;

  await typeIntoComposer("/compress");
  await expect
    .element(page.getByText("Continue in a fresh session seeded with a summary of this thread"))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await userEvent.type(page.getByTestId("composer-editor"), " now");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => expect(sentTexts()).toEqual(["/compress now"]));
  expect(compress.calls).toEqual([]);
});

it("does not offer /compress on a Codex thread", async () => {
  using compress = recordCompressCalls();
  const { screen } = await openThread("codex");
  await using _screen = screen;

  await typeIntoComposer("/compress");
  await expect
    .element(page.getByText("Continue in a fresh session seeded with a summary of this thread"))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => expect(sentTexts()).toEqual(["/compress"]));
  expect(compress.calls).toEqual([]);
});
