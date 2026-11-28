import { expect, it } from "vitest";
import { claudeTextOptions } from "./assistant.js";
it("uses the native Claude model and disables tools, hooks, memory and session persistence", async () => {
  const options = claudeTextOptions(
    {
      providerId: "claude-code",
      model: "selected-native-model",
      reasoningLevel: "high",
      text: "synthetic",
    },
    "/isolated",
    new AbortController(),
  );
  expect(options.model).toBe("selected-native-model");
  expect(options.effort).toBe("high");
  expect(options.tools).toEqual([]);
  expect(options.mcpServers).toEqual({});
  expect(options.permissionMode).toBe("dontAsk");
  expect(options.persistSession).toBe(false);
  expect(options.settings).toMatchObject({
    disableAllHooks: true,
    autoMemoryEnabled: false,
  });
  expect(options).not.toHaveProperty("fallbackModel");
  expect(
    await options.canUseTool!(
      "Read",
      {},
      {
        signal: new AbortController().signal,
        toolUseID: "synthetic",
        requestId: "synthetic",
      },
    ),
  ).toMatchObject({ behavior: "deny" });
});
