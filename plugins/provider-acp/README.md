# ACP providers

First-party plugin for ACP (Agent Client Protocol) agent providers: Cursor,
opencode, omp, Grok Build and Hermes Agent.

OpenCode Go usage appears under OpenCode in the Provider usage panel for the
selected machine. It reads the official Go endpoint using the machine's OpenCode
Console account or API credentials and reports the five-hour, weekly, and monthly
windows with their reset times. Sign in to Go in OpenCode on that machine.
The same data is available through `bb settings usage --machine <id> --json`
and `bb.sdk.system.usageLimits({ hostId, providerId: "acp-opencode" })`.
Other OpenCode providers and pay-as-you-go spending are not included.

The plugin has no bridge of its own. Every agent it registers runs on the
published ACP kit, `@get-bb/plugin-sdk/provider-bridge/acp`, which its
`bb.host` entry re-exports (`src/host.ts`). That is the whole
point of the kit: a third-party plugin adds an ACP agent exactly the way this
one does, with no bb-side code. The plugin is forkable
(`docs/forkable-plugins.md`): its lint rule and the fork check prove it takes
no shortcut — no file here may import a workspace package.

## Session instructions

The bridge prepends BB instructions to the first prompt of a fresh ACP session.
A successful load or fork preserves the existing instructions instead of adding
another copy merely because the connection changed. If replayed history or the
live source session exposes different instructions, the next prompt carries the
updated instructions once. The bridge also persists a prompt-attempt marker and
an instruction hash under its host-local data directory, keyed by agent launch
identity (including explicitly configured environment variables), working directory
and native session ID. Environment values are hashed, not stored as plaintext.
No instruction text is stored.
This preserves initial delivery when a new session is closed before its first
prompt, including across bridge process restarts. A fork inherits known source
state when its source identity can be resolved.

For older sessions with neither a local record nor replayed instructions, the
bridge leaves restored history unchanged rather than assuming instructions are
missing. A failed or unsupported load that creates a fresh session initializes
its instructions normally. Compaction alone does not trigger reinjection.

The attempt marker is written atomically before sending a prompt. A crash between
the marker write and agent receipt is ambiguous: without replay evidence the
bridge favors avoiding duplicate delivery, not an exactly-once guarantee.
Unreadable or invalid state fails construction rather than silently guessing.
A changed working directory or agent launch identity has a separate record;
legacy fallback applies if that identity cannot replay its previous instructions.

What lives here:

- `server.ts` — the plugin's runtime: it reconciles one registration per
  agent, from the shipped list (`src/known-agents.ts`) plus whatever the
  `customAgents` setting declares.
- `src/agents.ts` — the agent definition and the setting's schema, built out
  of the kit's own launch-spec schema so what the setting accepts is exactly
  what the bridge parses. The setting itself is a multi-line JSON field
  (`experimental_multiline`) whose description stays at two sentences; the
  field reference — required and optional fields, the replacement rule for a
  shipped agent's id, the `acp-<id>` provider id — is the "Custom ACP Agents"
  chapter of `docs/configuration.md`.
- `src/configured-agents.ts` — resolving the setting's JSON into agent
  definitions, with a warning for each entry it cannot use.
- `src/registry.ts` and `src/registry-service.ts` — the official ACP registry:
  reading its document, turning an `npx` or `uvx` agent into a `customAgents`
  entry, and the `listRegistry` / `addRegistryAgent` / `removeAgent` RPC and
  `bb acp` CLI commands that the settings section (`app.tsx`) and the CLI share.
- `src/declaration.ts` — one agent definition becomes one
  `bb.providers.register` declaration: ids, display names, icons,
  capabilities, and the bridge options it launches with (`acpLaunchSpec`, and
  `acpDialect` for the agents whose vendor side channels the kit reads).
- `src/host.ts` — the `bb.host` artifact, two surfaces in one file: the kit's
  bridge, re-exported, and a host entry whose one RPC asks an agent what it
  supports on the machine it is installed on (`src/contract.ts`,
  `src/probe-capabilities.ts`).
- `icons/` — the provider logos, declared in `package.json` under
  `bb.branding.experimental_icons` so the packaged build ships them.

The kit itself, including the ACP wire schema, the delta translation, the
per-agent dialects and the bridge process, is `packages/provider-bridge-acp`.
