import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildAcpMcpServerConfig } from "./tool-proxy-mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE_MODULE = resolve(here, "bridge.ts");
const TSX_LOADER = import.meta.resolve("tsx");

const cleanups: Array<() => Promise<void> | void> = [];

interface FakeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const ASK_USER_QUESTION_TOOL: FakeTool = {
  name: "AskUserQuestion",
  description: "Ask the user a question.",
  inputSchema: { type: "object", properties: {} },
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function listenFakeBridge(args: {
  responseDelayMs: number | null;
  response?: unknown;
  tools?: FakeTool[];
  listResponse?: unknown;
}): Promise<{
  port: number;
  server: Server;
  requests: unknown[];
  listRequests: unknown[];
  cancelled: unknown[];
  setTools(tools: FakeTool[]): void;
  releaseResponses(): void;
}> {
  let tools = args.tools ?? [ASK_USER_QUESTION_TOOL];
  const requests: unknown[] = [];
  const listRequests: unknown[] = [];
  const cancelled: unknown[] = [];
  const sockets = new Set<Socket>();
  const heldResponses: Array<() => void> = [];
  const responseTimers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        kind?: unknown;
      };
      if (request.kind === "initialized") {
        socket.end(`${JSON.stringify({ ok: true, content: "" })}\n`);
        return;
      }
      if (request.kind === "listTools") {
        listRequests.push(request);
        socket.end(
          `${JSON.stringify(args.listResponse ?? { ok: true, tools })}\n`,
        );
        return;
      }
      requests.push(request);
      let responded = false;
      socket.once("close", () => {
        if (!responded) cancelled.push(request);
      });
      const response = args.response ?? {
        ok: true,
        content: '{"answers":{"Which?":"B"}}',
      };
      const respond = () => {
        responded = true;
        socket.end(`${JSON.stringify(response)}\n`);
      };
      if (args.responseDelayMs === null) {
        heldResponses.push(respond);
      } else {
        const timer = setTimeout(() => {
          responseTimers.delete(timer);
          respond();
        }, args.responseDelayMs);
        responseTimers.add(timer);
      }
    });
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  cleanups.push(
    () =>
      new Promise<void>((resolveClose) => {
        for (const timer of responseTimers) clearTimeout(timer);
        responseTimers.clear();
        heldResponses.length = 0;
        for (const socket of sockets) socket.destroy();
        server.close(() => resolveClose());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake bridge did not bind a port");
  }
  return {
    port: address.port,
    server,
    requests,
    listRequests,
    cancelled,
    setTools(next) {
      tools = next;
    },
    releaseResponses() {
      for (const respond of heldResponses.splice(0)) respond();
    },
  };
}

function buildConfig(port: number) {
  return buildAcpMcpServerConfig({
    bridgeArgs: [
      "--conditions=source",
      "--import",
      TSX_LOADER,
      BRIDGE_MODULE,
      "--mcp-stdio",
    ],
    command: process.execPath,
    host: "127.0.0.1",
    port,
    runtimeEnv: [],
    threadId: "thread-ask",
    token: "secret-token",
  });
}

async function connectLikeOpenCode(port: number): Promise<Client> {
  const config = buildConfig(port);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const { name, value } of config.env) env[name] = value;
  env.BB_ACP_DYNAMIC_TOOL_PROGRESS_INTERVAL_MS = "200";
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "opencode-like", version: "0" });
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[bb-bridge mcp] ${chunk.toString()}`);
  });
  cleanups.push(() => client.close());
  return client;
}

describe("bb-bridge MCP server keeps long tool calls alive", () => {
  it("sends progress notifications so an OpenCode-style client does not time out while the user answers", async () => {
    const fakeBridge = await listenFakeBridge({ responseDelayMs: 2_500 });
    const client = await connectLikeOpenCode(fakeBridge.port);

    let progressCount = 0;
    const result = await client.callTool(
      {
        name: "AskUserQuestion",
        arguments: { questions: [] },
      },
      CallToolResultSchema,
      {
        timeout: 1_000,
        resetTimeoutOnProgress: true,
        onprogress: () => {
          progressCount += 1;
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: '{"answers":{"Which?":"B"}}' },
    ]);
    expect(progressCount).toBeGreaterThan(0);
    expect(fakeBridge.requests).toHaveLength(1);
  }, 20_000);

  it("relays an image-only result as an MCP image block", async () => {
    const fakeBridge = await listenFakeBridge({
      responseDelayMs: 0,
      response: {
        ok: true,
        content: "",
        contentBlocks: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
        images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
    const client = await connectLikeOpenCode(fakeBridge.port);

    const result = await client.callTool(
      { name: "AskUserQuestion", arguments: {} },
      CallToolResultSchema,
      { timeout: 5_000 },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
  }, 20_000);
});

describe("bb-bridge MCP cancellation", () => {
  it.each(["timeout", "abort", "disconnect"] as const)(
    "closes the bridge call on %s without a late MCP reply",
    async (kind) => {
      const bridge = await listenFakeBridge({ responseDelayMs: null });
      const client = await connectLikeOpenCode(bridge.port);
      const errors: string[] = [];
      client.onerror = (error) => errors.push(error.message);
      const controller = new AbortController();
      const result = client
        .callTool(
          { name: "AskUserQuestion", arguments: {} },
          CallToolResultSchema,
          {
            timeout: kind === "timeout" ? 200 : 5_000,
            signal: controller.signal,
          },
        )
        .catch((error) => error);
      await expect.poll(() => bridge.requests.length).toBe(1);
      if (kind === "abort") controller.abort();
      if (kind === "disconnect") await client.close();
      expect(await result).toBeInstanceOf(Error);
      await expect
        .poll(() => bridge.cancelled.length, { timeout: 1_000 })
        .toBe(1);
      bridge.releaseResponses();
      if (kind !== "disconnect") {
        expect((await client.listTools()).tools).toContainEqual(
          expect.objectContaining({ name: "AskUserQuestion" }),
        );
      }
      expect(
        errors.filter((error) => error.includes("unknown message ID")),
      ).toEqual([]);
    },
    20_000,
  );

  it("ignores unknown and malformed cancellations and preserves a normal answer", async () => {
    const bridge = await listenFakeBridge({ responseDelayMs: 300 });
    const client = await connectLikeOpenCode(bridge.port);
    const result = client.callTool({ name: "AskUserQuestion", arguments: {} });
    await expect.poll(() => bridge.requests.length).toBe(1);
    await client.notification({
      method: "notifications/cancelled",
      params: { requestId: "unrelated" },
    });
    await client.notification({
      method: "notifications/cancelled",
      params: { requestId: { invalid: true } },
    });
    expect((await result).isError).toBeFalsy();
    expect(bridge.cancelled).toHaveLength(0);
  }, 20_000);
});

describe("large ACP tool catalogs", () => {
  it("advertises and calls tools through an editor with a 64 KiB server-config limit", async () => {
    const tools = Array.from({ length: 160 }, (_, i) => ({
      name: `tool_${i}`,
      description: "A tool with a detailed contract. ".repeat(40),
      inputSchema: { type: "object", properties: {} },
    }));
    const fakeBridge = await listenFakeBridge({ responseDelayMs: 0, tools });
    const config = buildConfig(fakeBridge.port);
    const serialized = JSON.stringify([config]);
    expect(Buffer.byteLength(serialized)).toBeLessThan(4_096);
    expect(serialized).not.toContain("tool_0");
    const client = await connectLikeOpenCode(fakeBridge.port);
    const listed = await client.listTools();
    expect(listed.tools).toEqual(tools);
    const result = await client.callTool({ name: "tool_159", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(fakeBridge.requests).toEqual([
      expect.objectContaining({ kind: "toolCall", tool: "tool_159" }),
    ]);
  }, 20_000);
});

describe("bb-bridge MCP tool catalog comes from the bridge", () => {
  it("authenticates the list request as the session's thread", async () => {
    const fakeBridge = await listenFakeBridge({ responseDelayMs: 0 });
    const client = await connectLikeOpenCode(fakeBridge.port);
    await client.listTools();
    expect(fakeBridge.listRequests).toEqual([
      { kind: "listTools", threadId: "thread-ask", token: "secret-token" },
    ]);
  }, 20_000);

  it("re-lists the bridge's current catalog so an editor's drift check sees tool changes", async () => {
    const fakeBridge = await listenFakeBridge({ responseDelayMs: 0 });
    const client = await connectLikeOpenCode(fakeBridge.port);
    expect((await client.listTools()).tools).toEqual([ASK_USER_QUESTION_TOOL]);
    const added: FakeTool = {
      name: "gitea_git",
      description: "Run git against Gitea.",
      inputSchema: { type: "object", properties: {} },
    };
    fakeBridge.setTools([ASK_USER_QUESTION_TOOL, added]);
    expect((await client.listTools()).tools).toEqual([
      ASK_USER_QUESTION_TOOL,
      added,
    ]);
    const result = await client.callTool({ name: "gitea_git", arguments: {} });
    expect(result.isError).toBeFalsy();
  }, 20_000);

  it("calls a tool the client never listed by asking the bridge for it", async () => {
    const fakeBridge = await listenFakeBridge({ responseDelayMs: 0 });
    const client = await connectLikeOpenCode(fakeBridge.port);
    const result = await client.callTool({
      name: "AskUserQuestion",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    expect(fakeBridge.listRequests).toHaveLength(1);
  }, 20_000);

  it("rejects an unknown tool without forwarding it", async () => {
    const fakeBridge = await listenFakeBridge({ responseDelayMs: 0 });
    const client = await connectLikeOpenCode(fakeBridge.port);
    await client.listTools();
    await expect(
      client.callTool({ name: "no_such_tool", arguments: {} }),
    ).rejects.toThrow(/Unknown tool: no_such_tool/u);
    expect(fakeBridge.requests).toHaveLength(0);
  }, 20_000);

  it("reports a bridge that cannot list tools as an MCP error", async () => {
    const fakeBridge = await listenFakeBridge({
      responseDelayMs: 0,
      listResponse: { ok: false, error: "No active ACP session" },
    });
    const client = await connectLikeOpenCode(fakeBridge.port);
    await expect(client.listTools()).rejects.toThrow(
      /could not list tools: No active ACP session/u,
    );
  }, 20_000);
});
