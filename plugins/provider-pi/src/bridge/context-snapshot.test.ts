import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contextSnapshotSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { BB_PI_EXTENSION_SOURCE } from "./bb-pi-extension.js";
import { PiRpcSession } from "./rpc-session.js";

function extractFunction(name: string): string {
  const definition = BB_PI_EXTENSION_SOURCE.match(
    new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`),
  )?.[0];
  if (!definition) throw new Error(`${name} is missing from the extension`);
  return definition;
}

const extensionFunctions = `${extractFunction("buildContextSnapshot")}\n${extractFunction("captureContextSnapshot")}`;

function buildContextSnapshot(input: Record<string, unknown>): unknown {
  return runInNewContext(`${extensionFunctions}; buildContextSnapshot(input)`, {
    input,
  });
}

function captureContextSnapshot(pi: unknown, ctx: unknown): unknown {
  return runInNewContext(
    `${extensionFunctions}; captureContextSnapshot(pi, ctx)`,
    { pi, ctx, process: { env: { HOME: "/home/me" } } },
  );
}

const PROMPT = [
  "You are an expert coding assistant operating inside pi.",
  "<tools>\n- read: Read file contents\n</tools>",
  "<rules>\n- Be concise\n</rules>",
  "<addendum>\nHost instructions.\n<inner>\nnot a section\n</inner>\n</addendum>",
  '<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/home/me/repo/AGENTS.md">\n' +
    "Use pnpm.\n".repeat(40) +
    '\n</project_instructions>\n\n<project_instructions path="/home/me/repo/sub/AGENTS.md">\nSmall.\n</project_instructions>\n</project_context>',
  "<skills>\n<available_skills>\n  <skill>\n    <name>small</name>\n    <description>b</description>\n  </skill>\n  <skill>\n    <name>korean</name>\n    <description>" +
    "한국어설명".repeat(40) +
    "</description>\n  </skill>\n</available_skills>\n</skills>",
  "<cwd>\n/home/me/repo\n</cwd>",
].join("\n\n");

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    systemPrompt: PROMPT,
    tools: [
      { name: "read", description: "Read a file", parameters: { type: "object" }, group: "builtin" },
      { name: "bb_tool", description: "x".repeat(800), parameters: {}, group: "extension" },
    ],
    messages: [
      { role: "system", content: "ignored" },
      { role: "user", content: "please read the file" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t".repeat(200) },
          { type: "text", text: "Sure." },
          { type: "toolCall", id: "1", name: "read", arguments: { path: "/a" } },
        ],
      },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "r".repeat(4000) }] },
      { role: "bashExecution", command: "ls", output: "a", excludeFromContext: true },
    ],
    knownUsedTokens: null,
    contextWindow: 200_000,
    autoCompact: { enabled: true, reserveTokens: 16_384 },
    model: "test/model",
    sessionId: "session-1",
    turnId: "leaf-1",
    capturedAt: "2026-10-25T00:00:00.000Z",
    home: "/home/me",
    ...overrides,
  };
}

function category(snapshot: { categories: Array<{ label: string }> }, label: string) {
  const found = snapshot.categories.find((entry) => entry.label === label);
  if (!found) throw new Error(`missing category ${label}`);
  return found as { label: string; tokens: number; entries: Array<{ label: string; tokens: number }> };
}

describe("pi context snapshot", () => {
  it("splits the prompt, tools, and messages into bb's snapshot shape", () => {
    const snapshot = contextSnapshotSchema.parse(buildContextSnapshot(baseInput()));

    expect(snapshot.categories.map((entry) => entry.label)).toEqual([
      "System prompt",
      "Appended system prompt",
      "Project context files",
      "Skills",
      "Built-in tools",
      "Extension tools",
      "Messages",
      "Free space",
      "Autocompact buffer",
    ]);
    expect(category(snapshot, "Project context files").entries.map((entry) => entry.label)).toEqual([
      "~/repo/AGENTS.md",
      "~/repo/sub/AGENTS.md",
    ]);
    const skills = category(snapshot, "Skills").entries;
    expect(skills[0]?.label).toBe("korean");
    expect(skills[0]?.tokens).toBeGreaterThanOrEqual(200);
    expect(category(snapshot, "Messages").entries.map((entry) => entry.label)).toEqual([
      "Tool results",
      "Tool calls",
      "Assistant messages",
      "Thinking",
      "User messages",
    ]);
    expect(snapshot.autoCompactAtTokens).toBe(200_000 - 16_384);
  });

  it("scales categories to pi's known total without letting entries exceed them", () => {
    const snapshot = contextSnapshotSchema.parse(
      buildContextBreakdownWithTotal(12_345),
    );
    const used = snapshot.categories.filter((entry) => entry.kind === "used");
    expect(used.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(12_345);
    for (const entry of snapshot.categories) {
      expect(entry.entries.reduce((sum, child) => sum + child.tokens, 0)).toBeLessThanOrEqual(entry.tokens);
    }
    expect(category(snapshot, "Free space").tokens).toBe(200_000 - 12_345 - 16_384);
  });

  it("omits the autocompact buffer when compaction is disabled", () => {
    const snapshot = contextSnapshotSchema.parse(
      buildContextSnapshot(baseInput({ autoCompact: { enabled: false, reserveTokens: 16_384 } })),
    );
    expect(snapshot.autoCompactAtTokens).toBeNull();
    expect(snapshot.categories.some((entry) => entry.kind === "reserved")).toBe(false);
  });

  describe("capture from a live pi session", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("reads active tools, settings, and the session context of the installed runtime", () => {
      const dir = mkdtempSync(join(tmpdir(), "bb-pi-context-snapshot-"));
      dirs.push(dir);
      const sessionManager = SessionManager.inMemory(dir);
      sessionManager.appendMessage({ role: "user", content: "hello there", timestamp: 1 });
      const pi = {
        getActiveTools: () => ["read", "mcp__docs__search"],
        getAllTools: () => [
          { name: "read", description: "Read", parameters: {}, sourceInfo: { path: "builtin:read", source: "builtin" } },
          { name: "mcp__docs__search", description: "Search", parameters: {}, sourceInfo: { path: "/x", source: "local" } },
          { name: "inactive", description: "x".repeat(400), parameters: {}, sourceInfo: { path: "/y", source: "local" } },
        ],
        getSettings: () => ({ compaction: { reserveTokens: 1000, modelOverrides: { "p/m": { reserveTokens: 2000 } } } }),
      };
      const ctx = {
        getContextUsage: () => ({ tokens: 500, contextWindow: 10_000, percent: 5 }),
        getSystemPrompt: () => PROMPT,
        model: { provider: "p", id: "m", contextWindow: 10_000 },
        sessionManager,
      };

      const snapshot = contextSnapshotSchema.parse(captureContextSnapshot(pi, ctx));

      expect(snapshot.model).toBe("p/m");
      expect(snapshot.usedTokens).toBe(500);
      expect(snapshot.autoCompactAtTokens).toBe(8000);
      expect(snapshot.providerSessionId).toBe(sessionManager.getSessionId());
      expect(category(snapshot, "Built-in tools").entries.map((entry) => entry.label)).toEqual(["read"]);
      expect(category(snapshot, "MCP tools").entries.map((entry) => entry.label)).toEqual(["mcp__docs__search"]);
      expect(snapshot.categories.some((entry) => entry.label === "Extension tools")).toBe(false);
      expect(category(snapshot, "Messages").entries.map((entry) => entry.label)).toEqual(["User messages"]);
    });

    it("returns null when the model has no context window", () => {
      const ctx = {
        getContextUsage: () => undefined,
        getSystemPrompt: () => "",
        model: undefined,
        sessionManager: SessionManager.inMemory(),
      };
      expect(captureContextSnapshot({}, ctx)).toBeNull();
    });
  });
});

function buildContextBreakdownWithTotal(total: number): unknown {
  return buildContextSnapshot(baseInput({ knownUsedTokens: total }));
}

describe("rpc session context usage", () => {
  function sessionWithExtensionReply(reply: (message: Record<string, unknown>) => void) {
    const session = new PiRpcSession(
      {
        cwd: ".",
        sessionFilePath: "unused",
        sessionDir: ".",
        scratchDir: ".",
        extensionPath: "unused",
        recordThreadId: "context-snapshot-test",
      },
      async () => ({ content: "" }),
      () => undefined,
      () => undefined,
    );
    const control = session as unknown as {
      child: unknown;
      handleChannelMessage(message: Record<string, unknown>): void;
      refreshContextUsage(): Promise<void>;
    };
    control.child = {
      exited: false,
      requestOk: async () => ({ contextUsage: { tokens: 1000, contextWindow: 272_000 } }),
      sendChannel: (message: Record<string, unknown>) => {
        queueMicrotask(() => reply(message));
      },
    };
    return { session, control };
  }

  const validSnapshot = contextSnapshotSchema.parse(
    buildContextSnapshot(baseInput({ knownUsedTokens: 1000, contextWindow: 272_000 })),
  );

  it("attaches the snapshot the bb extension reports", async () => {
    const { session, control } = sessionWithExtensionReply((message) =>
      control.handleChannelMessage({ kind: "reply", id: message.id, result: { snapshot: validSnapshot } }),
    );
    await control.refreshContextUsage();
    expect(session.getContextUsage()).toEqual({
      tokens: 1000,
      contextWindow: 272_000,
      snapshot: validSnapshot,
    });
  });

  it("keeps the totals when the extension cannot produce a valid snapshot", async () => {
    const { session, control } = sessionWithExtensionReply((message) =>
      control.handleChannelMessage({ kind: "reply", id: message.id, result: { snapshot: { usedTokens: -1 } } }),
    );
    await control.refreshContextUsage();
    expect(session.getContextUsage()).toEqual({ tokens: 1000, contextWindow: 272_000, snapshot: null });
  });

  it("keeps the totals when an older extension rejects the request", async () => {
    const { session, control } = sessionWithExtensionReply((message) =>
      control.handleChannelMessage({ kind: "reply", id: message.id, error: "unknown bridge request context-snapshot" }),
    );
    await control.refreshContextUsage();
    expect(session.getContextUsage()).toEqual({ tokens: 1000, contextWindow: 272_000, snapshot: null });
  });
});
