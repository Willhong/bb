---
name: verify-acp-session-lifecycle
description: Model-check the ACP bridge's per-thread session lifecycle (start, rebuild, thread/stop, release, agent kill) with TLA+. Use before merging any change to startAgentSession, stopSession, releaseSession, removeSession, rebuildAgentSession, reconcileExecutionSettings, runTurn's stopping checks, or the thread/start|resume|fork|stop handlers in packages/provider-bridge-acp/src/bridge/bridge.ts, or when asked whether stop can lose a race with a session start.
---

# Verify the ACP session lifecycle

The ACP bridge handles every runtime request the moment it arrives. It has no
per-thread lock (`runBridgeRequest` in
`packages/provider-bridge-protocol/src/bridge-kit/bridge-harness.ts`), and the
runtime does not wait either (`runThreadOperation` in
`packages/agent-runtime/src/runtime.ts` only counts operations). So a session
start and a `thread/stop` for the same thread interleave at every `await`.
Tests run one order. This check runs every order of those steps for one thread.

## Properties

| Check | Property | Harm when broken |
|---|---|---|
| `NoOrphan` → `NoOrphanAtRest` | After every request finishes, each agent process still running is the thread's registered session. | An agent process keeps running that no thread owns: it uses memory and tokens and is killed only at bridge shutdown. |
| `StopDuringRebuild` → `NoPromptAfterStop` (and `StopWins`) | After `thread/stop` answers `{ ok: true }`, no `session/prompt` goes to an agent. | The user presses stop and the agent still receives the message and works on it (edits files, runs tools). |
| `StopDuringFreshStart` → `StopWins` | If `thread/stop` arrives while a start is in flight, then once stop has answered, no session of that thread can run turns. | A stopped thread comes back to life with a live agent. |

## Run

From the repository root:

```sh
.bb/skills/verify-acp-session-lifecycle/check.sh            # all checks, about 5 s
.bb/skills/verify-acp-session-lifecycle/check.sh NoOrphan   # one check
```

The script needs Java 17+ and `tla2tools.jar` v1.7.4 at
`~/.local/share/tlaplus/v1.7.4/tla2tools.jar`, or the path in `TLA2TOOLS_JAR`.
It checks the jar's SHA-256. When the jar is missing, it prints the install
command (`gh release download v1.7.4 -R tlaplus/tlaplus -p tla2tools.jar ...`).
Exit 0 means every check you asked for passed.

### Expected result at the sync commit

At the sync commit all three checks pass: `PASS NoOrphan`,
`PASS StopDuringRebuild`, `PASS StopDuringFreshStart`, exit 0.

Compare each check's PASS or FAIL and, for a FAIL, the invariant name. The
state counts change whenever the model gains a variable or constant, so do
not compare them. `check.sh` prints the count from TLC's last "distinct
states found" line; on larger models TLC prints progress lines first.

