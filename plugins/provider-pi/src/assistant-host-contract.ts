import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_providerConversationContract } from "@get-bb/plugin-sdk/host";
import { experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";

export const piHostContract = defineRpcContract({
  ...experimental_nativeRootsHostContract,
  "pi.assistant.ready":
    experimental_providerConversationContract.experimental_assistantReady,
  "pi.assistant.complete":
    experimental_providerConversationContract.experimental_assistantComplete,
});
