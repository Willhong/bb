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
