import { describe, expect, it, vi } from "vitest";
import { experimental_registerProviderConversation } from "../provider-conversation.js";
import { createFakePluginHost } from "../testing/index.js";
import type { BbPluginApi } from "../backend-contract.js";

describe("assistant provider RPC", () => {
  const input = {
    model: "exact-id",
    reasoningLevel: "low" as const,
    text: "synthetic",
  };
  const caller = {
    experimental_caller: {
      kind: "plugin",
      pluginId: "personal-assistant",
    } as const,
  };

  function setup() {
    type Catalog = Awaited<
      ReturnType<BbPluginApi["sdk"]["system"]["executionOptions"]>
    >;
    const catalog = {
      models: [
        {
          model: "exact-id",
          reasoningDiscovery: "known",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        },
      ],
      providers: [{ id: "codex", available: true }],
      modelLoadError: null,
    } as Catalog;
    const { bb, harness } = createFakePluginHost({
      sdk: {
        system: {
          config: async () => ({ primaryHostId: "host-1" }),
          executionOptions: async () => catalog,
        },
      },
    });
    const complete = vi.fn(async () => ({ ...input, text: "answer" }));
    experimental_registerProviderConversation(bb, "codex", {
      complete,
      ready: async () => true,
    });
    return { rpc: harness.behavior.callRpc, complete };
  }

  it("refuses untrusted callers and unsupported model or effort before dispatch", async () => {
    const { rpc, complete } = setup();
    await expect(rpc("experimental_assistantComplete", input)).rejects.toThrow(
      /Only the personal assistant/,
    );
    await expect(
      rpc(
        "experimental_assistantComplete",
        { ...input, model: "alias" },
        caller,
      ),
    ).rejects.toThrow(/could not be verified/);
    await expect(
      rpc(
        "experimental_assistantComplete",
        { ...input, reasoningLevel: "high" },
        caller,
      ),
    ).rejects.toThrow(/could not be verified/);
    expect(complete).not.toHaveBeenCalled();
  });

  it("uses the primary host and rejects a mismatched provider receipt", async () => {
    const { rpc, complete } = setup();
    await expect(
      rpc("experimental_assistantComplete", input, caller),
    ).resolves.toEqual({ ...input, text: "answer" });
    expect(complete).toHaveBeenCalledWith(
      input,
      "host-1",
      expect.any(AbortSignal),
    );
    complete.mockResolvedValueOnce({ ...input, model: "substituted" });
    await expect(
      rpc("experimental_assistantComplete", input, caller),
    ).rejects.toThrow(/did not confirm/);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
