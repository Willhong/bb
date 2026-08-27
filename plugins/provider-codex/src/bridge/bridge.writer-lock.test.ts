import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";

const THREAD_ID = "thr_writer_lock_1";
const PROVIDER_THREAD_ID = "codex-writer-lock-1";

const fakeAppServerPath = fileURLToPath(
  new URL("./fake-codex-app-server.mjs", import.meta.url),
);

const sessionOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  reasoningLevel: "low",
} as const;

const changedSessionOptions = {
  ...sessionOptions,
  reasoningLevel: "high",
} as const;

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;
let processLogPath: string;
let writerLockPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-writer-lock-"));
  processLogPath = join(workspaceDir, "app-server-processes.log");
  writerLockPath = join(workspaceDir, "writer.lock");
  const scriptPath = join(workspaceDir, "fake-codex-script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      processLogPath,
      writerLockPath,
      sigtermDelayMs: 500,
    }),
  );
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify([fakeAppServerPath, scriptPath]),
  );
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const cleanupId = 995_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  await waitForAppServerChildrenToExit();
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function spawnedAppServerPids(): number[] {
  return readFileSync(processLogPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("spawn:"))
    .map((line) => Number(line.split(":")[1]));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForAppServerChildrenToExit(): Promise<void> {
  const childPids = spawnedAppServerPids();
  const deadline = Date.now() + 15_000;
  while (childPids.some(processIsAlive)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for app-server children to exit: ${JSON.stringify(childPids.filter(processIsAlive))}`,
      );
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
}

async function resumeThread(id: number): Promise<void> {
  harness.sendRequest(id, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: sessionOptions,
  });
  expect((await harness.waitForResponse(id)).error).toBeUndefined();
}

it("waits for the previous writer before resuming during a settings rebuild", async () => {
  await resumeThread(1);

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    clientRequestId: "creq_abcdefghjk",
    input: [{ type: "text", text: "hello", mentions: [] }],
    options: changedSessionOptions,
  });
  const rebuiltTurn = await harness.waitForResponse(2);

  expect(rebuiltTurn.error).toBeUndefined();
  expect(rebuiltTurn.result).toEqual({ threadId: THREAD_ID });
}, 30_000);

it("finishes releasing the writer before acknowledging thread stop", async () => {
  await resumeThread(1);

  harness.sendRequest(2, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    intent: "release",
    activeTurnId: null,
  });
  expect((await harness.waitForResponse(2)).error).toBeUndefined();

  await resumeThread(3);
}, 30_000);

it("retries a resume while another Codex process is releasing the writer", async () => {
  writeFileSync(writerLockPath, String(process.pid));
  const foreignWriterReleased = new Promise<void>((resolve) => {
    setTimeout(() => {
      rmSync(writerLockPath, { force: true });
      resolve();
    }, 150);
  });

  harness.sendRequest(1, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: sessionOptions,
  });
  const resumed = await harness.waitForResponse(1);
  await foreignWriterReleased;

  expect(resumed.error).toBeUndefined();
  expect(resumed.result).toEqual({
    providerThreadId: PROVIDER_THREAD_ID,
    sessionRestorable: true,
  });
}, 30_000);

it("explains persistent writer contention and resumes after the owner closes", async () => {
  writeFileSync(writerLockPath, String(process.pid));

  harness.sendRequest(1, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: sessionOptions,
  });
  const blocked = await harness.waitForResponse(1);
  rmSync(writerLockPath, { force: true });

  expect(blocked.error?.message).toContain(
    "Close the other Codex session and retry",
  );
  await resumeThread(2);
}, 30_000);
