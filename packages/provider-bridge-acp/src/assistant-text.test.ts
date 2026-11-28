import { beforeEach, expect, it, vi } from "vitest";
import { completeAcpText } from "./assistant-text.js";

const state = vi.hoisted(() => ({
  tool: false,
  wrongModel: false,
  requests: [] as { method: string; params: unknown }[],
  killed: 0,
  denied: false,
  launch: null as unknown,
}));
vi.mock("./bridge/agent-connection.js", () => ({
  requestAcpInitialize: vi.fn(async (_connection, capabilities) => {
    expect(capabilities.fsAccess).toBe(false);
  }),
  createAcpAgentConnection(options: {
    onNotification(method: string, params: unknown): void;
    onRequest(
      method: string,
      params: unknown,
      responder: { result(value: unknown): void },
    ): void;
  }) {
    state.launch = options;
    return {
      async request(request: { method: string; params: { value?: string } }) {
        state.requests.push(request);
        const option = {
          id: "model",
          category: "model",
          name: "Model",
          type: "select",
          currentValue: state.wrongModel ? "other" : "native",
          options: [{ value: "native", name: "Native" }],
        };
        if (request.method === "session/new")
          return { sessionId: "s", configOptions: [option] };
        if (request.method === "session/set_config_option")
          return { configOptions: [option] };
        if (request.method === "session/prompt") {
          if (state.tool)
            options.onRequest(
              "session/request_permission",
              {},
              {
                result(value) {
                  state.denied = JSON.stringify(value).includes("cancelled");
                },
              },
            );
          options.onNotification("session/update", {
            sessionId: "s",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "native reply" },
            },
          });
          return { stopReason: "end_turn" };
        }
        throw new Error("unexpected method");
      },
      notify() {},
      async kill() {
        state.killed++;
      },
    };
  },
}));
beforeEach(() => {
  state.tool = false;
  state.wrongModel = false;
  state.requests = [];
  state.killed = 0;
  state.denied = false;
});
const input = {
  launch: {
    displayName: "Native",
    command: "registered-agent",
    args: ["acp"],
    env: {},
  },
  model: "native",
  cwd: "/isolated",
  text: "synthetic",
  signal: new AbortController().signal,
};
it("selects and confirms a native model before sending only the foreground prompt", async () => {
  await expect(completeAcpText(input)).resolves.toEqual({
    model: "native",
    text: "native reply",
  });
  expect(state.requests.map(({ method }) => method)).toEqual([
    "session/new",
    "session/set_config_option",
    "session/prompt",
  ]);
  expect(state.requests[0].params).toEqual({
    cwd: "/isolated",
    mcpServers: [],
  });
  expect(state.killed).toBe(1);
});
it("denies native tool approval and rejects a tool-bearing answer", async () => {
  state.tool = true;
  await expect(completeAcpText(input)).rejects.toThrow(/tool-free/);
  expect(state.denied).toBe(true);
  expect(state.killed).toBe(1);
});
it("does not prompt on a model mismatch or an unsupported reasoning selection", async () => {
  state.wrongModel = true;
  await expect(completeAcpText(input)).rejects.toThrow(/selected model/);
  expect(state.requests.some(({ method }) => method === "session/prompt")).toBe(
    false,
  );
  state.wrongModel = false;
  await expect(
    completeAcpText({ ...input, reasoningLevel: "high" }),
  ).rejects.toThrow(/reasoning/);
});
