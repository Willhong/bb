import { describe, expect, it } from "vitest";
import {
  PI_SERVICE_TIER_EXTENSION_SOURCE,
  resolvePiFastMode,
} from "./service-tier.js";
import {
  buildPiSessionParams,
  buildPiShellEnvOverrides,
} from "./session-params.js";
import { buildPiAvailableModels } from "./model-list.js";

type Model = { provider: string; api: string; id: string };
type Hook = (
  event: {
    payload?: Record<string, unknown>;
    headers?: Record<string, string>;
  },
  ctx: { model: Model },
) => Record<string, unknown> | undefined;
function harness(tier: string) {
  const hooks = new Map<string, Hook>();
  const register = new Function(
    "process",
    `${PI_SERVICE_TIER_EXTENSION_SOURCE}; return registerBbServiceTier;`,
  )({ env: { BB_PI_SERVICE_TIER: tier } });
  register({ on: (name: string, hook: Hook) => hooks.set(name, hook) });
  return (name: string, event: Parameters<Hook>[0], model: Model) =>
    hooks.get(name)!(event, { model });
}
const openai = {
  provider: "llmproxy",
  api: "openai-responses",
  id: "gpt-6.1-sol",
};
const opus = {
  provider: "llmproxy",
  api: "anthropic-messages",
  id: "claude-opus-5-5",
};

describe("Pi BB service tiers", () => {
  it.each(["openai-responses", "openai-completions", "openai-codex-responses"])(
    "requests priority for %s without mutating the payload",
    (api) => {
      const payload = { model: openai.id, messages: [], temperature: 0.2 };
      expect(
        harness("fast")(
          "before_provider_request",
          { payload },
          { ...openai, api },
        ),
      ).toEqual({ ...payload, service_tier: "priority" });
      expect(payload).not.toHaveProperty("service_tier");
      expect(
        harness("default")(
          "before_provider_request",
          { payload: { ...payload, service_tier: "priority" } },
          { ...openai, api },
        ),
      ).toEqual({ ...payload, service_tier: "default" });
    },
  );
  it("uses Anthropic speed, not OpenAI priority, for Opus 5.5", () => {
    expect(
      harness("fast")(
        "before_provider_request",
        { payload: { model: opus.id } },
        opus,
      ),
    ).toEqual({ model: opus.id, speed: "fast" });
    const headers = { "anthropic-beta": "existing-beta" };
    harness("fast")("before_provider_headers", { headers }, opus);
    expect(headers["anthropic-beta"]).toBe("existing-beta");
    expect(
      harness("default")(
        "before_provider_request",
        { payload: { speed: "fast", model: opus.id } },
        opus,
      ),
    ).toEqual({ model: opus.id });
  });
  it.each(["claude-opus-5", "claude-opus-4-8", "claude-opus-4-8-20260901"])(
    "merges and deduplicates the required beta header for %s",
    (id) => {
      const model = { ...opus, id };
      const hook = harness("fast");
      const headers = { "Anthropic-Beta": "existing-beta" };
      hook("before_provider_headers", { headers }, model);
      hook("before_provider_headers", { headers }, model);
      expect(headers["Anthropic-Beta"]).toBe(
        "existing-beta,fast-mode-2026-02-01",
      );
      expect(
        hook("before_provider_request", { payload: { model: id } }, model),
      ).toEqual({ model: id, speed: "fast" });
    },
  );
  it.each([
    { ...opus, id: "claude-sonnet-5-5" },
    { ...opus, id: "claude-opus-4-6" },
    { ...opus, api: "bedrock-converse-stream" },
    { ...opus, api: "openai-completions" },
    { ...openai, id: "qwen3.8-27b" },
    { ...openai, provider: "unknown-proxy" },
  ])(
    "does not advertise or silently apply fast for $provider/$id/$api",
    (model) => {
      expect(resolvePiFastMode(model)).toBeUndefined();
      expect(() =>
        harness("fast")("before_provider_request", { payload: {} }, model),
      ).toThrow(/not supported/);
      expect(
        harness("default")("before_provider_request", { payload: {} }, model),
      ).toBeUndefined();
    },
  );
  it("uses the same policy in the model picker", () => {
    const models = [openai, opus, { ...opus, id: "claude-sonnet-5-5" }].map(
      (model) => ({
        ...model,
        input: ["text"],
        name: model.id,
        reasoning: false,
        supportedThinkingLevels: ["off"],
      }),
    );
    const result = buildPiAvailableModels({ models });
    expect(
      result.models.map((model) =>
        model.supportedServiceTiers?.map((tier) => tier.id),
      ),
    ).toEqual([["default", "fast"], ["default", "fast"], ["default"]]);
  });
  it("forwards and resets the tier through the existing child environment contract", () => {
    const options = {
      serviceTier: "fast",
      envVars: { BB_PI_SERVICE_TIER: "default", TEST: "value" },
    };
    const params = buildPiSessionParams({
      threadId: "thread",
      cwd: "/tmp",
      options,
      instructionMode: "append",
    });
    expect(params.shellEnvOverrides).toEqual(
      buildPiShellEnvOverrides("thread", options),
    );
    expect(params.shellEnvOverrides).toMatchObject({
      BB_PI_SERVICE_TIER: "fast",
      TEST: "value",
    });
    expect(buildPiShellEnvOverrides("thread", {})).toMatchObject({
      BB_PI_SERVICE_TIER: "default",
    });
    expect(() =>
      buildPiShellEnvOverrides("thread", { serviceTier: "ultrafast" }),
    ).toThrow(/Unsupported/);
  });
});
