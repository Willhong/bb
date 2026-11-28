import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_providerTextContract } from "@get-bb/plugin-sdk/provider-conversation";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { z } from "zod";

export const acpAssistantHostContract = defineRpcContract({
  "assistant.ready": {
    input: z.object({ launch: experimental_acpLaunchSpecSchema }).strict(),
    output:
      experimental_providerTextContract.experimental_assistantProviderReady
        .output,
  },
  "assistant.complete": {
    input:
      experimental_providerTextContract.experimental_assistantProviderComplete.input
        .extend({ launch: experimental_acpLaunchSpecSchema })
        .strict(),
    output:
      experimental_providerTextContract.experimental_assistantProviderComplete
        .output,
  },
});
