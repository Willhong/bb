import { PI_SERVICE_TIER_EXTENSION_SOURCE } from "../service-tier.js";

export const BB_PI_EXTENSION_SOURCE = String.raw`
import { readFileSync, renameSync } from "node:fs";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import * as PiRuntime from "@earendil-works/pi-coding-agent";
const { SessionManager } = PiRuntime;

function supportsAgentSettlement(version) {
  const match = typeof version === "string" && /^(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/.exec(version);
  return !!match && (Number(match[1]) >= 1 || Number(match[2]) >= 84);
}
import { Type } from "typebox";

const BRIDGE_CHANNEL_ENV = "BB_PI_BRIDGE_CHANNEL";
const BRIDGE_CHANNEL_TOKEN_ENV = "BB_PI_BRIDGE_CHANNEL_TOKEN";
const BRIDGE_CHANNEL = Symbol.for("bb.pi.bridgeChannel");

function openBridgeChannel() {
  const address = process.env[BRIDGE_CHANNEL_ENV];
  const token = process.env[BRIDGE_CHANNEL_TOKEN_ENV];
  delete process.env[BRIDGE_CHANNEL_ENV];
  delete process.env[BRIDGE_CHANNEL_TOKEN_ENV];
  if (!address || !token) {
    return Promise.reject(new Error("bb did not provide its Pi bridge channel"));
  }
  return new Promise((resolve, reject) => {
    const socket = connect(address);
    const channel = { socket, onLine: () => undefined };
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => undefined);
      socket.unref();
      socket.write(token + "\n");
      readLines(socket, (line) => channel.onLine(line));
      resolve(channel);
    });
  });
}

function bridgeChannel() {
  globalThis[BRIDGE_CHANNEL] ??= openBridgeChannel();
  return globalThis[BRIDGE_CHANNEL];
}

/** Newline-only line reader (never readline: it splits on U+2028/U+2029). */
function readLines(input, onLine) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  input.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    for (;;) {
      const index = text.indexOf("\n", start);
      if (index === -1) {
        pending += text.slice(start);
        return;
      }
      const line = pending + text.slice(start, index);
      pending = "";
      start = index + 1;
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  });
}

// ---- JSON Schema → TypeBox (the bb tool definitions carry JSON Schema) ----

function toJsonSchemaObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * Annotations and constraints TypeBox carries through to the schema the
 * model sees: descriptions, defaults, and the numeric/string keywords.
 */
const CARRIED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
];
function annotations(schema) {
  const out = {};
  if (typeof schema.description === "string") out.description = schema.description;
  if (typeof schema.title === "string") out.title = schema.title;
  if (schema.default !== undefined) out.default = schema.default;
  if (Array.isArray(schema.examples)) out.examples = schema.examples;
  for (const keyword of CARRIED_KEYWORDS) {
    if (schema[keyword] !== undefined) out[keyword] = schema[keyword];
  }
  return out;
}

function toLiteral(value) {
  return ["string", "number", "boolean"].includes(typeof value) ? Type.Literal(value) : null;
}

function toEnumSchema(schema) {
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) return null;
  const literals = schema.enum.map(toLiteral).filter(Boolean);
  if (literals.length === 0) return null;
  return literals.length === 1
    ? Type.Unsafe({ ...literals[0], ...annotations(schema) })
    : Type.Union(literals, annotations(schema));
}

function toObjectSchema(schema) {
  const properties = toJsonSchemaObject(schema.properties) ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape = {};
  for (const [key, value] of Object.entries(properties)) {
    const property = toJsonSchemaObject(value);
    if (!property) continue;
    const propertySchema = toTypeBoxSchema(property);
    shape[key] = required.has(key) ? propertySchema : Type.Optional(propertySchema);
  }
  const options = annotations(schema);
  if (schema.additionalProperties === false) options.additionalProperties = false;
  return Type.Object(shape, options);
}

function toTypedSchema(type, schema) {
  const options = annotations(schema);
  switch (type) {
    case "object":
      return toObjectSchema(schema);
    case "array": {
      const items = toJsonSchemaObject(schema.items);
      return Type.Array(items ? toTypeBoxSchema(items) : Type.Unknown(), options);
    }
    case "string":
      return Type.String(options);
    case "number":
      return Type.Number(options);
    case "integer":
      return Type.Integer(options);
    case "boolean":
      return Type.Boolean(options);
    case "null":
      return Type.Null(options);
    default:
      // JSON Schema is provider-owned here; unsupported shapes degrade.
      return Type.Unknown(options);
  }
}

function toTypeBoxSchema(schema) {
  const enumSchema = toEnumSchema(schema);
  if (enumSchema) return enumSchema;
  if (schema.const !== undefined) {
    const literal = toLiteral(schema.const);
    if (literal) return Type.Unsafe({ ...literal, ...annotations(schema) });
  }
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) {
      const variants = schema[key].map(toJsonSchemaObject).filter(Boolean).map(toTypeBoxSchema);
      if (variants.length > 0) return Type.Union(variants, annotations(schema));
    }
  }
  if (Array.isArray(schema.type)) {
    const variants = schema.type.map((type) => toTypedSchema(type, { ...schema, description: undefined }));
    return variants.length === 1 ? toTypedSchema(schema.type[0], schema) : Type.Union(variants, annotations(schema));
  }
  if (schema.type === undefined) {
    return schema.properties ? toObjectSchema(schema) : Type.Unknown(annotations(schema));
  }
  return toTypedSchema(schema.type, schema);
}

function buildParameters(inputSchema) {
  const schema = toJsonSchemaObject(inputSchema);
  return schema ? toTypeBoxSchema(schema) : Type.Object({});
}

// ---- context window breakdown ----

function buildContextSnapshot(input) {
  const IMAGE_TOKENS = 1200;
  const SECTION_LABELS = {
    preamble: "Base instructions",
    tools: "Tool list",
    rules: "Rules",
    docs: "Pi docs pointer",
    cwd: "Working directory",
    other: "Other",
  };
  const TOOL_GROUPS = [
    ["builtin", "Built-in tools"],
    ["extension", "Extension tools"],
    ["mcp", "MCP tools"],
  ];
  const MESSAGE_BUCKETS = [
    ["toolResults", "Tool results"],
    ["toolCalls", "Tool calls"],
    ["assistant", "Assistant messages"],
    ["thinking", "Thinking"],
    ["user", "User messages"],
    ["images", "Images"],
    ["shell", "Shell commands"],
    ["extension", "Extension messages"],
    ["compaction", "Compaction summary"],
    ["branch", "Branch summary"],
  ];

  function isCjk(code) {
    return (
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf)
    );
  }
  function weight(text) {
    let ascii = 0;
    let cjk = 0;
    let other = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 0x80) ascii++;
      else if (isCjk(code)) cjk++;
      else if (code >= 0xd800 && code <= 0xdbff) {
        other++;
        index++;
      } else other++;
    }
    return ascii / 4 + cjk + other / 2;
  }
  function tokens(text) {
    return Math.ceil(weight(text));
  }
  function json(value) {
    try {
      return JSON.stringify(value === undefined ? {} : value) || "";
    } catch {
      return "";
    }
  }
  function shorten(path) {
    return input.home && path.startsWith(input.home) ? "~" + path.slice(input.home.length) : path;
  }

  function splitPrompt(prompt) {
    const open = /<([a-z][a-z0-9_-]*)>\n/g;
    const sections = [];
    let cursor = 0;
    let other = "";
    for (;;) {
      open.lastIndex = cursor;
      const match = open.exec(prompt);
      if (!match) break;
      if (match.index > 0 && prompt[match.index - 1] !== "\n") {
        cursor = match.index + 1;
        continue;
      }
      const closeTag = "\n</" + match[1] + ">";
      let close = prompt.indexOf(closeTag, match.index + match[0].length - 1);
      while (close !== -1) {
        const after = close + closeTag.length;
        if (after === prompt.length || prompt[after] === "\n") break;
        close = prompt.indexOf(closeTag, close + 1);
      }
      if (close === -1) {
        cursor = match.index + 1;
        continue;
      }
      const gap = prompt.slice(cursor, match.index);
      if (cursor === 0 && sections.length === 0) {
        if (gap.trim()) sections.push({ name: "preamble", text: gap, body: gap });
      } else {
        other += gap;
      }
      const end = close + closeTag.length;
      sections.push({
        name: match[1],
        text: prompt.slice(match.index, end),
        body: prompt.slice(match.index + match[0].length, close),
      });
      cursor = end;
    }
    if (sections.length === 0) {
      return prompt.trim() ? [{ name: "preamble", text: prompt, body: prompt }] : [];
    }
    other += prompt.slice(cursor);
    if (other.trim()) sections.push({ name: "other", text: other, body: other });
    return sections;
  }

  function promptCategories(prompt) {
    const system = { key: "system", label: "System prompt", tokens: 0, entries: [] };
    const out = [system];
    for (const section of splitPrompt(prompt)) {
      const count = tokens(section.text);
      if (section.name === "project_context") {
        const files = [...section.body.matchAll(/<project_instructions path="([^"]*)">\n[\s\S]*?\n<\/project_instructions>/g)]
          .map((match) => ({ label: shorten(match[1]), tokens: tokens(match[0]) }))
          .sort((a, b) => b.tokens - a.tokens);
        out.push({ key: "project_context", label: "Project context files", tokens: count, entries: files });
      } else if (section.name === "skills") {
        const skills = [...section.body.matchAll(/<skill>[\s\S]*?<\/skill>/g)]
          .map((match) => {
            const name = /<name>([\s\S]*?)<\/name>/.exec(match[0]);
            return { label: (name && name[1].trim()) || "skill", tokens: tokens(match[0]) };
          })
          .sort((a, b) => b.tokens - a.tokens);
        out.push({ key: "skills", label: "Skills", tokens: count, entries: skills });
      } else if (section.name === "addendum") {
        out.push({ key: "addendum", label: "Appended system prompt", tokens: count, entries: [] });
      } else {
        system.tokens += count;
        system.entries.push({ label: SECTION_LABELS[section.name] || "<" + section.name + ">", tokens: count });
      }
    }
    return out;
  }

  function toolCategories(tools) {
    return TOOL_GROUPS.map(([group, label]) => {
      const entries = tools
        .filter((tool) => tool.group === group)
        .map((tool) => ({
          label: tool.name,
          tokens: tokens(json({ name: tool.name, description: tool.description || "", input_schema: tool.parameters || {} })),
        }))
        .sort((a, b) => b.tokens - a.tokens);
      return { key: "tools:" + group, label, tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0), entries };
    });
  }

  function contentWeight(content, add) {
    if (typeof content === "string") return weight(content);
    if (!Array.isArray(content)) return 0;
    let total = 0;
    for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string") total += weight(block.text);
      else if (block && block.type === "image") add("images", IMAGE_TOKENS);
    }
    return total;
  }

  function messageCategory(messages) {
    const buckets = new Map();
    const add = (bucket, value) => {
      if (value > 0) buckets.set(bucket, (buckets.get(bucket) || 0) + value);
    };
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      switch (message.role) {
        case "system":
          break;
        case "user":
          add("user", contentWeight(message.content, add));
          break;
        case "assistant":
          for (const block of Array.isArray(message.content) ? message.content : []) {
            if (!block) continue;
            if (block.type === "text" && typeof block.text === "string") add("assistant", weight(block.text));
            else if (block.type === "thinking" && typeof block.thinking === "string") add("thinking", weight(block.thinking));
            else if (block.type === "toolCall") add("toolCalls", weight(String(block.name || "")) + weight(json(block.arguments)));
          }
          break;
        case "toolResult":
          add("toolResults", contentWeight(message.content, add));
          break;
        case "bashExecution":
          if (message.excludeFromContext !== true) {
            add("shell", weight(String(message.command || "")) + weight(String(message.output || "")));
          }
          break;
        case "compactionSummary":
          add("compaction", weight(String(message.summary || "")));
          break;
        case "branchSummary":
          add("branch", weight(String(message.summary || "")));
          break;
        default:
          add("extension", contentWeight(message.content, add));
      }
    }
    const entries = MESSAGE_BUCKETS.map(([bucket, label]) => ({ label, tokens: Math.ceil(buckets.get(bucket) || 0) }));
    return { key: "messages", label: "Messages", tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0), entries };
  }

  function apportion(values, target) {
    const total = values.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return values.map(() => 0);
    const exact = values.map((value) => (value / total) * target);
    const result = exact.map(Math.floor);
    let remaining = target - result.reduce((sum, value) => sum + value, 0);
    const order = exact
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((a, b) => b.fraction - a.fraction);
    for (const { index } of order) {
      if (remaining <= 0) break;
      result[index] += 1;
      remaining -= 1;
    }
    return result;
  }

  const raw = [
    ...promptCategories(input.systemPrompt || ""),
    ...toolCategories(input.tools || []),
    messageCategory(input.messages || []),
  ].filter((category) => category.tokens > 0);
  const rawTotal = raw.reduce((sum, category) => sum + category.tokens, 0);
  const known =
    typeof input.knownUsedTokens === "number" && Number.isFinite(input.knownUsedTokens) && input.knownUsedTokens > 0
      ? Math.round(input.knownUsedTokens)
      : null;
  const usedTokens = known === null ? rawTotal : known;
  const scale = known !== null && rawTotal > 0 ? known / rawTotal : 1;
  const categoryTokens = apportion(raw.map((category) => category.tokens), usedTokens);
  const categories = raw.map((category, index) => {
    const total = categoryTokens[index];
    const entrySum = category.entries.reduce((sum, entry) => sum + entry.tokens, 0);
    const entryTokens = apportion(
      category.entries.map((entry) => entry.tokens),
      Math.min(total, Math.floor(entrySum * scale)),
    );
    const seen = new Map();
    return {
      id: JSON.stringify(["pi", category.key]),
      label: category.label,
      kind: "used",
      tokens: total,
      entries: category.entries
        .map((entry, entryIndex) => ({ label: entry.label, tokens: entryTokens[entryIndex] }))
        .filter((entry) => entry.tokens > 0)
        .map((entry) => {
          const occurrence = seen.get(entry.label) || 0;
          seen.set(entry.label, occurrence + 1);
          return { id: JSON.stringify(["pi", category.key, entry.label, occurrence]), label: entry.label, tokens: entry.tokens };
        }),
    };
  });
  const contextWindow = Math.max(1, Math.round(input.contextWindow));
  const reserved = input.autoCompact && input.autoCompact.enabled
    ? Math.max(0, Math.min(Math.round(input.autoCompact.reserveTokens), contextWindow))
    : 0;
  categories.push({
    id: JSON.stringify(["pi", "free"]),
    label: "Free space",
    kind: "free",
    tokens: Math.max(0, contextWindow - usedTokens - reserved),
    entries: [],
  });
  if (reserved > 0) {
    categories.push({ id: JSON.stringify(["pi", "autocompact"]), label: "Autocompact buffer", kind: "reserved", tokens: reserved, entries: [] });
  }
  return {
    capturedAt: input.capturedAt,
    providerSessionId: input.sessionId,
    providerTurnId: input.turnId,
    model: input.model,
    usedTokens,
    contextWindowTokens: contextWindow,
    autoCompactAtTokens: reserved > 0 ? contextWindow - reserved : null,
    estimated: true,
    categories,
  };
}

function captureContextSnapshot(pi, ctx) {
  const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  const contextWindow = (usage && usage.contextWindow) || (ctx.model && ctx.model.contextWindow) || 0;
  if (!(contextWindow > 0)) return null;
  const active = new Set(typeof pi.getActiveTools === "function" ? pi.getActiveTools() : []);
  const tools = (typeof pi.getAllTools === "function" ? pi.getAllTools() : [])
    .filter((tool) => active.has(tool.name) && tool.exposure !== "hidden")
    .map((tool) => {
      const path = (tool.sourceInfo && tool.sourceInfo.path) || "";
      const group =
        tool.namespace || path.startsWith("builtin:mcp") || tool.name.startsWith("mcp__")
          ? "mcp"
          : (tool.sourceInfo && tool.sourceInfo.source === "builtin") || path.startsWith("builtin:")
            ? "builtin"
            : "extension";
      return { name: tool.name, description: tool.description, parameters: tool.parameters, group };
    });
  const sessionManager = ctx.sessionManager;
  const projection =
    typeof sessionManager.buildSessionProjection === "function"
      ? sessionManager.buildSessionProjection()
      : typeof sessionManager.buildSessionContext === "function"
        ? sessionManager.buildSessionContext()
        : null;
  let compaction = {};
  try {
    const settings = typeof pi.getSettings === "function" ? pi.getSettings() : null;
    compaction = (settings && settings.compaction) || {};
  } catch {
    compaction = {};
  }
  const modelKey = ctx.model ? ctx.model.provider + "/" + ctx.model.id : null;
  const override = modelKey && compaction.modelOverrides && compaction.modelOverrides[modelKey];
  return buildContextSnapshot({
    systemPrompt: typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "",
    tools,
    messages: (projection && projection.messages) || [],
    knownUsedTokens: usage ? usage.tokens : null,
    contextWindow,
    autoCompact: {
      enabled: compaction.enabled !== false,
      reserveTokens: (override && override.reserveTokens) || compaction.reserveTokens || 16384,
    },
    model: modelKey || "unknown",
    sessionId: sessionManager.getSessionId() || "unknown",
    turnId: sessionManager.getLeafId() || null,
    capturedAt: new Date().toISOString(),
    home: process.env.HOME || process.env.USERPROFILE || "",
  });
}

// ---- the extension ----

${PI_SERVICE_TIER_EXTENSION_SOURCE}

export default async function bbExtension(pi) {
  registerBbServiceTier(pi);
  const channel = await bridgeChannel();
  const writeLine = (message) => {
    if (channel.socket.writable) channel.socket.write(JSON.stringify(message) + "\n");
  };
  const toolsFile = process.env.PI_BB_TOOLS_FILE;
  const tools = toolsFile ? JSON.parse(readFileSync(toolsFile, "utf8")) : [];
  const pendingToolCalls = new Map();
  let nextId = 0;
  let sessionContext = null;
  let runId = 0;
  let lastSettlement = null;

  const onBridgeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message.kind === "tool-result") {
      const pending = pendingToolCalls.get(message.id);
      if (!pending) return;
      pendingToolCalls.delete(message.id);
      if (message.isError) {
        pending.reject(new Error(toolErrorText(message.content) || "Tool call failed"));
      } else {
        pending.resolve({ content: message.content, details: {} });
      }
      return;
    }
    if (message.kind === "request") {
      void handleBridgeRequest(message);
    }
  };
  channel.onLine = onBridgeLine;

  async function handleBridgeRequest(message) {
    try {
      const result = await runBridgeRequest(message);
      writeLine({ kind: "reply", id: message.id, result });
    } catch (error) {
      writeLine({
        kind: "reply",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function runBridgeRequest(message) {
    switch (message.method) {
      case "fork": {
        // Documented SessionManager API (docs/sdk.md, docs/session-format.md):
        // a full fork copies the source history, a checkpoint fork branches
        // at an entry. Both pick their own file name; the bridge names the
        // target, so the file is moved onto it. Both read the source file
        // and write only the new one.
        const forkedFile =
          message.checkpointId === undefined
            ? SessionManager.forkFrom(
                message.sourceFile,
                message.cwd,
                message.sessionDir,
              ).getSessionFile()
            : SessionManager.open(
                message.sourceFile,
                message.sessionDir,
                message.cwd,
              ).createBranchedSession(message.checkpointId);
        if (!forkedFile) {
          throw new Error("forked pi session was not persisted");
        }
        if (forkedFile !== message.targetFile) {
          renameSync(forkedFile, message.targetFile);
        }
        return { sessionFile: message.targetFile };
      }
      case "leaf":
        return { leafId: currentLeafId() };
      case "model-scope":
        return currentModelScope();
      case "refresh-models":
        return refreshModels();
      case "context-snapshot":
        return { snapshot: sessionContext ? captureContextSnapshot(pi, sessionContext) : null };
      default:
        throw new Error("unknown bridge request " + String(message.method));
    }
  }

  function currentLeafId() {
    return sessionContext?.sessionManager?.getLeafId?.() ?? null;
  }

  function currentModelScope() {
    return {
      scopedModelIds: (sessionContext?.scopedModels ?? []).map(
        ({ model }) => model.provider + "/" + model.id,
      ),
      defaultModelId: sessionContext?.model
        ? sessionContext.model.provider + "/" + sessionContext.model.id
        : null,
    };
  }

  async function refreshModels() {
    const registry = sessionContext?.modelRegistry;
    if (typeof registry?.refresh !== "function") {
      return { refreshed: false, reason: "unsupported" };
    }
    await registry.refresh({ allowNetwork: false });
    const modelAllowlist = Object.create(null);
    if (!process.env.PI_OFFLINE) {
      for (const id of registry.getRegisteredProviderIds?.() ?? []) {
        const provider = registry.getRegisteredNativeProvider?.(id);
        const refresh = provider?.refreshModels;
        if (typeof refresh !== "function" || !isHongLLM(provider.baseUrl)) continue;

        let networkPublishedModelIds;
        provider.refreshModels = (context) => refresh.call(provider, {
          ...context,
          publish: async (publication) => {
            const published = await context.publish(publication);
            if (published && context.allowNetwork && publication.persist) {
              networkPublishedModelIds = publication.persist.models.map((model) => model.id);
            }
            return published;
          },
        });
        try {
          const result = await registry.refresh({ providers: [id], allowNetwork: true, signal: AbortSignal.timeout(8500) });
          modelAllowlist[id] = result?.aborted || result?.errors?.has(id) ? [] : networkPublishedModelIds ?? [];
        } finally {
          provider.refreshModels = refresh;
        }
      }
    }
    return { refreshed: true, modelAllowlist };
  }

  function isHongLLM(baseUrl) {
    try {
      return new URL(baseUrl).origin === "https://llm.hktlabs.com";
    } catch {
      return false;
    }
  }

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: buildParameters(tool.inputSchema),
      async execute(_toolCallId, params, signal) {
        nextId += 1;
        const id = "tc-" + String(nextId);
        const result = new Promise((resolve, reject) => {
          pendingToolCalls.set(id, { resolve, reject });
        });
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              const pending = pendingToolCalls.get(id);
              if (!pending) return;
              pendingToolCalls.delete(id);
              pending.reject(new Error("Tool call aborted"));
            },
            { once: true },
          );
        }
        writeLine({
          kind: "tool-call",
          id,
          toolName: tool.name,
          arguments: params ?? {},
        });
        return result;
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionContext = ctx;
    writeLine({
      kind: "model-scope",
      ...currentModelScope(),
    });
    // Pi's active-tool set is session state; a resumed or forked session can
    // predate the bb tools, so make sure every injected tool is active.
    if (tools.length > 0 && typeof pi.setActiveTools === "function") {
      const active = new Set(pi.getActiveTools?.() ?? []);
      let missing = false;
      for (const tool of tools) {
        if (!active.has(tool.name)) {
          active.add(tool.name);
          missing = true;
        }
      }
      if (missing) pi.setActiveTools([...active]);
    }
    writeLine({ kind: "ready", agentSettled: supportsAgentSettlement(PiRuntime.VERSION) });
  });

  pi.on("agent_start", (_event, ctx) => {
    sessionContext = ctx ?? sessionContext;
    runId += 1;
    writeLine({ kind: "agent-start", runId, previousSettlement: lastSettlement });
  });
  pi.on("agent_end", async (_event, ctx) => {
    sessionContext = ctx ?? sessionContext;
    writeLine({ kind: "agent-end-leaf", leafId: currentLeafId() });
  });
  pi.on("agent_settled", async (_event, ctx) => {
    sessionContext = ctx ?? sessionContext;
    lastSettlement = {
      runId,
      leafId: currentLeafId(),
      event: { ..._event },
      ...(ctx?.isIdle?.() === false ? { error: "Pi settlement handler ran after another extension started a new run" } : {}),
    };
    writeLine({ kind: "agent-settled-leaf", ...lastSettlement });
  });
}

function toolErrorText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}
`;
