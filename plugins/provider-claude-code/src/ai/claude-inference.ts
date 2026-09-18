import type { JsonValue } from "@get-bb/plugin-sdk";
import {
  jsonValueSchema,
  type JsonObject,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  claudeCredentialsExpired,
  claudeCredentialsPath,
  readClaudeCredentials,
  type ClaudeCredentials,
} from "./claude-auth.js";
import { AiServiceFailure } from "./failure.js";
import type {
  ClaudeAiCompleteInput,
  ClaudeAiFailureCode,
} from "./host-contract.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_CODE_OAUTH_BETAS = "claude-code-20250219,oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.75";
const CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const REPLY_INSTRUCTIONS =
  "Follow the user prompt. Reply with only the requested text, without quotes or commentary.";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_TEXT_BYTES = 4 * 1024;
const MAX_TOKENS = 1024;

interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  system: { type: "text"; text: string }[];
  messages: { role: "user"; content: string }[];
}

function toJsonObject(value: JsonValue | undefined): JsonObject | null {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  return value;
}

function optionalString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function parseJsonValue(raw: string): JsonValue {
  return jsonValueSchema.parse(JSON.parse(raw));
}

function claudeRequestErrorCode(status: number): [ClaudeAiFailureCode, string] {
  if (status === 401 || status === 403) {
    return ["auth_required", "claude_code_auth_failed"];
  }
  if (status === 429) {
    return ["rate_limited", "claude_code_rate_limited"];
  }
  if (status >= 500) {
    return ["service_unavailable", "claude_code_service_unavailable"];
  }
  return ["request_failed", "claude_code_request_failed"];
}

function extractJsonErrorMessage(value: JsonValue): string | null {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/gu, " ").trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractJsonErrorMessage(item);
      if (message) return message;
    }
    return null;
  }
  const object = toJsonObject(value);
  if (!object) return null;
  for (const key of ["message", "detail", "error"]) {
    const child = object[key];
    if (child === undefined) continue;
    const message = extractJsonErrorMessage(child);
    if (message) return message;
  }
  return null;
}

async function readLimitedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AiServiceFailure(
          "invalid_response",
          "claude_code_response_too_large",
          "Claude Code response exceeded the maximum supported size.",
        );
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

async function createHttpError(response: Response): Promise<AiServiceFailure> {
  const prefix = `Claude Code inference request failed with HTTP ${response.status}`;
  const rawText = await readLimitedText(response, MAX_ERROR_TEXT_BYTES).catch(
    () => "",
  );
  let providerMessage: string | null = null;
  const normalized = rawText.replace(/\s+/gu, " ").trim();
  if (normalized.length > 0) {
    try {
      providerMessage =
        extractJsonErrorMessage(parseJsonValue(normalized)) ?? normalized;
    } catch {
      providerMessage = normalized;
    }
  }
  const capped =
    providerMessage && providerMessage.length > 400
      ? `${providerMessage.slice(0, 400)}...`
      : providerMessage;
  return new AiServiceFailure(
    ...claudeRequestErrorCode(response.status),
    `${prefix}${capped ? `: ${capped}` : ""}`,
  );
}

function buildRequest(
  command: ClaudeAiCompleteInput,
): AnthropicMessagesRequest {
  return {
    model: command.model,
    max_tokens: MAX_TOKENS,
    system: [
      { type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT },
      { type: "text", text: REPLY_INSTRUCTIONS },
    ],
    messages: [{ role: "user", content: command.prompt }],
  };
}

function createHeaders(credentials: ClaudeCredentials): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${credentials.accessToken}`);
  headers.set("anthropic-version", ANTHROPIC_VERSION);
  headers.set("anthropic-beta", CLAUDE_CODE_OAUTH_BETAS);
  headers.set("anthropic-dangerous-direct-browser-access", "true");
  headers.set("user-agent", CLAUDE_CODE_USER_AGENT);
  headers.set("x-app", "cli");
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  return headers;
}

function extractReplyText(response: JsonValue): string {
  const object = toJsonObject(response);
  const content =
    object && Array.isArray(object.content) ? object.content : null;
  if (!content) {
    throw new AiServiceFailure(
      "invalid_response",
      "claude_code_response_invalid",
      "Claude Code response did not include message content.",
    );
  }
  const text = content
    .map((item) => {
      const block = toJsonObject(item);
      return block && optionalString(block.type) === "text"
        ? (optionalString(block.text) ?? "")
        : "";
    })
    .join("")
    .trim();
  if (text.length === 0) {
    throw new AiServiceFailure(
      "invalid_response",
      "claude_code_response_invalid",
      "Claude Code response did not include any text.",
    );
  }
  return text;
}

async function requireCredentials(): Promise<ClaudeCredentials> {
  const credentials = await readClaudeCredentials();
  if (credentials === null) {
    throw new AiServiceFailure(
      "auth_required",
      "claude_code_auth_missing",
      `Claude Code credentials not found at ${claudeCredentialsPath()}. Run claude on this host to sign in.`,
    );
  }
  if (claudeCredentialsExpired(credentials)) {
    throw new AiServiceFailure(
      "auth_required",
      "claude_code_auth_expired",
      "Claude Code credentials expired. Run claude on this host to refresh them.",
    );
  }
  return credentials;
}

export async function readClaudeCodeAiStatus(): Promise<
  { ready: true } | { ready: false; message: string }
> {
  try {
    await requireCredentials();
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      message:
        error instanceof Error
          ? error.message
          : "Run `claude` on the primary machine to sign in",
    };
  }
}

export async function completeClaudeCodeInference(
  command: ClaudeAiCompleteInput,
  signal: AbortSignal,
): Promise<string> {
  const credentials = await requireCredentials();
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: createHeaders(credentials),
    body: JSON.stringify(buildRequest(command)),
    signal: AbortSignal.any([signal, AbortSignal.timeout(command.timeoutMs)]),
  });

  if (!response.ok) {
    throw await createHttpError(response);
  }

  const rawText = await readLimitedText(response, MAX_RESPONSE_BYTES);
  let parsed: JsonValue;
  try {
    parsed = parseJsonValue(rawText);
  } catch {
    throw new AiServiceFailure(
      "invalid_response",
      "claude_code_response_invalid",
      "Claude Code response was not valid JSON.",
    );
  }

  return extractReplyText(parsed);
}
