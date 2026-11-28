import { claudeAssistantHostContract } from "./ai/assistant-contract.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  claudeAssistantReady,
  completeClaudeAssistant,
} from "./ai/assistant.js";
import os from "node:os";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import {
  completeClaudeCodeInference,
  readClaudeCodeAiStatus,
} from "./ai/claude-inference.js";
import { toAiServiceFailure } from "./ai/failure.js";
import {
  claudeAiHostContract,
  type ClaudeAiTextResult,
} from "./ai/host-contract.js";
import { resolveClaudeNativeRoots } from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

const claudeCodeHostContract = defineRpcContract({
  ...claudeAiHostContract,
  ...claudeAssistantHostContract,
  ...experimental_nativeRootsHostContract,
});

async function textResult(work: Promise<string>): Promise<ClaudeAiTextResult> {
  try {
    return { ok: true, text: await work };
  } catch (error) {
    return toAiServiceFailure(error);
  }
}

export default experimental_defineHostEntry({
  contract: claudeCodeHostContract,
  handlers: {
    "assistant.ready": () => claudeAssistantReady(),
    "assistant.complete": async (input, context) => {
      const cwd = await mkdtemp(
        join(context.experimental_paths.tempDir, "assistant-"),
      );
      try {
        return await completeClaudeAssistant(input, cwd, context.signal);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    resolveNativeRoots: (input) =>
      resolveClaudeNativeRoots({
        cwd: input.cwd,
        homeDir: os.homedir(),
        env: process.env,
      }),
    "claude.ai.complete": (input, context) =>
      textResult(completeClaudeCodeInference(input, context.signal)),
    "claude.ai.status": () => readClaudeCodeAiStatus(),
  },
});
