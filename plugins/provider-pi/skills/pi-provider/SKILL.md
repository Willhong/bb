---
name: pi-provider
description: "Inspect BB Pi provider support for Fast mode, message editing, and context compaction."
---

# Pi provider

Pi supports editing and rerunning eligible user messages and compacting idle or
errored threads through the core `bb thread edit-message` and `bb thread compact`
commands. Inspect the thread first and use live command help for arguments.
Provider confirmation determines whether the operation completed.

Use the target host's provider catalog for available models and execution options.

## Fast mode

Use BB's Default/Fast selector, not the personal Pi `/fast` command. The same
option is available through SDK thread execution options (`serviceTier`) and
`bb thread tell <id> --service-tier fast "message"` (use `default` to turn it off).
Inspect `bb provider models --help` for the catalog on the target host.

Fast is advertised only for supported model/API connections:

- OpenAI, OpenAI Codex, and llmproxy using OpenAI Responses or Chat Completions:
  requests `service_tier: "priority"`; Default requests `"default"`.
- Anthropic and llmproxy using Anthropic Messages with Claude Opus 5.5:
  requests `speed: "fast"`.
- Claude Opus 5 and Opus 4.8 on those Anthropic connections additionally require
  `anthropic-beta: fast-mode-2026-02-01`. Existing beta headers are preserved.
- Sonnet, Haiku, Opus 4.6, unrecognized models, and other transports do not
  advertise Fast. Switching models must re-evaluate the available tiers.

Changing the tier rebuilds the Pi child with the same session identity and
history on the next turn. BB owns the tier through `BB_PI_SERVICE_TIER`, an
internal child environment value; user environment overrides cannot replace it.
The existing environment wire contract is reused, including older consumers
that ignore this internal variable; no new daemon protocol field is introduced.
Personal extensions should defer to BB when that variable is present.

Fast is a request, not proof of delivery: a proxy may ignore it or upstream
may reject it. Costs can increase. Anthropic beta models require account access.
Do not report upstream Fast as confirmed without response metadata.
Anthropic protocol reference: https://platform.claude.com/docs/en/build-with-claude/fast-mode
