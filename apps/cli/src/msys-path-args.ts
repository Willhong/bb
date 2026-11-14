import { existsSync } from "node:fs";

interface RestoreMsysPosixArgsInput {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

export function resolveMsysRoot(env: NodeJS.ProcessEnv): string | null {
  if (!env.MSYSTEM) return null;
  const exePath = env.EXEPATH?.trim();
  if (!exePath) return null;
  const root = exePath
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\/(usr\/)?bin$/i, "");
  return root === "" ? null : `${root}/`;
}

function restoreValue(
  value: string,
  root: string,
  exists: (path: string) => boolean,
): string {
  if (!value.toLowerCase().startsWith(root.toLowerCase())) return value;
  if (exists(value)) return value;
  return `/${value.slice(root.length)}`;
}

function restoreArg(
  arg: string,
  root: string,
  exists: (path: string) => boolean,
): string {
  const equals = arg.indexOf("=");
  if (arg.startsWith("-") && equals > 0) {
    const value = arg.slice(equals + 1);
    const restored = restoreValue(value, root, exists);
    return restored === value ? arg : `${arg.slice(0, equals + 1)}${restored}`;
  }
  return restoreValue(arg, root, exists);
}

export function restoreMsysPosixArgs(
  input: RestoreMsysPosixArgsInput,
): string[] {
  const argv = [...input.argv];
  if (input.platform !== "win32") return argv;
  const root = resolveMsysRoot(input.env);
  if (root === null) return argv;
  const exists = input.exists ?? existsSync;
  return argv.map((arg) => restoreArg(arg, root, exists));
}

export function restoreProcessMsysPosixArgs(): void {
  const restored = restoreMsysPosixArgs({
    argv: process.argv.slice(2),
    env: process.env,
    platform: process.platform,
  });
  process.argv.splice(2, restored.length, ...restored);
}
