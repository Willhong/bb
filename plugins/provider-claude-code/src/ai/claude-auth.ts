import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const KEYCHAIN_LOOKUP_TIMEOUT_MS = 10_000;

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export const claudeCredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullish(),
    subscriptionType: z.string().nullish(),
    rateLimitTier: z.string().nullish(),
  }),
});

export type ClaudeCredentials = z.infer<
  typeof claudeCredentialsSchema
>["claudeAiOauth"];

export const claudeAccountSchema = z.object({
  oauthAccount: z
    .object({
      emailAddress: z.string().email().nullish(),
      accountUuid: z.string().uuid().nullish(),
    })
    .nullish(),
});

export function claudeCredentialsPath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

export function parseClaudeCredentials(raw: string): ClaudeCredentials | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  if (/^(?:[0-9a-f]{2})+$/iu.test(trimmed)) {
    candidates.push(Buffer.from(trimmed, "hex").toString("utf8"));
  }
  for (const candidate of candidates) {
    try {
      const parsed = claudeCredentialsSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data.claudeAiOauth;
    } catch {}
  }
  return null;
}

async function readKeychainCredentials(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const argumentSets = [
    [
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-a",
      os.userInfo().username,
      "-w",
    ],
    ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
  ];
  for (const args of argumentSets) {
    try {
      const { stdout } = await execFileAsync("security", args, {
        timeout: KEYCHAIN_LOOKUP_TIMEOUT_MS,
      });
      if (stdout.trim()) return stdout.trim();
    } catch {}
  }
  return null;
}

export async function readClaudeCredentials(): Promise<ClaudeCredentials | null> {
  const keychainCredentials = await readKeychainCredentials();
  if (keychainCredentials !== null) {
    const parsed = parseClaudeCredentials(keychainCredentials);
    if (parsed !== null) return parsed;
  }
  try {
    return parseClaudeCredentials(
      await fs.readFile(claudeCredentialsPath(), "utf8"),
    );
  } catch {
    return null;
  }
}

export async function readClaudeAccount(): Promise<
  z.infer<typeof claudeAccountSchema>["oauthAccount"] | null
> {
  try {
    const parsed = claudeAccountSchema.safeParse(
      JSON.parse(
        await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8"),
      ),
    );
    return parsed.success ? (parsed.data.oauthAccount ?? null) : null;
  } catch {
    return null;
  }
}

export function claudeCredentialsExpired(
  credentials: ClaudeCredentials,
  now: number = Date.now(),
): boolean {
  return credentials.expiresAt != null && now >= credentials.expiresAt;
}
