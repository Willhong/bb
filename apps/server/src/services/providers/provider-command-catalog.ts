import type { ThreadProviderCommand } from "@bb/domain";
import type { HostDaemonContributedEnvEntry } from "@bb/host-daemon-contract";
import type { CommandListResponse } from "@bb/server-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { AppDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { resolveHostProviderEnv } from "../plugins/plugin-agent-contributions.js";
import {
  createStaleWhileRevalidateCache,
  type StaleWhileRevalidateCache,
} from "../lib/stale-while-revalidate-cache.js";
import { resolveBridgeLaunchForProviderId } from "../system/provider-bridge-launch.js";

export const PROVIDER_COMMAND_CATALOG_FRESH_MS = 10_000;
const PROVIDER_COMMAND_CATALOG_MAX_ENTRIES = 256;

export type ProviderCommandCatalogCache =
  StaleWhileRevalidateCache<CommandListResponse>;

export function createProviderCommandCatalogCache(
  options: { now?: () => number } = {},
): ProviderCommandCatalogCache {
  return createStaleWhileRevalidateCache<CommandListResponse>({
    freshMs: PROVIDER_COMMAND_CATALOG_FRESH_MS,
    maxEntries: PROVIDER_COMMAND_CATALOG_MAX_ENTRIES,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export async function readProviderCommandCatalog(
  deps: Pick<AppDeps, "hub" | "logger" | "providerCommandCatalog">,
  args: {
    hostId: string;
    providerId: string;
    cwd: string | null;
    load: (
      contributedEnv: HostDaemonContributedEnvEntry[] | null,
    ) => Promise<CommandListResponse>;
  },
): Promise<CommandListResponse> {
  const contributedEnv = await resolveHostProviderEnv(
    args.hostId,
    args.providerId,
  ).catch((error: unknown) => {
    deps.logger.warn(
      { err: error, hostId: args.hostId, providerId: args.providerId },
      "Unable to resolve the provider's contributed environment; offering scanned commands only",
    );
    return null;
  });
  return deps.providerCommandCatalog.read({
    key: JSON.stringify([
      args.hostId,
      args.providerId,
      args.cwd,
      contributedEnv?.map((entry) => [entry.name, entry.value]) ?? null,
    ]),
    load: () => args.load(contributedEnv),
    onChanged: () =>
      deps.hub.notifyHost(args.hostId, ["provider-commands-changed"]),
    onRefreshError: (error) =>
      deps.logger.warn(
        { err: error, hostId: args.hostId, providerId: args.providerId },
        "Unable to refresh the provider command catalog; keeping the previous list",
      ),
  });
}

export async function listProviderLiveCommands(
  deps: AppDeps,
  args: {
    hostId: string;
    providerId: string;
    cwd: string | null;
    contributedEnv: HostDaemonContributedEnvEntry[] | null;
  },
): Promise<readonly ThreadProviderCommand[]> {
  const bridgeLaunch = resolveBridgeLaunchForProviderId(deps, args.providerId);
  if (bridgeLaunch === null || args.contributedEnv === null) {
    return [];
  }
  try {
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "provider.list_commands",
        providerId: args.providerId,
        bridgeLaunch,
        cwd: args.cwd,
        contributedEnv: args.contributedEnv,
      },
    });
    return result.commands;
  } catch (error) {
    deps.logger.warn(
      { err: error, hostId: args.hostId, providerId: args.providerId },
      "Unable to list the provider's live commands; offering scanned commands only",
    );
    return [];
  }
}
