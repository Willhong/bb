import { experimental_execHostFile } from "@get-bb/plugin-sdk/process";
import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { isAbsolute } from "node:path";
import { z } from "zod";

const entry =
  "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
const bootstrap = z.tuple([
  z.string().min(1),
  z.literal("-I"),
  z.literal("-c"),
  z.string().max(12000),
]);
const textPolicy = `
from hermes_cli.mcp_startup import set_mcp_server_filter
set_mcp_server_filter(["no_mcp"])
import inspect
import run_agent
_original_agent = run_agent.AIAgent
_required = {"enabled_toolsets", "skip_memory", "skip_context_files", "skip_background_review"}
if not _required.issubset(inspect.signature(_original_agent).parameters):
    raise RuntimeError("Hermes does not expose the required text-only controls")
class _ForegroundTextAgent(_original_agent):
    def __init__(self, *args, **kwargs):
        kwargs.update(enabled_toolsets=[], skip_memory=True, skip_context_files=True,
                      skip_background_review=True, load_soul_identity=False)
        super().__init__(*args, **kwargs)
        if self.tools:
            raise RuntimeError("Hermes enabled tools in a text-only conversation")
run_agent.AIAgent = _ForegroundTextAgent
`;

export async function hermesTextLaunch(
  launch: AcpLaunchSpec,
  signal: AbortSignal,
): Promise<AcpLaunchSpec> {
  if (launch.args.length !== 1 || launch.args[0] !== "acp")
    throw new Error(
      "The registered Hermes launcher does not support the text-only ACP adapter.",
    );
  const { stdout } = await experimental_execHostFile(
    launch.command,
    ["--print-runtime-command"],
    { signal, maxBuffer: 16000, env: { ...process.env, ...launch.env } },
  );
  const [python, isolated, codeFlag, code] = bootstrap.parse(
    JSON.parse(stdout),
  );
  if (!isAbsolute(python) || !code.endsWith(entry))
    throw new Error(
      "The registered Hermes runtime bootstrap is not supported.",
    );
  return {
    ...launch,
    command: python,
    args: [
      isolated,
      codeFlag,
      code.slice(0, -entry.length) + textPolicy + "\n" + entry,
      "acp",
    ],
  };
}
