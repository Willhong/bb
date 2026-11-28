import { hermesTextLaunch } from "./hermes-text-launch.js";
import { experimental_completeAcpText } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { experimental_probeAcpAgent } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { acpHostContract } from "./contract.js";
import { resolveAcpNativeRoots } from "./native-roots/index.js";

export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

export default experimental_defineHostEntry({
  contract: acpHostContract,
  handlers: {
    "assistant.ready": async ({ launch }, context) => {
      const result = await experimental_probeAcpAgent({
        command: launch.command,
        args: launch.args,
        env: launch.env,
        cwd: context.experimental_paths.tempDir,
        timeoutMs: 8000,
      });
      return { ready: result.reachable };
    },
    "assistant.complete": async ({ launch, ...input }, context) => {
      const cwd = await mkdtemp(
        join(context.experimental_paths.tempDir, "assistant-"),
      );
      try {
        const guardedLaunch =
          input.providerId === "acp-hermes-agent"
            ? await hermesTextLaunch(launch, context.signal)
            : input.providerId === "acp-opencode"
              ? {
                  ...launch,
                  env: {
                    ...launch.env,
                    OPENCODE_CONFIG_CONTENT: JSON.stringify({
                      permission: { "*": "deny" },
                      tools: { "*": false },
                    }),
                  },
                }
              : launch;
        const answer = await experimental_completeAcpText({
          ...input,
          launch: guardedLaunch,
          cwd,
          signal: context.signal,
        });
        return { providerId: input.providerId, ...answer };
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    probeAgent: async (input, context) =>
      experimental_probeAcpAgent({
        command: input.command,
        args: input.args,
        env: input.env,
        cwd: context.experimental_paths.tempDir,
      }),
    resolveNativeRoots: (input) =>
      resolveAcpNativeRoots({
        agentId: input.providerId,
        cwd: input.cwd,
        homeDir: os.homedir(),
        env: process.env,
      }),
  },
});
