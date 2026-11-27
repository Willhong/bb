const routes = {
  llmhong: {
    origin: "https://llm.hktlabs.com",
    apis: ["openai-completions"],
  },
  llmproxy: {
    origin: "https://llmproxy.hktlabs.com",
    apis: ["openai-responses", "anthropic-messages"],
  },
};

export type PiAssistantRoute = keyof typeof routes;

export function parsePiAssistantSelection(
  selection: string,
): { provider: PiAssistantRoute; id: string } | null {
  const index = selection.indexOf("/");
  const provider = selection.slice(0, index);
  if (
    index <= 0 ||
    index === selection.length - 1 ||
    (provider !== "llmhong" && provider !== "llmproxy")
  ) {
    return null;
  }
  return { provider, id: selection.slice(index + 1) };
}

export function isPiAssistantSelection(selection: string): boolean {
  return parsePiAssistantSelection(selection) !== null;
}

export function isPiAssistantModel(
  model: { provider: string; api: string; baseUrl: string },
  provider: PiAssistantRoute,
): boolean {
  const route = routes[provider];
  const url = URL.parse(model.baseUrl);
  return (
    model.provider === provider &&
    url?.origin === route.origin &&
    !url.username &&
    !url.password &&
    route.apis.includes(model.api)
  );
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function piAssistantPayloadMatches(
  value: unknown,
  model: { id: string; api: string },
  effort: string,
): boolean {
  const payload = object(value);
  if (
    !payload ||
    payload.model !== model.id ||
    (payload.tools !== undefined &&
      (!Array.isArray(payload.tools) || payload.tools.length > 0)) ||
    payload.tool_choice !== undefined
  ) {
    return false;
  }
  switch (model.api) {
    case "openai-completions":
      return payload.reasoning_effort === effort;
    case "openai-responses":
      return (
        payload.store === false &&
        payload.previous_response_id === undefined &&
        object(payload.reasoning)?.effort === effort
      );
    case "anthropic-messages":
      return object(payload.output_config)?.effort === effort;
    default:
      return false;
  }
}

export function piAssistantStreamModel(value: unknown): string | undefined {
  const event = object(value);
  const result =
    event?.type === "message_start"
      ? object(event.message)?.model
      : event?.type === "response.created" ||
          event?.type === "response.completed"
        ? object(event.response)?.model
        : event?.object === "chat.completion.chunk"
          ? event.model
          : undefined;
  return typeof result === "string" && result.length > 0 ? result : undefined;
}
