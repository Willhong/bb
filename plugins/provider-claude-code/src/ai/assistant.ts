import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ExperimentalProviderTextInput } from "@get-bb/plugin-sdk/provider-conversation";
import { experimental_resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";

export async function claudeAssistantReady() {
  const executable =
    process.env.BB_CLAUDE_CODE_EXECUTABLE?.trim() ||
    (await experimental_resolveExecutablePath("claude", process.env));
  return { ready: !!executable };
}

export function claudeTextOptions(
  input: ExperimentalProviderTextInput,
  cwd: string,
  controller: AbortController,
): Options {
  const level = input.reasoningLevel;
  if (
    level !== undefined &&
    !["none", "low", "medium", "high", "xhigh", "max", "ultracode"].includes(
      level,
    )
  )
    throw new Error("Claude Code does not support the selected effort.");
  return {
    cwd,
    model: input.model,
    abortController: controller,
    systemPrompt:
      "You are a personal assistant answering a foreground text message. You have no filesystem, shell, MCP or external tools.",
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    canUseTool: async () => ({
      behavior: "deny",
      message: "This conversation is text-only.",
    }),
    settingSources: ["user"],
    persistSession: false,
    maxTurns: 1,
    settings: {
      disableAllHooks: true,
      autoMemoryEnabled: false,
      enableWorkflows: false,
      ultracode: level === "ultracode",
    },
    extraArgs: { "disable-slash-commands": null, "no-chrome": null },
    env: process.env,
    ...(process.env.BB_CLAUDE_CODE_EXECUTABLE
      ? { pathToClaudeCodeExecutable: process.env.BB_CLAUDE_CODE_EXECUTABLE }
      : {}),
    ...(level === "none"
      ? { thinking: { type: "disabled" } as const }
      : level === undefined
        ? {}
        : {
            effort: (level === "ultracode"
              ? "high"
              : level) as Options["effort"],
          }),
  };
}

export async function completeClaudeAssistant(
  input: ExperimentalProviderTextInput,
  cwd: string,
  signal: AbortSignal,
) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  deadline.addEventListener("abort", stop, { once: true });
  let text = "";
  let reportedModel: string | undefined;
  let conversation: ReturnType<typeof query> | undefined;
  try {
    deadline.throwIfAborted();
    const executable =
      process.env.BB_CLAUDE_CODE_EXECUTABLE?.trim() ||
      (await experimental_resolveExecutablePath("claude", process.env));
    if (!executable)
      throw new Error("The primary machine has no Claude Code CLI.");
    conversation = query({
      prompt: input.text,
      options: {
        ...claudeTextOptions(input, cwd, controller),
        pathToClaudeCodeExecutable: executable,
      },
    });
    for await (const message of conversation) {
      deadline.throwIfAborted();
      if (message.type === "system" && message.subtype === "init")
        reportedModel = message.model;
      if (
        message.type === "assistant" &&
        message.message.content.some((block) => block.type === "tool_use")
      )
        throw new Error("Claude attempted a tool in a text-only conversation.");
      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error)
          throw new Error("Claude Code did not complete this text request.");
        text = message.result.trim();
        if (
          reportedModel !== input.model &&
          !Object.hasOwn(message.modelUsage, input.model)
        )
          throw new Error("Claude Code did not confirm the selected model.");
      }
    }
    if (!text || text.length > 12000)
      throw new Error("Claude Code returned no bounded text response.");
    return { ...input, text };
  } finally {
    deadline.removeEventListener("abort", stop);
    controller.abort();
    conversation?.close();
  }
}
