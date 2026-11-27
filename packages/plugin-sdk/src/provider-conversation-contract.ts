import { z } from "zod";
import { defineRpcContract } from "./rpc-contract.js";

const selection = {
  model: z.string().trim().min(1).max(160),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "max"]),
};
const input = z
  .object({ ...selection, text: z.string().trim().min(1).max(1500) })
  .strict();
const output = z
  .object({ ...selection, text: z.string().min(1).max(12000) })
  .strict();

export const experimental_providerConversationContract = defineRpcContract({
  experimental_assistantComplete: { input, output },
  experimental_assistantReady: {
    input: z.null(),
    output: z.object({ ready: z.boolean() }).strict(),
  },
});

export type ExperimentalProviderConversationInput = z.infer<typeof input>;
export type ExperimentalProviderConversationOutput = z.infer<typeof output>;
