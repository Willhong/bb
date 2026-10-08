import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  InstructionStateStore,
  instructionHash,
  instructionStateKey,
} from "./instruction-state.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "acp-instruction-state-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
const agent = { command: "hermes", args: ["acp"] };

it("retains an unprompted session across store recreation without storing instructions", () => {
  const key = instructionStateKey(agent, "/workspace", "native-session");
  const store = new InstructionStateStore(directory);
  expect(store.read(key)).toBeUndefined();
  store.write(key, {
    version: 1,
    promptAttempted: false,
    instructionHash: null,
  });
  expect(new InstructionStateStore(directory).read(key)).toEqual({
    version: 1,
    promptAttempted: false,
    instructionHash: null,
  });
  store.write(key, {
    version: 1,
    promptAttempted: true,
    instructionHash: instructionHash("private instructions"),
  });
  expect(new InstructionStateStore(directory).read(key)?.promptAttempted).toBe(
    true,
  );
  const files = readdirSync(join(directory, "instructions"));
  expect(files).toEqual([`${key}.json`]);
  expect(
    readFileSync(join(directory, "instructions", files[0]!), "utf8"),
  ).not.toContain("private instructions");
});

it("separates launch identities, working directories and native sessions", () => {
  const keys = [
    instructionStateKey(agent, "/a", "session"),
    instructionStateKey(agent, "/b", "session"),
    instructionStateKey(agent, "/a", "other-session"),
    instructionStateKey({ command: "other", args: ["acp"] }, "/a", "session"),
    instructionStateKey(
      { command: "hermes", args: ["-p", "other", "acp"] },
      "/a",
      "session",
    ),
  ];
  expect(new Set(keys).size).toBe(keys.length);
});

it("separates environment-selected profiles and ignores environment ordering", () => {
  const a = instructionStateKey(agent, "/workspace", "session", {
    HERMES_HOME: "/profile-a",
    OTHER: "value",
  });
  const b = instructionStateKey(agent, "/workspace", "session", {
    HERMES_HOME: "/profile-b",
    OTHER: "value",
  });
  expect(a).not.toBe(b);
  expect(a).toBe(
    instructionStateKey(agent, "/workspace", "session", {
      OTHER: "value",
      HERMES_HOME: "/profile-a",
    }),
  );
  const store = new InstructionStateStore(directory);
  store.write(a, { version: 1, promptAttempted: false, instructionHash: null });
  expect(store.read(b)).toBeUndefined();
});

it("rejects corrupt state instead of treating it as never delivered", () => {
  const key = instructionStateKey(agent, "/workspace", "native-session");
  const store = new InstructionStateStore(directory);
  store.write(key, {
    version: 1,
    promptAttempted: false,
    instructionHash: null,
  });
  writeFileSync(
    join(directory, "instructions", `${key}.json`),
    '{"version":1}',
  );
  expect(() => new InstructionStateStore(directory).read(key)).toThrow();
});

it("does not turn a failed disk write into a successful in-memory record", () => {
  const invalidDirectory = join(directory, "not-a-directory");
  writeFileSync(invalidDirectory, "occupied");
  const store = new InstructionStateStore(invalidDirectory);
  const key = instructionStateKey(agent, "/workspace", "native-session");
  expect(() =>
    store.write(key, {
      version: 1,
      promptAttempted: false,
      instructionHash: null,
    }),
  ).toThrow();
});
