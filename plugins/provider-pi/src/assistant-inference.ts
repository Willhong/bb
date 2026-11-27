import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExperimentalProviderConversationInput } from "@get-bb/plugin-sdk";
import { experimental_resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolvePiLaunch } from "./bridge/rpc-child.js";

async function openRuntime(signal: AbortSignal): Promise<ModelRuntime> {
  const launch = resolvePiLaunch(process.env);
  if (launch.args.length)
    throw new Error(
      "A custom Pi launcher needs a provider-owned inference adapter.",
    );
  const bin = await experimental_resolveExecutablePath(
    launch.command,
    process.env,
  );
  if (!bin) throw new Error("The primary machine has no Pi launcher.");
  const cli = await realpath(bin);
  const dir = dirname(dirname(dirname(cli)));
  const manifest = JSON.parse(
    await readFile(join(dir, "package.json"), "utf8"),
  ) as {
    name?: string;
    exports?: { ".": { import?: string } };
  };
  const entry = manifest.exports?.["."]?.import;
  if (
    manifest.name !== "@earendil-works/pi-coding-agent" ||
    entry !== "./dist/index.js"
  ) {
    throw new Error(
      "The installed Pi launcher does not expose its model runtime.",
    );
  }
  const pi = (await import(
    pathToFileURL(join(dir, entry)).href
  )) as typeof import("@earendil-works/pi-coding-agent");
  return pi.ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal,
  });
}

export async function piAssistantReady(signal: AbortSignal) {
  try {
    const runtime = await openRuntime(signal);
    return runtime
      .getModels("llmhong")
      .some(
        (model) =>
          model.api === "openai-completions" &&
          new URL(model.baseUrl).origin === "https://llm.hktlabs.com",
      );
  } catch {
    return false;
  }
}

export async function completePiAssistant(
  input: ExperimentalProviderConversationInput,
  signal: AbortSignal,
) {
  if (!input.model.startsWith("llmhong/") || input.reasoningLevel === "none") {
    throw new Error(
      "The selected Pi route or effort is not available for assistant inference.",
    );
  }
  const runtime = await openRuntime(signal);
  const id = input.model.slice("llmhong/".length);
  const model = runtime.getModel("llmhong", id);
  if (
    !model ||
    model.api !== "openai-completions" ||
    new URL(model.baseUrl).origin !== "https://llm.hktlabs.com"
  ) {
    throw new Error(
      "The selected Pi model no longer belongs to the configured self-hosted route.",
    );
  }

  let checkedPayload = false;
  const answer = await runtime.completeSimple(
    model,
    {
      systemPrompt:
        "You are a personal assistant in chat-only mode. Answer briefly. You have no access to BB files, tools, or schedules.",
      messages: [{ role: "user", content: input.text, timestamp: Date.now() }],
    },
    {
      signal,
      maxTokens: 512,
      reasoning: input.reasoningLevel,
      onPayload(payload) {
        if (
          !payload ||
          typeof payload !== "object" ||
          !("model" in payload) ||
          payload.model !== model.id ||
          !("reasoning_effort" in payload) ||
          payload.reasoning_effort !== input.reasoningLevel ||
          "tools" in payload
        ) {
          throw new Error(
            "Pi could not transmit the selected model and effort without tools.",
          );
        }
        checkedPayload = true;
      },
    },
  );
  if (
    !checkedPayload ||
    answer.stopReason !== "stop" ||
    answer.provider !== model.provider ||
    answer.responseModel !== model.id ||
    answer.content.some((item) => item.type === "toolCall")
  ) {
    throw new Error(
      "Pi did not confirm the requested route and model in a completed text response.",
    );
  }
  const text = answer.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("")
    .trim();
  if (!text || text.length > 12000)
    throw new Error("Pi did not return usable text.");
  return { model: input.model, reasoningLevel: input.reasoningLevel, text };
}
