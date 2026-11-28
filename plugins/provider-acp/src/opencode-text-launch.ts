import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { z } from "zod";

export function openCodeTextLaunch(launch: AcpLaunchSpec): AcpLaunchSpec {
  const inherited =
    launch.env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
  const config = inherited
    ? z.record(z.string(), z.unknown()).parse(JSON.parse(inherited))
    : {};
  return {
    ...launch,
    env: {
      ...launch.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        permission: { "*": "deny" },
        tools: { "*": false },
      }),
    },
  };
}
