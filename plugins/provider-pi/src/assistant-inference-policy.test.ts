import { expect, test } from "vitest";
import {
  isPiAssistantModel,
  parsePiAssistantSelection,
  piAssistantPayloadMatches,
  piAssistantStreamModel,
} from "./assistant-inference-policy.js";

test("binds each Pi selection to its configured endpoint and API", () => {
  const model = {
    provider: "llmproxy",
    baseUrl: "https://llmproxy.hktlabs.com/v1",
    api: "openai-responses",
  };
  expect(parsePiAssistantSelection("llmproxy/gpt-6-luna")).toEqual({
    provider: "llmproxy",
    id: "gpt-6-luna",
  });
  expect(parsePiAssistantSelection("gpt-6-luna")).toBeNull();
  expect(parsePiAssistantSelection("other/gpt-6-luna")).toBeNull();
  expect(isPiAssistantModel(model, "llmproxy")).toBe(true);
  expect(isPiAssistantModel(model, "llmhong")).toBe(false);
  expect(isPiAssistantModel({ ...model, baseUrl: "https://other.test" }, "llmproxy")).toBe(false);
});

test("matches the native reasoning field and refuses tools, stored responses, and wrong IDs", () => {
  const id = "selected";
  const responseModel = { id, api: "openai-responses" };
  const body = { model: id, reasoning: { effort: "low" }, store: false };
  expect(piAssistantPayloadMatches(body, responseModel, "low")).toBe(true);
  expect(piAssistantPayloadMatches(body, responseModel, "high")).toBe(false);
  expect(piAssistantPayloadMatches({ ...body, tools: [{ type: "function" }] }, responseModel, "low")).toBe(false);
  expect(piAssistantPayloadMatches({ ...body, store: true }, responseModel, "low")).toBe(false);
  expect(piAssistantPayloadMatches({ ...body, model: "fallback" }, responseModel, "low")).toBe(false);
  expect(piAssistantPayloadMatches({ model: id, output_config: { effort: "low" } }, { id, api: "anthropic-messages" }, "low")).toBe(true);
  expect(piAssistantPayloadMatches({ model: id, reasoning_effort: "low" }, { id, api: "openai-completions" }, "low")).toBe(true);
});

test("reads model identity from each wire protocol without relying on fallback-only metadata", () => {
  expect(piAssistantStreamModel({ type: "message_start", message: { model: "selected" } })).toBe("selected");
  expect(piAssistantStreamModel({ type: "response.completed", response: { model: "fallback" } })).toBe("fallback");
  expect(piAssistantStreamModel({ object: "chat.completion.chunk", model: "selected" })).toBe("selected");
  expect(piAssistantStreamModel({ type: "response.output_text.delta", delta: "selected" })).toBeUndefined();
});
