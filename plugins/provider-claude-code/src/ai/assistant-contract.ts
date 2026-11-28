import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_providerTextContract } from "@get-bb/plugin-sdk/provider-conversation";
import { z } from "zod";

export const claudeAssistantHostContract = defineRpcContract({
  "assistant.ready": {
    input: z.null(),
    output:
      experimental_providerTextContract.experimental_assistantProviderReady
        .output,
  },
  "assistant.complete":
    experimental_providerTextContract.experimental_assistantProviderComplete,
});