The model does not read the code. If you run `check.sh` on an unchanged
model, you get this result for any code change. To judge a change, whether
yours or someone else's, first mirror the change in the model (see
[Check a change](#check-a-change)). Then run the check. The change is clean
when the updated model still passes every check.

## Does my change touch the verified code?

Coverage record. Line numbers are at the sync commit.

| Model action | Code (`packages/provider-bridge-acp/src/bridge/bridge.ts` unless noted) |
|---|---|
| `StartArrive` | turn/start handler L4129-4147 → `reconcileExecutionSettings` L3400-3489 → `rebuildAgentSession` L3518-3541; thread/start\|resume\|fork handler L4063-4106; `startAgentSession` L2344-2372 (adds a `PendingSessionStart`, removes it in `finally`); `startAgentSessionWhilePending` L2374-2390 incl. `await stopSession(existing)`; `stopSession` L2805-2834 up to `await kill()` |
| `StartExistingKilled` | `stopSession` L2834-2836 (`kill` resolves, `removeSession`); the `pending.stopRequested` check L2391-2393 |
| `StartSpawn` | `await resolveAgentLaunchArgs` L2433 (L1535-1591); the `pending.stopRequested` check L2434-2436; then L2437-2529 up to `sessionsByBbThreadId.set` |
| `StartConstruct` | construction awaits L2532-2692; the `session.stopping` guard L2694-2696; registration L2697-2790; the catch L2791-2802 |
| `StartFinish` | turn/start after `await reconciled` L4147-4164; `runTurn` L3249-3311 with its `session.stopping` checks L3266 and L3278 |
| `StopArrive`, `StopKilled` | thread/stop handler L4207-4219 incl. `requestStopOfPendingSessionStarts` (L2328-2342) at L4208; `stopSession` L2805-2837; `releaseSession` L3119-3133; `removeSession` L2228-2239 |
| `StartPending`, `stopMarked` | `PendingSessionStart`, `pendingSessionStartsByBbThreadId` L2328-2336 |
| `KillComplete` | `createAcpAgentConnection().kill` and `stopAgent` in `packages/provider-bridge-acp/src/bridge/agent-connection.ts` L140-149, L348-353 |
| `LiveForThread` | `liveSessionForThread` L2218-2226 |

**Sync commit: the commit that added this skill** (it also contains the
fix for the two findings below). At this commit the model was last
confirmed to describe the code above. The line numbers in the table were
rechecked against `bridge.ts` after the skill was carried onto the personal
`main`; the code there is the same as at the commit that added the skill. Print its hash with:

```sh
git log --diff-filter=A --format=%h -- .bb/skills/verify-acp-session-lifecycle/SKILL.md
```

When you move the sync commit forward, replace this paragraph with the new
commit's hash.

To see whether a change needs a recheck:

```sh
sync="$(git log --diff-filter=A --format=%h -- .bb/skills/verify-acp-session-lifecycle/SKILL.md)"
git diff "$sync" -- packages/provider-bridge-acp/src/bridge/bridge.ts \
  packages/provider-bridge-acp/src/bridge/agent-connection.ts \
  packages/provider-bridge-protocol/src/bridge-kit/bridge-harness.ts
```

Recheck if the diff touches a function in the table, or adds, removes or
moves an `await`. An `await` is where other requests can run. Code between
two `await`s is one model action. A removed `await` merges two actions. It
can also bring in an `await` that the model left out, such as
`await releaseCursorMcpApproval` at the end of `stopSession`. Give that
`await` its own action when state that a property reads changes across it.

## Read a result

`check.sh` prints the failing steps and the last state. TLC runs with one
worker, breadth first, so the trace is a shortest path and the same on every
run. Tell the result as a short story in the code's words, one sentence per
step, using the table above. Example: the `StopDuringRebuild` failure from
before the fix. To see this trace again, edit `model/StopDuringRebuild.cfg`:
set `StopMarksPending = FALSE` and drop `StopWins` from `INVARIANTS`. With
`StopWins` left in, TLC stops at the shorter `StopWins` violation instead.

1. `StartArrive`: the user sent a message with changed settings. The bridge
   starts rebuilding and begins killing the old agent (`stopSession(existing)`).
   That marks the old session `stopping`.
2. `StopArrive`: the user presses stop. `thread/stop` finds the old session.
   It is already `stopping`, so `stopSession` returns at once. The bridge
   answers `{ ok: true }`.
3. `KillComplete`, `StartExistingKilled`: the old agent exits and the bridge
   removes it.
4. `StartSpawn`, `StartConstruct`: the rebuild launches a new agent and
   registers it. Nothing records that a stop came in, so no guard fires.
   (The fix records it in `PendingSessionStart.stopRequested`, and the start
   throws at L2391.)
5. `StartFinish`: `runTurn` sees a session that is not `stopping` and sends
   `session/prompt`. The stopped message runs.

### Real bug or modeling error?

Replay the steps on the real bridge before you call it a bug. Write a test in
`packages/provider-bridge-acp/src/bridge/bridge.test.ts` that sends the
requests in the trace's order. Use `sendRequest` without awaiting between the
requests that the trace interleaves. Then assert on what the user would see.
The fake agent can log prompts (`FAKE_ACP_PROMPT_LOG`), launches
(`FAKE_ACP_LAUNCH_LOG`, one `launch <pid>` line per process) and requests
(`FAKE_ACP_REQUEST_LOG`). To test for an orphan process, read the pids from
the launch log and check each one with `process.kill(pid, 0)`. Afterwards,
kill any pid that is still alive. Two traps:

- The test process's stdout is the bridge's output channel. Anything a test
  writes there, such as `console.log`, breaks the JSON stream. Write to a
  file or to stderr.
- vitest's default timeout is 5 s. If a replay waits longer, pass a timeout
  as the third argument to `it`.

Two tests replay the traces:

- "sends no prompt after thread/stop answers during a session rebuild"
  replays `StopDuringRebuild`.
- "fails a thread/start that thread/stop answered before the session was
  registered" replays `StopDuringFreshStart`. It holds `startAgentSession` at
  `await resolveAgentLaunchArgs` with a model-list command whose arguments no
  other test uses. That keeps the catalog cache from skipping the wait.

Run both with:

```sh
cd packages/provider-bridge-acp && npx vitest run --config vitest.config.ts \
  src/bridge/bridge.test.ts -t "during a session rebuild|before the session was registered"
```

- **The replay shows the same harm:** it is a real bug. Report it with the
  steps. Do not weaken the property or the model to make the check pass.
- **The replay cannot take that order:** it is a modeling error. For example,
  two model actions are one synchronous stretch of code, or a guard is
  missing from the model. Fix the model so that it points at that code, and
  record the change in the coverage table.

## Check a change

Use these steps for your own change and for a change someone else proposes.

1. Copy `.bb/skills/verify-acp-session-lifecycle/` aside, so that you can
   restore it if the change is rejected.
2. Map every changed `await` and guard to a model action. Edit
   `model/AcpSessionLifecycle.tla` so that each action is still one
   synchronous stretch of code. Comment each action with its code lines.
   `StopArrive` covers both `thread/stop` intents because `stopSession` and
   `releaseSession` behave the same here. If a change makes `interrupt` and
   `release` differ, split the action by intent.
3. Two constants in the `.cfg` files mirror code. Set one to `FALSE` only
   if the code stops doing what it describes.
   - `StopExistingFirst` mirrors `if (existing) { await stopSession(existing); }`
     at L2388-2390.
   - `StopMarksPending` mirrors `requestStopOfPendingSessionStarts` in the
     thread/stop handler (L4208), together with the `pending.stopRequested`
     checks at L2391-2393 and L2434-2436.
4. Run `check.sh`. Read each result as described above.
5. Prove that the check can still fail. Break the property in the real code
   on a scratch change. For example, delete the stopSession(existing) call for
   `NoOrphan`, or delete the `requestStopOfPendingSessionStarts` call for the
   two stop checks. (The second break also makes both replay tests fail.) Mirror the break in the model and confirm that `check.sh`
   reports FAIL. Then revert both.
6. Update the line numbers in the coverage table. Move the sync commit forward
   only after you have confirmed that the model describes the code at the
   new commit.

## Fixed findings

The first run of this check found two findings at `1ee11afde2`. The commit
that added this skill fixed both. Keep both replay tests.

1. **Stop during a settings rebuild did not stop the turn**
   (`StopDuringRebuild`). Before the fix, this was replayed on the real
   bridge in 4 of 4 runs: `thread/stop` answered `{ ok: true }`, then the
   input was accepted, the prompt reached the new agent, and the turn
   completed as `completed`. In bb, the trigger was to change the model,
   reasoning level, permission mode or environment, send a message, and press
   stop before the old agent had exited. That takes up to about 1 s for the
   kill grace period, and up to 30 s more when the model catalog must be
   listed. An agent that has exited also triggers a rebuild on the next
   message.
2. **Stop during a fresh `thread/start` was lost** (`StopDuringFreshStart`).
   Before the fix, the bridge answered the stop and then launched and
   registered the agent anyway. The runtime sends this order only when it
   abandons a start after `DEFAULT_THREAD_CREATION_REQUEST_TIMEOUT_MS` (2 min).

Both came from one gap. `startAgentSession` puts the new session in
`sessionsByBbThreadId` only after two `await`s. A `thread/stop` that landed
before then found no session, or found the old session already stopping,
and so had nothing to mark. The fix registers a `PendingSessionStart` before
the first `await`. `thread/stop` sets its `stopRequested`. The start checks
it after each of those two `await`s and throws "released during
construction". After the stop, a `turn/start` that triggered the rebuild
fails with that error, and the thread has no session, as after any stop.

## Scope

- **Verified:** every interleaving of one start (rebuild or fresh) and one
  `thread/stop` (interrupt or release) for one thread, including the agent
  process exit. The state space is exhaustive: 59 states for `NoOrphan`, 32
  for `StopDuringRebuild` and 27 for `StopDuringFreshStart`.
- **Assumptions:** each JavaScript stretch between `await`s is atomic.
  `kill()` rejects every pending agent request. `stopSession` with an active
  prompt starts `kill` at once. The real code first waits up to
  `THREAD_STOP_CANCEL_TIMEOUT_MS` for the cancel; no property here depends on
  that wait.
- **Not covered:**
  - two starts for the same thread at once (the code marks every pending
    start of the thread, but the model has only one)
  - steer (`turn/steer`) and its queued inputs
  - rebuilds inside `runTurn`'s loop (L3276)
  - agent crash during construction (`onExit`, L2465-2480)
  - fork's source session
  - compaction and agent turns
  - Cursor MCP approval release
  - bridge shutdown (`stopAllSessions`)
  - the runtime's own state after stop
