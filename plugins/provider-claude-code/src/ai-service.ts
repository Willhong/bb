import { experimental_registerProviderText } from "@get-bb/plugin-sdk/provider-conversation";
import { claudeAssistantHostContract } from "./ai/assistant-contract.js";
import type { BbPluginApi, PluginAiServiceStatus } from "@get-bb/plugin-sdk";
import {
  claudeAiHostContract,
  type ClaudeAiTextResult,
} from "./ai/host-contract.js";

export const CLAUDE_CODE_AI_SERVICE_ID = "claude-code";

const CLAUDE_TEXT_MODEL = "claude-haiku-4-5";
const COMPLETE_TIMEOUT_MS = 5_000;
const HOST_CALL_GRACE_MS = 1_000;

export function registerClaudeCodeAiService(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: claudeAiHostContract });

  const assistantHost = bb.hosts.experimental_client({
    contract: claudeAssistantHostContract,
  });
  experimental_registerProviderText(bb, {
    owns: (id) => id === "claude-code",
    ready: (_providerId, hostId, signal) =>
      assistantHost.call("assistant.ready", null, {
        hostId,
        signal,
        timeoutMs: 5000,
      }),
    complete: (input, hostId, signal) =>
      assistantHost.call("assistant.complete", input, {
        hostId,
        signal,
        timeoutMs: 50000,
      }),
  });

  async function primaryHostId(): Promise<string | null> {
    return (await bb.sdk.system.config()).primaryHostId;
  }

  function textOrThrow(result: ClaudeAiTextResult): string {
    if (result.ok) return result.text;
    throw new Error(result.message);
  }

  bb.experimental_aiServices.register({
    id: CLAUDE_CODE_AI_SERVICE_ID,
    displayName: "Claude Code (Claude subscription)",
    async complete(prompt, { signal }) {
      const hostId = await primaryHostId();
      if (hostId === null) throw new Error("No primary machine is connected");
      return textOrThrow(
        await host.call(
          "claude.ai.complete",
          { model: CLAUDE_TEXT_MODEL, prompt, timeoutMs: COMPLETE_TIMEOUT_MS },
          {
            hostId,
            signal,
            timeoutMs: COMPLETE_TIMEOUT_MS + HOST_CALL_GRACE_MS,
          },
        ),
      );
    },
    async status(): Promise<PluginAiServiceStatus> {
      const hostId = await primaryHostId();
      if (hostId === null) {
        return { ready: false, message: "No primary machine is connected" };
      }
      return host.call("claude.ai.status", {}, { hostId, timeoutMs: 5_000 });
    },
  });
}
