------------------------- MODULE AcpSessionLifecycle -------------------------
(***************************************************************************)
(* One bb thread inside the ACP provider bridge.                           *)
(*                                                                         *)
(* Code: packages/provider-bridge-acp/src/bridge/bridge.ts                 *)
(*                                                                         *)
(* The bridge runs every runtime request as soon as it arrives, with no    *)
(* per-thread lock (runBridgeRequest in                                    *)
(* packages/provider-bridge-protocol/src/bridge-kit/bridge-harness.ts).    *)
(* So a session start and a thread/stop for the same thread can interleave *)
(* at every await. Each action below is the code between two awaits.       *)
(*                                                                         *)
(* Two ways a session start begins:                                        *)
(*   "rebuild": turn/start whose execution settings need a new agent       *)
(*              process (reconcileExecutionSettings -> rebuildAgentSession *)
(*              -> startAgentSession kind "resume"). A live session "old"  *)
(*              exists.                                                    *)
(*   "fresh":   thread/start with no session for the thread.               *)
(* The agent process the start launches is "new".                          *)
(***************************************************************************)
EXTENDS TLC

CONSTANTS
  Modes,             \* subset of {"rebuild", "fresh"} to check
  StopExistingFirst, \* TRUE = startAgentSessionWhilePending awaits
                     \* stopSession(existing) before it launches the new agent
                     \* (bridge.ts L2388-2390)
  StopMarksPending   \* TRUE = thread/stop records the stop on in-flight starts
                     \* (requestStopOfPendingSessionStarts, L2337-2342, called
                     \* at L4208) and the start checks it after each await
                     \* before registration (L2391-2393, L2434-2436)

Conns == {"old", "new"}
None == "none"
StartDone == {"done", "failed", "rejected"}

VARIABLES
  mode,
  proc,            \* agent child process: "none" | "running" | "killing" | "dead"
  stopping,        \* session.stopping
  registered,      \* session.providerThreadId set (bridge.ts L2757)
  current,         \* sessionsByBbThreadId.get(threadId), or None
  prompted,        \* a session/prompt request went to this agent (bridge.ts L3307)
  startPc,         \* where the start request is
  existing,        \* the session startAgentSessionWhilePending found at L2381
  stopPc,          \* "notSent" | "killing" | "acked"
  stopTarget,      \* the session thread/stop is stopping
  stopDuringStart, \* thread/stop arrived after the start request and before it finished
  promptAfterAck,  \* a session/prompt went out after thread/stop answered { ok: true }
  stopMarked       \* PendingSessionStart.stopRequested of the in-flight start

vars == <<mode, proc, stopping, registered, current, prompted, startPc,
          existing, stopPc, stopTarget, stopDuringStart, promptAfterAck,
          stopMarked>>

\* A session that can still run turns: registered, not stopping, process up.
Live(c) == registered[c] /\ ~stopping[c] /\ proc[c] = "running"

\* liveSessionForThread (bridge.ts L2218-2226)
LiveForThread == current # None /\ ~stopping[current] /\ registered[current]

\* startAgentSession has added its PendingSessionStart (L2344-2356) and has
\* not yet returned or thrown (finally at L2365-2372).
StartPending == startPc \in {"awaitExistingKill", "resolveArgs", "construct"}

\* The start aborts at a pending.stopRequested check.
StopSeen == StopMarksPending /\ stopMarked

Init ==
  /\ mode \in Modes
  /\ proc = [c \in Conns |->
               IF mode = "rebuild" /\ c = "old" THEN "running" ELSE "none"]
  /\ stopping = [c \in Conns |-> FALSE]
  /\ registered = [c \in Conns |-> mode = "rebuild" /\ c = "old"]
  /\ current = IF mode = "rebuild" THEN "old" ELSE None
  /\ prompted = [c \in Conns |-> FALSE]
  /\ startPc = "notSent"
  /\ existing = None
  /\ stopPc = "notSent"
  /\ stopTarget = None
  /\ stopDuringStart = FALSE
  /\ promptAfterAck = FALSE
  /\ stopMarked = FALSE

-----------------------------------------------------------------------------
(* Start request *)

