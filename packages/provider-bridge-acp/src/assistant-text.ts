import { buildProviderCliEnv } from "@bb/provider-bridge-protocol/bridge-kit";
import {
  createAcpAgentConnection,
  requestAcpInitialize,
} from "./bridge/agent-connection.js";
import type { AcpLaunchSpec } from "./launch-spec.js";
import {
  acpSessionNewResultSchema,
  acpConfigStateResultSchema,
  acpPromptResultSchema,
  acpSessionNotificationParamsSchema,
  acpAgentMessageChunkUpdateSchema,
} from "./wire.js";
import {
  findAcpModelConfigOption,
  findAcpThoughtLevelConfigOption,
} from "./bridge/model-catalog.js";
import { z } from "zod";

export interface AcpTextRequest {
  launch: AcpLaunchSpec;
  model: string;
  reasoningLevel?: string;
  cwd: string;
  signal: AbortSignal;
}

export async function completeAcpText(
  request: AcpTextRequest & { text: string },
) {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
  let text = "";
  let toolAttempted = false;
  let sessionId: string | undefined;
  const connection = createAcpAgentConnection({
    command: request.launch.command,
    args: request.launch.args,
    cwd: request.cwd,
    env: buildProviderCliEnv(request.launch.env),
    recordThreadId: null,
    onNotification(method, raw) {
      if (method !== "session/update") return;
      const message = acpSessionNotificationParamsSchema.safeParse(raw);
      if (!message.success || message.data.sessionId !== sessionId) return;
      const chunk = acpAgentMessageChunkUpdateSchema.safeParse(
        message.data.update,
      );
      if (
        chunk.success &&
        chunk.data.content.type === "text" &&
        typeof chunk.data.content.text === "string"
      )
        text += chunk.data.content.text;
      const kind = z
        .object({ sessionUpdate: z.string() })
        .safeParse(message.data.update);
      if (
        kind.success &&
        ["tool_call", "tool_call_update"].includes(kind.data.sessionUpdate)
      ) {
        toolAttempted = true;
        connection.notify("session/cancel", { sessionId });
      }
      if (text.length > 12000) void connection.kill();
    },
    onRequest(method, _params, responder) {
      toolAttempted = true;
      if (method === "session/request_permission")
        responder.result({ outcome: { outcome: "cancelled" } });
      else
        responder.error(
          -32601,
          "This foreground conversation has no filesystem, terminal or tool access.",
        );
    },
    onExit: () => {},
  });
  const abort = () => {
    void connection.kill();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await requestAcpInitialize(connection, {
      parameterizedModelPicker: false,
      fsAccess: false,
    });
    const session = await connection.request({
      method: "session/new",
      params: { cwd: request.cwd, mcpServers: [] },
      resultSchema: acpSessionNewResultSchema,
      timeoutMs: 15000,
    });
    sessionId = session.sessionId;
    const modelOption = findAcpModelConfigOption(session.configOptions);
    let config = session.configOptions;
    if (modelOption) {
      const response = await connection.request({
        method: "session/set_config_option",
        params: { sessionId, configId: modelOption.id, value: request.model },
        resultSchema: acpConfigStateResultSchema,
        timeoutMs: 10000,
      });
      config = response.configOptions;
      if (findAcpModelConfigOption(config)?.currentValue !== request.model)
        throw new Error("ACP did not confirm the selected model.");
    } else {
      if (
        !session.models?.availableModels?.some(
          ({ modelId }) => modelId === request.model,
        )
      )
        throw new Error(
          "The selected model is not in this ACP session's native catalog.",
        );
      if (session.models.currentModelId !== request.model) {
        const response = await connection.request({
          method: "session/set_model",
          params: { sessionId, modelId: request.model },
          resultSchema: z.union([acpConfigStateResultSchema, z.null()]),
          timeoutMs: 10000,
        });
        if (
          response?.models &&
          response.models.currentModelId !== request.model
        )
          throw new Error("ACP rejected the selected model.");
        config = response?.configOptions ?? config;
      }
    }
    if (request.reasoningLevel !== undefined) {
      const option = findAcpThoughtLevelConfigOption(config);
      const declared = request.launch.nativeReasoning;
      const configId = option?.id ?? declared?.configId;
      const value =
        option?.options?.find(({ value }) => value === request.reasoningLevel)
          ?.value ??
        (declared?.supportedLevels.includes(request.reasoningLevel)
          ? request.reasoningLevel
          : undefined);
      if (!configId || value === undefined)
        throw new Error(
          "This ACP session does not expose the selected reasoning level.",
        );
      const response = await connection.request({
        method: "session/set_config_option",
        params: { sessionId, configId, value },
        resultSchema: acpConfigStateResultSchema,
        timeoutMs: 10000,
      });
      if (
        !response.configOptions?.some(
          (entry) => entry.id === configId && entry.currentValue === value,
        )
      )
        throw new Error("ACP did not confirm the selected reasoning level.");
    }
    const result = await connection.request({
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: request.text }] },
      resultSchema: acpPromptResultSchema,
      timeoutMs: 45000,
    });
    signal.throwIfAborted();
    if (
      toolAttempted ||
      result.stopReason !== "end_turn" ||
      !text.trim() ||
      text.length > 12000
    )
      throw new Error(
        "The ACP provider did not return a completed, tool-free text response.",
      );
    return {
      model: request.model,
      ...(request.reasoningLevel === undefined
        ? {}
        : { reasoningLevel: request.reasoningLevel }),
      text: text.trim(),
    };
  } finally {
    signal.removeEventListener("abort", abort);
    await connection.kill();
  }
}
