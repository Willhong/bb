export function resolvePiFastMode(model: {
  api?: string;
  id: string;
  provider: string;
}): "openai" | "anthropic" | "anthropic-beta" | undefined {
  if (
    (model.provider === "openai" ||
      model.provider === "openai-codex" ||
      (model.provider === "llmproxy" &&
        /^(?:gpt-|o[1-9](?:-|$))/.test(model.id))) &&
    (model.api === "openai-responses" ||
      model.api === "openai-completions" ||
      model.api === "openai-codex-responses")
  ) {
    return "openai";
  }
  if (
    (model.provider === "anthropic" || model.provider === "llmproxy") &&
    model.api === "anthropic-messages"
  ) {
    if (/^claude-opus-5-5(?:-|$)/.test(model.id)) return "anthropic";
    if (/^claude-opus-(?:5|4-8)(?:-\d{8})?$/.test(model.id))
      return "anthropic-beta";
  }
  return undefined;
}

export const PI_SERVICE_TIER_EXTENSION_SOURCE = `
const resolvePiFastMode = ${resolvePiFastMode.toString()};
function registerBbServiceTier(pi) {
  const enabled = () => process.env.BB_PI_SERVICE_TIER === "fast";
  pi.on("before_provider_headers", (event, ctx) => {
    if (!enabled() || !ctx.model || resolvePiFastMode(ctx.model) !== "anthropic-beta") return;
    const key = Object.keys(event.headers).find(key => key.toLowerCase() === "anthropic-beta") || "anthropic-beta";
    const betas = (event.headers[key] || "").split(",").map(value => value.trim()).filter(Boolean);
    if (!betas.includes("fast-mode-2026-02-01")) betas.push("fast-mode-2026-02-01");
    event.headers[key] = betas.join(",");
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!ctx.model || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
    const mode = resolvePiFastMode(ctx.model);
    if (!mode) {
      if (enabled()) throw new Error("Fast mode is not supported for this Pi model/API connection. Select Default or a supported model.");
      return;
    }
    if (mode === "openai") return { ...event.payload, service_tier: enabled() ? "priority" : "default" };
    if (enabled()) return { ...event.payload, speed: "fast" };
    const payload = { ...event.payload };
    delete payload.speed;
    return payload;
  });
}
`;
