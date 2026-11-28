import { expect, it } from "vitest";
import { openCodeTextLaunch } from "./opencode-text-launch.js";
it("keeps the registered provider settings while denying every native tool", () => {
  const original = {
    displayName: "OpenCode",
    command: "opencode",
    args: ["acp"],
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { existing: { baseURL: "https://example.invalid" } },
        permission: { "*": "allow" },
      }),
    },
  };
  const guarded = openCodeTextLaunch(original);
  expect(JSON.parse(guarded.env.OPENCODE_CONFIG_CONTENT)).toEqual({
    provider: { existing: { baseURL: "https://example.invalid" } },
    permission: { "*": "deny" },
    tools: { "*": false },
  });
  expect(JSON.parse(original.env.OPENCODE_CONFIG_CONTENT).permission["*"]).toBe(
    "allow",
  );
});
