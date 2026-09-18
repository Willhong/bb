import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const state = vi.hoisted(() => ({
  keychain: "",
  file: "",
}));

vi.mock("@get-bb/plugin-sdk/process", () => ({
  experimental_execHostFile: () =>
    Promise.resolve({ stdout: state.keychain, stderr: "" }),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: (file: string) =>
      file.endsWith(".credentials.json")
        ? Promise.resolve(state.file)
        : Promise.reject(new Error("ENOENT")),
  },
}));

import type { ClaudeAiCompleteInput } from "./host-contract.js";
import { completeClaudeCodeInference } from "./claude-inference.js";

const originalPlatform = process.platform;

const command: ClaudeAiCompleteInput = {
  model: "claude-haiku-4-5",
  prompt: "Name this thread",
  timeoutMs: 5_000,
};

const signal = new AbortController().signal;

function credentialsJson(expiresAt: number | null): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat-test-token",
      expiresAt,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_5x",
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
});

afterAll(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
  vi.unstubAllGlobals();
});

beforeEach(() => {
  state.file = credentialsJson(null);
  state.keychain = "";
  vi.unstubAllGlobals();
});

describe("Claude Code inference", () => {
  it("returns the reply text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [{ type: "text", text: "  Fix titles\n" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeClaudeCodeInference(command, signal)).resolves.toBe(
      "Fix titles",
    );
  });

  it("sends the Claude Code OAuth identity the subscription upstream requires", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ content: [{ type: "text", text: "t" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await completeClaudeCodeInference(command, signal);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-test-token");
    expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(headers.get("anthropic-beta")).toContain("claude-code-20250219");
    const body = JSON.parse(String(init.body));
    expect(body.system[0].text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    expect(body.messages).toEqual([
      { role: "user", content: "Name this thread" },
    ]);
  });

  it("reports missing credentials as auth_required rather than throwing", async () => {
    state.file = "not json";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch must not run without credentials");
      }),
    );

    await expect(
      completeClaudeCodeInference(command, signal),
    ).rejects.toMatchObject({
      code: "auth_required",
      detailCode: "claude_code_auth_missing",
    });
  });

  it("reports an expired credential as auth_required so core does not retry it", async () => {
    state.file = credentialsJson(Date.now() - 1_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch must not run with expired credentials");
      }),
    );

    await expect(
      completeClaudeCodeInference(command, signal),
    ).rejects.toMatchObject({
      code: "auth_required",
      detailCode: "claude_code_auth_expired",
    });
  });

  it("maps upstream throttling to rate_limited so core falls back", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { message: "rate limit reached" } }, 429),
        ),
    );

    await expect(
      completeClaudeCodeInference(command, signal),
    ).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("maps an upstream outage to service_unavailable so core falls back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "overloaded" }, 529)),
    );

    await expect(
      completeClaudeCodeInference(command, signal),
    ).rejects.toMatchObject({
      code: "service_unavailable",
    });
  });

  it("maps a rejected request to request_failed and keeps the upstream reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { message: "model not found" } }, 400),
        ),
    );

    await expect(
      completeClaudeCodeInference(command, signal),
    ).rejects.toMatchObject({
      code: "request_failed",
      message: expect.stringContaining("model not found"),
    });
  });

  it("rejects a response that carries no text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          content: [{ type: "tool_use", name: "x", input: {} }],
        }),
      ),
    );

    await expect(
      completeClaudeCodeInference(command, signal),
    ).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
