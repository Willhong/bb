import { z } from "zod";
import {
  defineRpcContract,
  experimental_PluginRpcRefusal,
} from "./rpc-contract.js";
import type { BbPluginApi } from "./backend-contract.js";

const selection = {
  providerId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u),
  model: z.string().trim().min(1).max(160),
  reasoningLevel: z.string().trim().min(1).max(80).optional(),
};
export const experimental_providerTextContract = defineRpcContract({
  experimental_assistantProviderReady: {
    input: z.object({ providerId: selection.providerId }).strict(),
    output: z
      .object({ ready: z.boolean(), reason: z.string().max(400).optional() })
      .strict(),
  },
  experimental_assistantProviderComplete: {
    input: z
      .object({ ...selection, text: z.string().trim().min(1).max(1500) })
      .strict(),
    output: z
      .object({ ...selection, text: z.string().min(1).max(12000) })
      .strict(),
  },
});
export type ExperimentalProviderTextInput = z.infer<
  typeof experimental_providerTextContract.experimental_assistantProviderComplete.input
>;
export type ExperimentalProviderTextOutput = z.infer<
  typeof experimental_providerTextContract.experimental_assistantProviderComplete.output
>;

/** Register a foreground, text-only route using this plugin's existing provider.
 * Only Personal Assistant can call it; the host and live model catalog remain
 * BB-owned. This route never creates a BB thread or expands tool permissions. */
export function experimental_registerProviderText(
  bb: BbPluginApi,
  options: {
    owns(providerId: string): boolean;
    ready(
      providerId: string,
      hostId: string,
      signal: AbortSignal,
    ): Promise<{ ready: boolean; reason?: string }>;
    complete(
      input: ExperimentalProviderTextInput,
      hostId: string,
      signal: AbortSignal,
    ): Promise<ExperimentalProviderTextOutput>;
  },
) {
  const running = new Set<string>();
  function refuse(message: string): never {
    throw new experimental_PluginRpcRefusal({ code: "forbidden", message });
  }
  bb.rpc.register(experimental_providerTextContract, {
    async experimental_assistantProviderReady(input, context) {
      const caller = context.experimental_caller;
      if (
        caller.kind !== "plugin" ||
        caller.pluginId !== "personal-assistant" ||
        !options.owns(input.providerId)
      )
        refuse("This provider route is not available to this caller.");
      const signal = context.experimental_signal;
      const { primaryHostId } = await bb.sdk.system.config({ signal });
      return primaryHostId
        ? options.ready(input.providerId, primaryHostId, signal)
        : { ready: false };
    },
    async experimental_assistantProviderComplete(input, context) {
      const caller = context.experimental_caller;
      if (
        caller.kind !== "plugin" ||
        caller.pluginId !== "personal-assistant" ||
        !options.owns(input.providerId)
      )
        refuse("This provider route is not available to this caller.");
      if (running.has(input.providerId))
        refuse("This provider is already answering an assistant request.");
      running.add(input.providerId);
      try {
        const signal = context.experimental_signal;
        const { primaryHostId } = await bb.sdk.system.config({ signal });
        if (!primaryHostId) refuse("No primary machine is connected.");
        const catalog = await bb.sdk.system.executionOptions({
          hostId: primaryHostId,
          providerId: input.providerId,
          selectedModel: input.model,
          preferCached: false,
          signal,
        });
        const provider = catalog.providers.find(
          ({ id }) => id === input.providerId,
        );
        const model = catalog.models.find(({ model }) => model === input.model);
        if (!provider?.available || catalog.modelLoadError || !model)
          refuse(
            "BB could not verify the selected provider and model (available=" +
              String(provider?.available) +
              ", catalog=" +
              (catalog.modelLoadError?.code ?? "ok") +
              ", model=" +
              String(!!model) +
              ").",
          );
        if (
          input.reasoningLevel !== undefined &&
          !model.supportedReasoningEfforts.some(
            ({ reasoningEffort }) => reasoningEffort === input.reasoningLevel,
          )
        )
          refuse("BB could not verify the selected reasoning level.");
        const answer = await options.complete(input, primaryHostId, signal);
        if (
          answer.providerId !== input.providerId ||
          answer.model !== input.model ||
          answer.reasoningLevel !== input.reasoningLevel
        )
          refuse("The provider did not confirm the requested selection.");
        return answer;
      } finally {
        running.delete(input.providerId);
      }
    },
  });
}