\* "rebuild": turn/start handler L4129-4147 runs synchronously into
\*   rebuildAgentSession L3518-3541 and startAgentSession L2344-2364, which
\*   adds a PendingSessionStart and calls startAgentSessionWhilePending
\*   L2374-2390.
\* "fresh": thread/start handler L4063-4106 into startAgentSession.
\* stopSession(existing) L2805-2834 runs up to `await session.connection.kill()`.
StartArrive ==
  /\ startPc = "notSent"
  /\ IF mode = "rebuild" /\ ~LiveForThread
       THEN \* turn/start answers "No active ACP session" (L4131-4134)
            /\ startPc' = "rejected"
            /\ UNCHANGED <<proc, stopping, existing>>
       ELSE LET e == current IN
            /\ existing' = e
            /\ IF StopExistingFirst /\ e # None /\ ~stopping[e]
                 THEN /\ stopping' = [stopping EXCEPT ![e] = TRUE]  \* L2812
                      /\ proc' = [proc EXCEPT ![e] = "killing"]     \* L2834
                      /\ startPc' = "awaitExistingKill"
                 ELSE \* no existing session, or stopSession returns at once (L2809)
                      /\ startPc' = "resolveArgs"
                      /\ UNCHANGED <<stopping, proc>>
  /\ UNCHANGED <<mode, registered, current, prompted, stopPc, stopTarget,
                 stopDuringStart, promptAfterAck, stopMarked>>

\* `await session.connection.kill()` resolves; removeSession (L2835,
\* L2228-2239). Then the pending.stopRequested check at L2391-2393.
StartExistingKilled ==
  /\ startPc = "awaitExistingKill"
  /\ proc[existing] = "dead"
  /\ current' = IF current = existing THEN None ELSE current
  /\ startPc' = IF StopSeen THEN "failed" ELSE "resolveArgs"
  /\ UNCHANGED <<mode, proc, stopping, registered, prompted, existing, stopPc,
                 stopTarget, stopDuringStart, promptAfterAck, stopMarked>>

\* `await resolveAgentLaunchArgs(params)` resolves (L2433; L1535-1591 can
\* spawn the model-list command for up to MODEL_LIST_TIMEOUT_MS). The
\* pending.stopRequested check at L2434-2436 throws before anything is
\* launched. Otherwise L2437-2529 run synchronously: launch the agent and
\* sessionsByBbThreadId.set (L2529).
StartSpawn ==
  /\ startPc = "resolveArgs"
  /\ IF StopSeen
       THEN /\ startPc' = "failed"
            /\ UNCHANGED <<proc, current>>
       ELSE /\ proc' = [proc EXCEPT !["new"] = "running"]
            /\ current' = "new"
            /\ startPc' = "construct"
  /\ UNCHANGED <<mode, stopping, registered, prompted, existing, stopPc,
                 stopTarget, stopDuringStart, promptAfterAck, stopMarked>>

\* The construction awaits (initialize, authenticate, session/load|new,
\* model selection, L2532-2692) end. A killed agent rejects every pending
\* request (agent-connection.ts L348-353); a stopping session hits the guard
\* at L2694-2696. Both go to the catch at L2791-2802. Otherwise L2697-2790 run
\* synchronously and register the session (L2757).
StartConstruct ==
  /\ startPc = "construct"
  /\ IF proc["new"] # "running" \/ stopping["new"]
       THEN /\ stopping' = [stopping EXCEPT !["new"] = TRUE]
            /\ proc' = [proc EXCEPT !["new"] =
                          IF @ = "running" THEN "killing" ELSE @]
            /\ current' = IF current = "new" THEN None ELSE current
            /\ startPc' = "failed"
            /\ UNCHANGED registered
       ELSE /\ registered' = [registered EXCEPT !["new"] = TRUE]
            /\ startPc' = "returned"
            /\ UNCHANGED <<stopping, proc, current>>
  /\ UNCHANGED <<mode, prompted, existing, stopPc, stopTarget,
                 stopDuringStart, promptAfterAck, stopMarked>>

