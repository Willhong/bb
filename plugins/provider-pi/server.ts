import {
  experimental_registerProviderConversation,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { piProviderDeclaration } from "./src/declaration.js";

import { piHostContract } from "./src/assistant-host-contract.js";

export default function plugin(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: piHostContract });
  experimental_registerProviderConversation(bb, "pi", {
    eligible: (model) => model.startsWith("llmhong/"),
    async ready(hostId, signal) {
      return (
        await host.call("pi.assistant.ready", null, {
          hostId,
          signal,
          timeoutMs: 5000,
        })
      ).ready;
    },
    complete: (request, hostId, signal) =>
      host.call("pi.assistant.complete", request, {
        hostId,
        signal,
        timeoutMs: 42_000,
      }),
  });
  const registered = bb.providers.register(piProviderDeclaration());
  bb.onDispose(() => {
    registered.dispose();
  });
}
