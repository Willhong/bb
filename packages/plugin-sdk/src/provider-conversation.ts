import type { BbPluginApi } from "./backend-contract.js";
import { experimental_PluginRpcRefusal } from "./rpc-contract.js";
import type { ExperimentalPluginRpcHandlerContext } from "./rpc-contract.js";

import {
  experimental_providerConversationContract,
  type ExperimentalProviderConversationInput,
  type ExperimentalProviderConversationOutput,
} from "./provider-conversation-contract.js";
export * from "./provider-conversation-contract.js";

function refuse(message: string): never {
  throw new experimental_PluginRpcRefusal({ code: "forbidden", message });
}

/** Limits provider access to the installed BB personal assistant, and the
 * primary machine's exact registered model and reasoning selection. */
export function experimental_registerProviderConversation(
  bb: BbPluginApi,
  id: string,
  options: {
    eligible?(model: string): boolean;
    ready(hostId: string, signal: AbortSignal): Promise<boolean>;
    complete(
      input: ExperimentalProviderConversationInput,
      hostId: string,
      signal: AbortSignal,
    ): Promise<ExperimentalProviderConversationOutput>;
  },
) {
  let inProgress = false;
  async function primary(context: ExperimentalPluginRpcHandlerContext) {
    const caller = context.experimental_caller;
    if (caller.kind !== "plugin" || caller.pluginId !== "personal-assistant")
      refuse("Only the personal assistant can use this provider route.");
    const signal = context.experimental_signal;
    const { primaryHostId } = await bb.sdk.system.config({ signal });
    return { hostId: primaryHostId, signal };
  }
  bb.rpc.register(experimental_providerConversationContract, {
    async experimental_assistantReady(_input, context) {
      const { hostId, signal } = await primary(context);
      return { ready: !!hostId && (await options.ready(hostId, signal)) };
    },
    async experimental_assistantComplete(request, context) {
      const { hostId, signal } = await primary(context);
      if (!hostId || !(options.eligible?.(request.model) ?? true))
        refuse("This model has no assistant route on the primary machine.");
      if (inProgress)
        refuse("This provider is already answering an assistant message.");
      inProgress = true;
      try {
        const catalog = await bb.sdk.system.executionOptions({
          hostId,
          providerId: id,
          selectedModel: request.model,
          preferCached: false,
          signal,
        });
        const provider = catalog.providers.find((item) => item.id === id);
        const model = catalog.models.find(
          (item) => item.model === request.model,
        );
        if (
          !provider?.available ||
          catalog.modelLoadError ||
          !model ||
          model.reasoningDiscovery === "unknown" ||
          !model.supportedReasoningEfforts.some(
            (effort) => effort.reasoningEffort === request.reasoningLevel,
          )
        ) {
          refuse(
            "The selected model and effort could not be verified against BB's current provider catalog.",
          );
        }
        const result = await options.complete(request, hostId, signal);
        if (
          result.model !== request.model ||
          result.reasoningLevel !== request.reasoningLevel
        ) {
          refuse("The provider did not confirm the selected model and effort.");
        }
        return result;
      } finally {
        inProgress = false;
      }
    },
  });
}
