import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
  useComposerDraftSelection: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: vi.fn(),
    refreshProviders: Symbol("refreshProviders"),
  },
}));

import type { ModelOption } from "../../lib/modelOptions";
import {
  buildComposerModelItems,
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
  resolveComposerMenuSelection,
} from "./use-composer-command-menu";

describe("resolveComposerMenuSelection", () => {
  it("prefers the caret an insertion placed in the current draft text", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "hello @chip ",
        ownerKey: "draft-a",
        inserted: { start: 12, end: 12 },
        local: { ownerKey: "draft-a", start: 2, end: 2 },
      }),
    ).toEqual({ start: 12, end: 12 });
  });

  it("clamps the composer's own caret when the draft shrinks", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "hi",
        ownerKey: "draft-a",
        inserted: null,
        local: { ownerKey: "draft-a", start: 5, end: 9 },
      }),
    ).toEqual({ start: 2, end: 2 });
  });

  it("starts at the end of the draft after switching owners", () => {
    expect(
      resolveComposerMenuSelection({
        draftMessage: "other draft",
        ownerKey: "draft-b",
        inserted: null,
        local: { ownerKey: "draft-a", start: 1, end: 1 },
      }),
    ).toEqual({ start: 11, end: 11 });
  });
});

describe("mobile slash commands", () => {
  it("keeps native /plan when interaction mode toggle is disabled", () => {
    const items = buildComposerSlashCommandItems({
      query: "pl",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: false,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("antigravity"),
        showInteractionModeToggle: false,
        slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("provider-slash-command");
    const item = items[0];
    if (!item) throw new Error("Expected the native plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/pl",
        trigger: { rangeStart: 0, rangeEnd: 3 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });

  it("offers T3's /plan in place of a duplicate provider /plan for toggleable providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "pl",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("antigravity"),
        showInteractionModeToggle: true,
        slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("cmd:plan");
  });

  it("offers T3's /clear in place of the provider's, only at the message start", () => {
    const claude = {
      driver: ProviderDriverKind.make("claudeAgent"),
      slashCommands: [{ name: "clear", description: "Clear conversation history" }],
    };
    const build = (offersFreshSession: boolean, atMessageStart = true) =>
      buildComposerSlashCommandItems({
        query: "cle",
        atMessageStart,
        hasThread: true,
        allowInteractionMode: true,
        offersFreshSession,
        selectedProviderStatus: claude,
      }).map((item) => item.id);
    expect(build(true)).toEqual(["cmd:clear"]);
    expect(build(false)).toEqual(["pcmd:clear"]);
    expect(build(true, false)).toEqual([]);
  });

  it("offers T3's /compress only where offered, leaving Cursor's own /compress", () => {
    const cursor = {
      driver: ProviderDriverKind.make("cursor"),
      slashCommands: [{ name: "compress", description: "Compress the conversation" }],
    };
    const build = (offersCompress: boolean, atMessageStart = true) =>
      buildComposerSlashCommandItems({
        query: "compr",
        atMessageStart,
        hasThread: true,
        allowInteractionMode: true,
        offersCompress,
        selectedProviderStatus: offersCompress
          ? { driver: ProviderDriverKind.make("claudeAgent"), slashCommands: [] }
          : cursor,
      });
    expect(build(true).map((item) => item.id)).toEqual(["cmd:compress"]);
    expect(build(false).map((item) => item.id)).toEqual(["pcmd:compress"]);
    expect(build(true, false)).toEqual([]);
    const item = build(true)[0];
    if (!item) throw new Error("Expected T3's /compress");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/compr",
        trigger: { rangeStart: 0, rangeEnd: 6 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "/compress ", cursor: 10, interactionMode: null });
  });

  it("applies the T3 plan command for supported providers", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      allowInteractionMode: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    const item = items[0];
    if (!item) throw new Error("Expected the T3 plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: true,
      }),
    ).toEqual({ text: "", cursor: 0, interactionMode: "plan" });

    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item,
        allowInteractionMode: false,
      }),
    ).toEqual({ text: "/plan ", cursor: 6, interactionMode: null });
  });
});

describe("mobile model mentions", () => {
  const provider = (
    instanceId: string,
    overrides: Partial<ServerProvider> = {},
  ): ServerProvider => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  });
  const option = (key: string, overrides: Partial<ModelOption> = {}): ModelOption => {
    const [instanceId = "", model = ""] = key.split(":");
    return {
      key,
      label: "GPT-6.1",
      subtitle: "",
      providerKey: instanceId,
      providerLabel: "Traex",
      providerDriver: "codex",
      isDefault: false,
      isLegacy: false,
      capabilities: null,
      selection: { instanceId: ProviderInstanceId.make(instanceId), model },
      ...overrides,
    };
  };

  it("offers current, visible models labelled with their provider", () => {
    const items = buildComposerModelItems(
      [
        option("traex:gpt-6.1"),
        option("opencode:traex/gpt-6.1", {
          subtitle: "Traex",
          providerLabel: "OpenCode",
          providerDriver: "opencode",
        }),
        option("hidden:gpt-6.1", { isHidden: true }),
        option("gone:gpt-6.1", { isUnavailable: true }),
        option("old:gpt-5", { label: "GPT-5", isLegacy: true }),
      ],
      "gpt",
      ["traex", "opencode", "hidden", "gone", "old"].map((id) => provider(id)),
    );
    expect(items.map((item) => [item.id, item.description]).toSorted()).toEqual([
      ["model:opencode:traex/gpt-6.1", "OpenCode · Traex"],
      ["model:traex:gpt-6.1", "Traex"],
    ]);
  });

  it.each([
    ["missing", []],
    ["not installed", [provider("traex", { installed: false })]],
    ["signed out", [provider("traex", { auth: { status: "unauthenticated" } })]],
    ["not ready", [provider("traex", { status: "error" })]],
    ["unavailable", [provider("traex", { availability: "unavailable" })]],
  ] as const)("does not suggest a preserved selection whose provider is %s", (_, providers) => {
    expect(buildComposerModelItems([option("traex:gpt-6.1")], "gpt", providers)).toEqual([]);
  });
});
