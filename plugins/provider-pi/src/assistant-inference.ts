import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExperimentalProviderConversationInput } from "@get-bb/plugin-sdk";
import { experimental_resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolvePiLaunch } from "./bridge/rpc-child.js";
import {
  isPiAssistantModel,
  parsePiAssistantSelection,
  piAssistantPayloadMatches,
  piAssistantStreamModel,
} from "./assistant-inference-policy.js";

type RuntimeOptions = NonNullable<Parameters<ModelRuntime["completeSimple"]>[2]>;

interface AssistantModelRuntime extends Omit<ModelRuntime, "completeSimple"> {
  getPhysicalModel(
    provider: string,
    id: string,
  ): ReturnType<ModelRuntime["getModel"]>;
  completeSimple(
    model: Parameters<ModelRuntime["completeSimple"]>[0],
    context: Parameters<ModelRuntime["completeSimple"]>[1],
    options: RuntimeOptions & {
      onProviderStreamEvent(event: unknown): void;
      maxRetries: number;
    },
  ): ReturnType<ModelRuntime["completeSimple"]>;
}

async function openRuntime(signal: AbortSignal): Promise<AssistantModelRuntime> {
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
  const runtime = await pi.ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal,
  });
  if (!("getPhysicalModel" in runtime) || typeof runtime.getPhysicalModel !== "function") {
    throw new Error("The installed Pi runtime cannot verify a physical model.");
  }
  return runtime as AssistantModelRuntime;
}

export async function piAssistantReady(signal: AbortSignal) {
  try {
    const runtime = await openRuntime(signal);
    const providers = ["llmhong", "llmproxy"] as const;
    await runtime.refresh({ allowNetwork: false, providers: [...providers], signal });
    signal.throwIfAborted();
    const models = providers.flatMap((provider) =>
      runtime.hasConfiguredAuth(provider)
        ? runtime
            .getModels(provider)
            .filter((model) => isPiAssistantModel(model, provider))
            .map((model) => `${provider}/${model.id}`)
        : [],
    );
    return { ready: models.length > 0, models };
  } catch {
    return { ready: false, models: [] };
  }
}

export async function completePiAssistant(
  input: ExperimentalProviderConversationInput,
  signal: AbortSignal,
) {
  const selection = parsePiAssistantSelection(input.model);
  if (!selection || input.reasoningLevel === "none") {
    throw new Error(
      "The selected Pi route or effort is not available for assistant inference.",
    );
  }
  const runtime = await openRuntime(signal);
  const model = runtime.getPhysicalModel(selection.provider, selection.id);
  if (!model || !isPiAssistantModel(model, selection.provider)) {
    throw new Error(
      "The selected Pi model is missing from the text-only model runtime.",
    );
  }
  const requestedEffort = input.reasoningLevel;
  const effort = model.thinkingLevelMap?.[requestedEffort] ?? requestedEffort;
  if (model.thinkingLevelMap?.[requestedEffort] === null) {
    throw new Error("Pi does not support this reasoning effort for the model.");
  }

  let checkedPayload = false;
  let sawSelectedModel = false;
  let sawOtherModel = false;
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
      maxRetries: 0,
      reasoning: requestedEffort,
      onPayload(payload) {
        if (!piAssistantPayloadMatches(payload, model, effort)) {
          throw new Error(
            "Pi could not transmit the selected model and effort without tools.",
          );
        }
        checkedPayload = true;
      },
      onProviderStreamEvent(event) {
        const responseModel = piAssistantStreamModel(event);
        if (responseModel === model.id) sawSelectedModel = true;
        else if (responseModel !== undefined) sawOtherModel = true;
      },
    },
  );
  if (
    !checkedPayload ||
    !sawSelectedModel ||
    sawOtherModel ||
    answer.stopReason !== "stop" ||
    answer.provider !== model.provider ||
    (answer.responseModel !== undefined && answer.responseModel !== model.id) ||
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
