import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import { describe, expect, it, vi } from "vitest";
import { experimental_registerProviderText } from "../provider-text.js";
import { createFakePluginHost } from "../testing/index.js";
import type { BbPluginApi } from "../backend-contract.js";

const caller = {
  experimental_caller: {
    kind: "plugin",
    pluginId: "personal-assistant",
  } as const,
};
function fixture() {
  type Catalog = Awaited<
    ReturnType<BbPluginApi["sdk"]["system"]["executionOptions"]>
  >;
  const { bb, harness } = createFakePluginHost({
    sdk: {
      system: {
        config: async () => ({ primaryHostId: "paired-host" }),
        executionOptions: async () =>
          ({
            providers: [makeProviderInfo({ id: "acp-test" })],
            permissionCeiling: "full",
            selectedOnlyModels: [],
            modelLoadError: null,
            models: [
              {
                id: "native-id",
                model: "native-id",
                displayName: "Native",
                description: "",
                reasoningDiscovery: "known",
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [],
                isDefault: true,
              },
            ],
          }) as Catalog,
      },
    },
  });
  const complete = vi.fn(async (input) => ({ ...input, text: "native reply" }));
  experimental_registerProviderText(bb, {
    owns: (id) => id === "acp-test",
    ready: async () => ({ ready: true }),
    complete,
  });
  return { call: harness.behavior.callRpc, complete };
}
describe("native provider foreground dispatch", () => {
  const input = {
    providerId: "acp-test",
    model: "native-id",
    text: "synthetic",
  };
  it("requires the personal assistant caller and an owned provider", async () => {
    const { call, complete } = fixture();
    await expect(
      call("experimental_assistantProviderComplete", input),
    ).rejects.toThrow(/caller/);
    await expect(
      call(
        "experimental_assistantProviderComplete",
        { ...input, providerId: "other" },
        caller,
      ),
    ).rejects.toThrow(/caller/);
    expect(complete).not.toHaveBeenCalled();
  });
  it("permits a native model with no reasoning selector and uses the primary host", async () => {
    const { call, complete } = fixture();
    await expect(
      call("experimental_assistantProviderComplete", input, caller),
    ).resolves.toEqual({ ...input, text: "native reply" });
    expect(complete).toHaveBeenCalledWith(
      input,
      "paired-host",
      expect.any(AbortSignal),
    );
    await expect(
      call(
        "experimental_assistantProviderComplete",
        { ...input, reasoningLevel: "high" },
        caller,
      ),
    ).rejects.toThrow(/reasoning/);
    await expect(
      call(
        "experimental_assistantProviderComplete",
        { ...input, model: "alias" },
        caller,
      ),
    ).rejects.toThrow(/model/);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("rejects a provider receipt that substitutes the selected model", async () => {
    const { call, complete } = fixture();
    complete.mockImplementationOnce(async (input) => ({
      ...input,
      model: "other",
      text: "wrong",
    }));
    await expect(
      call("experimental_assistantProviderComplete", input, caller),
    ).rejects.toThrow(/confirm/);
  });
});
