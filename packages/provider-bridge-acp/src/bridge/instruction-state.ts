import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const instructionStateSchema = z.object({
  version: z.literal(1),
  promptAttempted: z.boolean(),
  instructionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});

export type InstructionState = z.infer<typeof instructionStateSchema>;

export function instructionHash(
  instructions: string | undefined,
): string | null {
  return instructions
    ? createHash("sha256").update(instructions).digest("hex")
    : null;
}

export function instructionStateKey(
  agent: { command: string; args: string[] },
  cwd: string,
  providerThreadId: string,
  envVars: Record<string, string> = {},
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        agent.command,
        agent.args,
        cwd,
        providerThreadId,
        Object.entries(envVars).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
}

export class InstructionStateStore {
  private readonly memory = new Map<string, InstructionState>();

  constructor(private readonly dataDir?: string) {}

  read(key: string): InstructionState | undefined {
    if (!this.dataDir) return this.memory.get(key);
    let text: string;
    try {
      text = readFileSync(
        join(this.dataDir, "instructions", `${key}.json`),
        "utf8",
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
    return instructionStateSchema.parse(JSON.parse(text));
  }

  write(key: string, state: InstructionState): void {
    const parsed = instructionStateSchema.parse(state);
    if (!this.dataDir) {
      this.memory.set(key, parsed);
      return;
    }
    const directory = join(this.dataDir, "instructions");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = join(directory, `${key}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(parsed), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, destination);
  }
}