\* "rebuild": back in turn/start after `await reconciled` (L4147), runTurn
\* (L3249-3311) checks session.stopping (L3266, L3278) and sends
\* session/prompt. "fresh": thread/start answers with the providerThreadId.
StartFinish ==
  /\ startPc = "returned"
  /\ IF mode = "rebuild" /\ ~stopping["new"]
       THEN /\ prompted' = [prompted EXCEPT !["new"] = TRUE]
            /\ promptAfterAck' = (promptAfterAck \/
                                   (stopPc = "acked" /\ stopDuringStart))
       ELSE UNCHANGED <<prompted, promptAfterAck>>
  /\ startPc' = "done"
  /\ UNCHANGED <<mode, proc, stopping, registered, current, existing, stopPc,
                 stopTarget, stopDuringStart, stopMarked>>

-----------------------------------------------------------------------------
(* thread/stop request (L4207-4219), intent "interrupt" -> stopSession,   *)
(* intent "release" -> releaseSession (L3119-3133). Both return at once   *)
(* for a session that is already stopping.                                *)

\* L4208 marks every in-flight start of the thread, then the handler looks
\* up the session.
\* Simplification: with an active prompt, stopSession sends session/cancel
\* and waits up to THREAD_STOP_CANCEL_TIMEOUT_MS before kill(). The model
\* starts the kill at once; no property here depends on that wait.
StopArrive ==
  /\ stopPc = "notSent"
  /\ stopDuringStart' = (startPc \notin ({"notSent"} \cup StartDone))
  /\ stopMarked' = (stopMarked \/ StartPending)
  /\ LET s == current IN
     IF s = None \/ stopping[s]
       THEN /\ stopPc' = "acked"
            /\ UNCHANGED <<stopping, proc, stopTarget>>
       ELSE /\ stopping' = [stopping EXCEPT ![s] = TRUE]
            /\ proc' = [proc EXCEPT ![s] = "killing"]
            /\ stopTarget' = s
            /\ stopPc' = "killing"
  /\ UNCHANGED <<mode, registered, current, prompted, startPc, existing,
                 promptAfterAck>>

\* kill resolves; removeSession; the handler answers { ok: true } (L4217).
StopKilled ==
  /\ stopPc = "killing"
  /\ proc[stopTarget] = "dead"
  /\ current' = IF current = stopTarget THEN None ELSE current
  /\ stopPc' = "acked"
  /\ UNCHANGED <<mode, proc, stopping, registered, prompted, startPc, existing,
                 stopTarget, stopDuringStart, promptAfterAck, stopMarked>>

-----------------------------------------------------------------------------
(* Environment *)

\* The agent process tree exits after kill (managed.stop, grace 1 s).
KillComplete(c) ==
  /\ proc[c] = "killing"
  /\ proc' = [proc EXCEPT ![c] = "dead"]
  /\ UNCHANGED <<mode, stopping, registered, current, prompted, startPc,
                 existing, stopPc, stopTarget, stopDuringStart, promptAfterAck,
                 stopMarked>>

AtRest ==
  /\ startPc \in StartDone
  /\ stopPc \in {"notSent", "acked"}
  /\ \A c \in Conns : proc[c] # "killing"

Next ==
  \/ StartArrive \/ StartExistingKilled \/ StartSpawn
  \/ StartConstruct \/ StartFinish
  \/ StopArrive \/ StopKilled
  \/ \E c \in Conns : KillComplete(c)
  \/ (AtRest /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties *)

\* After thread/stop answers { ok: true }, no agent session of this thread
\* can run turns, when the stop arrived while a start was still in flight.
StopWins ==
  (stopPc = "acked" /\ stopDuringStart) => \A c \in Conns : ~Live(c)

\* No session/prompt reaches an agent after thread/stop answered { ok: true }.
NoPromptAfterStop == ~promptAfterAck

\* Once every request has finished, each agent process that is still running
\* is the thread's registered session. Anything else is an orphan process.
NoOrphanAtRest ==
  AtRest => \A c \in Conns :
              proc[c] = "running" => (current = c /\ registered[c])

TypeOK ==
  /\ mode \in {"rebuild", "fresh"}
  /\ proc \in [Conns -> {"none", "running", "killing", "dead"}]
  /\ stopping \in [Conns -> BOOLEAN]
  /\ registered \in [Conns -> BOOLEAN]
  /\ current \in Conns \cup {None}
  /\ prompted \in [Conns -> BOOLEAN]
  /\ stopPc \in {"notSent", "killing", "acked"}
  /\ stopMarked \in BOOLEAN
=============================================================================
