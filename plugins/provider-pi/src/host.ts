import { piHostContract } from "./assistant-host-contract.js";
import {
  completePiAssistant,
  piAssistantReady,
} from "./assistant-inference.js";
import { homedir } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { resolvePiNativeRoots } from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

export default experimental_defineHostEntry({
  contract: piHostContract,
  handlers: {
    "pi.assistant.ready": (_input, context) =>
      piAssistantReady(context.signal),
    "pi.assistant.complete": (input, context) =>
      completePiAssistant(input, context.signal),
    resolveNativeRoots: () =>
      resolvePiNativeRoots({ homeDir: homedir(), env: process.env }),
  },
});
