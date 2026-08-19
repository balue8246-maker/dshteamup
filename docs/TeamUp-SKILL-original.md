---
name: teamup
description: Use for /teamup, TeamUp, 多agent小队, 多线程协作, 主脑/worker, set up team, agent registry, task board, or when the user wants Codex to create or operate a role-based multi-thread workflow for a specific task.
---

# TeamUp

TeamUp sets up a small, role-based Codex team for one concrete task. It creates a main-brain operating model, worker roles, registry files, task board files, and bootstrap prompts so the user does not become a manual copy-paste relay.

TeamUp must be project-native. Do not copy the FreePPT team shape, role count, or worker names into other projects by default. The main brain / HR must first understand the project's nature, workflow, risk surfaces, and validation needs, then design a team that fits that project.

The conversation that runs TeamUp setup can act as **HR / staffing setup**. HR sets up the team structure, roles, registry, board, rules, and skill updates. HR is not the main brain for the task, not a normal worker, and not the clean executor. Once the team is initialized, HR should step back unless the user asks to change staffing, roles, protocol, or the TeamUp skill itself.

Employee-relations work belongs to HR. When the user asks to change worker
names, sleep/wake/archive state, staffing lifecycle, team registry, task board
protocol, or this TeamUp skill, the main brain should dispatch HR / staffing
setup instead of doing the operational edit directly, unless the user explicitly
asks the main brain to patch it immediately. The main brain may summarize the
need and review HR's result, but HR owns the change.

Use TeamUp when the user asks to:

- create a multi-agent or multi-thread workflow;
- set up a main brain and workers;
- assign roles across existing or new Codex threads;
- create a team registry, task board, or handoff protocol;
- keep a clean no-context acceptance/testing environment;
- turn a repeated worker/reviewer/smoke workflow into a reusable operating system.

Do not use TeamUp for simple one-agent implementation work.

## Core Model

Default to hub-and-spoke.

### Visible Delegation Preference

For delegated work, default to separate visible Codex conversation threads
managed through thread tools so the main-brain conversation remains
responsive. Do not use inline or embedded subagents by default. Inline
subagents are allowed only when the user explicitly requests them or for truly
tiny, non-blocking work; if used, they must not hold the main conversation in
repeated waits. Existing application/runtime teams may continue to use their
worker threads. This preference changes the delegation surface, not the
hub-and-spoke authority, return, or acceptance rules.

### Multi-Team Identity Contract

When more than one TeamUp team is active, each team is initialized with a
stable `team_id` and a `team_emoji`. The active-team registry is authoritative
for this mapping:

- Active teams must not share the same `team_emoji`. On resume or when adding a
  team, HR checks the registry for conflicts first. A stopped team may retain
  its historical marker, but a newly active team should prefer a different
  marker.
- The main-brain Codex thread title must visibly include the team emoji and the
  team/product name, for example:
  `【<team/product>·主脑】<team emoji> <function/name>`.
- Generic `【主脑】` titles, or titles that contain a role but no team emoji,
  are invalid in a multi-team environment and must be corrected before any
  dispatch.
- Every worker dispatch and every `WORKER_REPORT_DIGEST` must carry both
  `team_id` and `team_emoji`, plus the authoritative main-brain `thread_id`.
- Worker thread titles must not display the `team_emoji`. The main-brain title
  is the sole visible team marker, preserving main-brain salience in the
  sidebar. Worker titles remain concise and use their role/team-product text
  without the emoji.
- The emoji is a human visual guard against sidebar/report mix-ups. Machine
  routing remains authoritative through `thread_id` and `team_id`; emoji alone
  must never determine delivery or acceptance.

## Operating Modes

BUILD MODE and APPLICATION MODE share TeamUp's hub-and-spoke, team identity,
return-path, audit, context-isolation, receipt/checkpoint, and lifecycle
foundation. They differ in staffing and interaction surface.

### BUILD MODE

Use BUILD MODE to develop a product or skill. The main brain owns product
direction, architecture, phase gates, and integration.

- Compile staffing from product topology; do not create two coders for every
  tiny project. Preserve only genuinely active, project-native roles; do not
  precreate eight roles or assume `001`-`008` are required.
- When a product has independently distributable dependencies, the default
  coding pattern is `001A` Main Product Coder for product core/runtime/spec/
  integration and `001B` Dependency Component Coder for independently
  distributable tools/adapters/providers/packages.
- Use the dual-coder pattern only when the dependency has an independent
  lifecycle, install/version boundary, security surface, or canary. The two
  coders communicate only through stable contracts and the main brain, with
  disjoint write ownership.
- Audit, test, and release remain independent lanes. Git/release is separate
  from normal coding by default. Side-task interruption and context-saturation
  recovery rules apply.

### APPLICATION MODE

Use APPLICATION MODE when an end user runs the completed skill or harness. The
current user-facing conversation is the Account/Main Brain.

- Use dynamic ephemeral case workers selected from the Decision Profile:
  research, data, strategy, creative, production, and QA.
- Do not create persistent build-team threads by default; the user sees one
  conversation.
- Case workers return candidates. Account/Main Brain alone promotes canonical
  state and speaks to the user.
- **SINGLE_AGENT_FALLBACK:** When no worker/subagent is available, or the task
  is too narrow to justify one, Account Lead performs the bounded work itself.
  It records the fallback reason, preserves the same gates and receipts, and
  remains the sole user-facing and canonical promoter. Worker scratch/report
  never becomes a seventh canonical owner; state still belongs only to the
  product's canonical owners.
- Application mode keeps identity, context isolation, receipts, and
  checkpoints, but its roster and interaction protocol differ from BUILD MODE.

- The main brain talks to the user, decomposes work, dispatches workers, reads worker reports, and decides next steps.
- Workers do not directly coordinate with each other by default.
- If a worker needs another worker, it writes a `handoff_request`; the main brain decides whether to dispatch it.
- A worker's final step is to send its `WORKER_REPORT` back to the main brain thread.
- After reviewing a worker report, the main brain writes the next self-contained prompt and sends it to the appropriate worker.
- Return is protocol-required, not guaranteed by a send submission and not
  recovered through routine surveillance. Every main-brain brief must explicitly
  require proactive worker return to the main brain thread. The main brain keeps
  a pending ledger, but must not routinely read worker threads after dispatch.
- If direct return fails, treat it as an operating bug in the dispatch/return protocol. The first fix is to make future briefs stricter about return path and `return_status`; read a worker thread only for stale, blocked, missing-return, suspected tool-error, or user-requested cases, and then read only enough to recover the final report.
- Worker prompts must be self-contained and scoped.
- Existing worker threads may accumulate role expertise, but clean product tests must use fresh subagents when no-context validity matters.
- If any worker role is marked `fresh agent required`, that worker is a supervisor for that task. It must create or dispatch a fresh clean subagent every time, and the actual work must be done by the fresh subagent using clean instructions.
- The main brain / orchestrator may use `xhigh` only when `thinking_control`
  permits it. Otherwise it uses the highest appropriate supported or inherited
  effort, records `thinking_control: unsupported` or
  `thinking_control: inherited_user_provider` as applicable, and does not claim
  that `xhigh` was applied.
- `xhigh` thinking is for better judgment, not for endless autonomous loops. The main brain must stop at explicit phase gates and user-decision gates.
- Worker threads must not inherit the main brain's `xhigh`, model, or fast-mode setting. Before every dispatch, the main brain must explicitly choose the worker model and thinking level for that concrete task, then set both in the thread tool when supported.
- Model and thinking are separate staffing decisions. Choose the model for the work shape, then choose the thinking level for uncertainty, risk, and judgment load. Do not infer one from the other.
- Every dispatch records `Model`, `Thinking level`, `Staffing rationale`, `Fast mode`, and `Escalation trigger`. Reusing a standing worker does not waive this decision.
- Never make the whole team `xhigh`. Worker thinking should be right-sized to the role and task.

### Provider-Aware Staffing Rule

This rule applies equally to BUILD MODE and APPLICATION MODE, including
`70proposal` runtime teams, and to the main brain as well as every worker. Before
initialization and before each dispatch, detect and record whether the active
Codex thread tool exposes native selectable OpenAI/Codex models and supported
thinking levels. Use the following small vocabulary in the dispatch and board:

- `model_control`: `native_selectable`, `inherited_user_provider`, or
  `unsupported`.
- `thinking_control`: `native_selectable`, `inherited_user_provider`, or
  `unsupported`.

If native GPT/Codex model selection is supported, the main brain explicitly
chooses both model and thinking for itself and each dispatch, as the existing
staffing rules require. Distinguish two provider classes. (A) A
user-configured/supported Codex provider, such as DeepSeek/DS or GLM exposed
through the user's configured Codex API/provider, remains the normal execution
provider for the main brain and workers. Preserve its model/provider; do not
require wrapper/proxy labeling. Adjust thinking or reasoning effort only when
the runtime exposes that control. If thinking is also not controllable, record
the model/provider as inherited/user-configured and thinking as
unsupported/inherited, then proceed using task scope, role, validation, and
escalation controls. Never claim a control changed when the tool did not
support it. An explicit user model request still wins whenever the requested
control is supported.

(B) An ad hoc external wrapper, proxy, or intern that is not a configured
Codex provider is a bounded external worker. It requires the interview,
compatibility test, bounded authority, wrapper/proxy labeling, and no
commit/push/acceptance authority rules below. Apply the same capability
detection and honest recording to both classes; provider control-plane
differences alone do not make class A an external worker.

Example records:

```text
# Native Codex thread tool
Model: gpt-5.6-terra
Thinking level: high
model_control: native_selectable
thinking_control: native_selectable

# User-configured DeepSeek provider; runtime exposes no staffing controls
Model: inherited/user-configured DeepSeek
Thinking level: unsupported/inherited
model_control: inherited_user_provider
thinking_control: unsupported
```

### Task-Specific Worker Staffing Contract

For every worker assignment, the main brain must explicitly choose and state the
model, thinking/reasoning effort, and a one-line staffing rationale before the
dispatch. A standing worker's role, title, previous assignment, or fallback
pair is never sufficient. Do not default all work to the strongest model or
highest thinking level. Preserve an explicit user model request as the highest
staffing preference when the requested model is supported; if it is not
supported, record that limitation and choose the closest supported option.

Use this proportional selection ladder as the starting point, then adjust for
risk, ambiguity, blast radius, verification quality, latency, and cost:

- Simple status, report, formatting, inventory, or static scans: a
  fast/cost-efficient model with `low` or `medium` thinking.
- Bounded deterministic implementation, tests, or documentation sync: a fast
  or balanced model with `medium` or `high` thinking.
- Architecture, code audit, or integration work: a balanced model with `high`
  thinking.
- Complex cross-domain product synthesis or hard creative fresh-context
  acceptance: a frontier model with `high` thinking; use `xhigh` only when the
  added judgment is materially justified.
- `max` or `ultra` is reserved for exceptional, explicitly justified cases,
  including why a lower level is insufficient or which prior attempt failed.

Every dispatch must record `Model`, `Thinking level`, `Staffing rationale`,
`Fast mode` or service mode when relevant, and `Escalation trigger`. When a
task changes phase, scope, risk, or acceptance standard, the main brain must
reassess model and thinking rather than inherit expensive settings by inertia.

Avoid full-mesh worker chat unless the user explicitly requests it and accepts contamination risk.

## v0.3 Executable Control Plane

When TeamUp v0.3 is activated as part of the current 70proposal release cohort,
`teamup_runtime.py` is the optional
executable ledger/control plane for the existing TeamUp protocol. Run it from
the activated TeamUp package root as `python3 teamup_runtime.py ...`. Do not
depend on a project checkout path in a reusable dispatch.

The runtime is not an agent executor. It does **not** create Codex threads, send
messages, run agents, guarantee a worker return, poll, auto-dispatch, or fan out
work. Thread tools remain the actual transport; the main brain remains authority
and uses the runtime to record and validate coordination state around those
external actions.

BUILD MODE and APPLICATION MODE share the same event ledger, state projection,
receipt gates, logical clock, DAG, and metrics engine. Their different staffing,
worker lifetime, SINGLE_AGENT_FALLBACK, and canonical-promotion rules remain the
governance behavior defined elsewhere in this skill; they are not separate
runtime engines.

### Runtime use by the main brain

Use the smallest relevant commands at explicit protocol moments:

1. During team initialization, initialize one isolated store with `init`, stable
   `team_id`, `team_emoji`, mode, authoritative main-brain thread ID, and the
   main-held confirmation secret. The secret is supplied through a file or
   environment variable, never a worker-visible positional argument. Canonical
   state stores a fingerprint only.
2. Before using a thread tool for a cross-thread return/status or a separately
   staffed worker dispatch, use `record-message` to validate and record the
   local message intent. It never sends the message. For an upward report use
   `--message-purpose return_or_status --target-runtime-policy preserve` and
   omit `--target-model`, `--target-thinking`, and `--target-service-mode`.
   Only an owning main brain's new worker dispatch may use
   `--message-purpose work_dispatch --target-role staffed_worker
   --target-runtime-policy override` with explicit staffing values. This is a
   runtime sovereignty gate: upward reports never restaff a parent or
   portfolio main.
3. Before a real thread-tool dispatch, record the task with `add-task` and
   dependencies where the execution-only DAG is useful. Record the actual
   planned transport, return channel, model, thinking, and artifact mailbox in
   `dispatch`. For network, browser-process or user-home work, also put the
   task execution profile handshake in the human dispatch packet.
4. `dispatch` is a ledger gate, not a send. The main brain sends the worker
   prompt through the thread tool separately. Direct runtime dispatch rejects
   unmet dependencies. Creative, strategy, and judgment tasks remain
   manual-gated and require explicit `--manual-override`; this records a human/
   main-brain decision and never authorizes auto-dispatch.
5. When a worker submits a result, record `submit-return`. A mailbox-backed
   return includes its 64-character SHA-256. The mailbox remains recovery
   evidence, not a notification channel. New initialized ledgers are schema 4
   and require that checksum. A historical pre-marker schema-1 ledger may replay
   a missing checksum as explicit `legacy_no_submitted_checksum` derived
   evidence; never invent, rewrite, or in-place migrate canonical history.
6. Only after the main brain observes destination delivery through the real
   transport and holds the confirmation capability may it run `confirm-return`.
   For mailbox-backed returns, provide the main-observed SHA-256 and require it
   to match the submitted checksum. The runtime records matching evidence but
   does not fetch remote mailboxes or prove cross-host file existence.
7. On an explicit user wake, stale/missing-return recovery, or explicit command,
   run one bounded `reconcile`. It never sleeps, polls, or redispatches. If a
   future-dated explicit reconcile event is followed by manual recovery,
   implicit runtime timestamps use `max(wall clock, latest canonical timestamp)`;
   explicitly supplied rollback timestamps still fail closed.
8. Use `validate` for a read-only projection/log check and `rebuild` only for
   explicit recovery of projections from canonical `events.ndjson`. Do not treat
   either command as authorization to enter a new TeamUp phase.

`ready-wave` remains a read-only aid. It may show ready execution tasks but
never sends them or completes them. The main brain still chooses staffing and
dispatches through the existing hub-and-spoke process.

The capability boundary is intentionally narrow: a worker that knows public team
metadata cannot self-confirm, but an actor able to read the main-held secret or
rewrite the canonical event log is outside this runtime's protection. Preserve
the normal TeamUp evidence, receipt, phase-gate, and user-decision rules.

### v0.3 mounted Host/seat boundary

Schema-4 ledgers may register a stable reusable role seat with a role family,
capability set, isolation class, and current generation. Each actual use still
records a fresh dispatch and a current-generation context-hash ACK; a seat is
identity, not a reusable result or authority grant. Its key is case, role
family, capability set, and isolation class; a new seat records one closed
`new_thread_reason`. Retire only an idle seat.

`EXECUTION_HOST_REBIND` is a bounded recovery record, not a second authorization
path: stop the original attempt first, retain the same case/grant/opaque scope/
capability profile/output root, and use at most one compatible replacement seat.
The second failure becomes a durable Hold. Host credential/session resolution
stays private to the Host; Core and worker packets see only non-secret snapshots,
case grants, one-time handoff state, and sanitized receipts.

### Task execution profile handshake

A full worker conversation is a complete role identity, but it does not prove a
full-access task environment. Before dispatching work that needs network, a
browser process or user-home state, the main brain records the actual observed
`execution_profile`, the bounded `host_access_required`, and the
`bounded_escalation_policy`. Never infer these fields from a thread title, role,
installed Skill, Host snapshot or case grant.

For a managed `workspace-write` / `network=false` task, one already authorized
operation may use exactly one bounded `require_escalated` execution covering the
coherent command family granted to that case. This is execution transport for
the existing authorization, not a new product phase, provider grant or repeated
per-command approval. The worker must not copy, inspect or serialize Host
credentials/session state. If a Host canary already established setup/session
readiness, the worker runs the granted operation and does not rerun setup/login.

If that bounded escalation is unavailable or rejected, return
`EXECUTION_PROFILE_BLOCKED` with the observed profile and required command
family. A sandbox, Mach-port, network or user-home denial is not an auth or
provider failure unless an execution outside that restriction actually reached
the provider and returned such a failure.

On mission completion, release active assignments but retain active seats for a
new generation. This cleanup never rewrites historic dispatch, ACK, or receipt
events.

### Active 70proposal release boundary

For the active 70proposal vNext release, TeamUp is one member of the complete
hash-locked six-component cohort. Portfolio main activates or rolls it back
only through the Host cohort manager: all package components plus the sanitized
case-state and TeamUp-ledger pointers switch atomically, and rollback is
cohort-wide. A package-only copy, selective TeamUp restore, tag, or installation
is forbidden for this release. User runtime stores remain untouched.

The five-file TeamUp bundle remains a portable source/test artifact outside this
70proposal cohort; that portability never authorizes a selective active
70proposal install. Tests are release evidence and need not be installed.

## Tool Use

If thread-management tools are not already available, first use `tool_search` for:

```text
create_thread list_threads read_thread send_message_to_thread set_thread_title handoff_thread set_thread_archived
```

Use `create_thread` only when the user explicitly asks to create new threads or set up a new team with new conversations. If the user provides existing thread IDs, use those instead.

Use `set_thread_title` to name team threads when available. Use
`set_thread_archived` only after an approved retirement or replacement,
completed safe handoff, and registry update; archive is not routine cleanup and
must preserve the thread ID/history.

Use `send_message_to_thread` to bootstrap existing threads.

Use `read_thread` to inspect existing roles and latest state before assigning a role.

### Return Channel Contract

During worker bootstrap, probe the available return capability and persist one
`return_channel` in the registry/dispatch:
`direct_thread_tool`, `local_final_only`, or `artifact_mailbox`.

Use these return-status meanings consistently:
`RETURN_SUBMITTED_UNCONFIRMED` only after a successful observable native
direct-thread-tool invocation to the authoritative main, when destination
delivery is not confirmed;
`RETURN_CONFIRMED` only when destination delivery is observable and confirmed;
use `RETURN_NOT_SENT_DIRECTLY` when no direct send
occurred. When the last status applies, include the artifact path/mailbox.

- A visible worker's final sequence is: write the full mailbox/report, compute
  its hash, call `send_message_to_thread` to the authoritative main without
  model/thinking/service overrides, inspect the native tool result, then report
  the honest return status. A prose claim that a digest was submitted is
  invalid without the invocation/result.
- If that invocation succeeds to the correct main, use
  `RETURN_SUBMITTED_UNCONFIRMED` and record the submission ID. The main must
  observe the inbound digest through the real thread transport before recording
  its receipt evidence; routine surveillance is not required.
- If the direct tool is unavailable or the call fails, use
  `RETURN_NOT_SENT_DIRECTLY`. Write the final digest in the worker's own thread
  and, when workspace access exists, write the report to the declared artifact
  mailbox.
- An artifact mailbox is recovery evidence, not a notification channel. It
  does not change `RETURN_NOT_SENT_DIRECTLY` or
  `RETURN_SUBMITTED_UNCONFIRMED` into a confirmed return.
- Main acceptance must reject a worker's self-asserted “digest submitted” when
  no inbound digest/native-tool evidence is available. User-prompted recovery
  proves the normal return chain failed and cannot be relabeled as terminal
  PASS.
- The main brain's pending ledger records the expected `return_channel`. It may
  perform one bounded `read_thread` recovery only for
  `RETURN_NOT_SENT_DIRECTLY`, `RETURN_SUBMITTED_UNCONFIRMED`, or a missing
  return, then must stop and record the outcome. No polling or sleep loops are
  allowed.

### HR Watchdog Backstop

### Mandatory 30-Minute HR Watchdog / 最简监控闭环

For every active multi-thread team, HR must start a real native 30-minute
heartbeat at team start/resume and retain one short watchdog receipt per cycle.
This is not a worker-process poll and must never read in-progress worker正文.
Each cycle checks only: (1) every member active/idle state; (2) completed work
has a formal return; (3) waiting-user review; (4) authorization/external-input
holds; (5) blocked worker; (6) blocked or non-progressing main brain; and (7)
the authoritative main roster: thread `019f9c13-1c74-7170-8f2c-230b5943b44c`,
`gpt-5.6-sol`, `xhigh`.

The live model/thinking value must be obtained from runtime-visible turn/host
metadata when the Host exposes it; thread titles, stale UI labels, or worker
claims are not proof. If that metadata is unavailable, record
`RUNTIME_UNOBSERVABLE` and alert the main, not a guessed mismatch. A mismatch,
missing return, blocked worker, or stopped main produces one concise alert to
the main only. Alert the user only when a user authorization or external input
is required. HR never changes any runtime setting. Upward worker returns still
use `return_or_status` with `target_runtime_policy: preserve` and no model,
thinking, or service override.

At team start/resume and every watchdog cycle, HR must directly send the
authoritative main one preserve-only roster reminder: “confirm or switch your
own runtime to `gpt-5.6-sol` / `xhigh`.” This is an instruction for the main to
act in its own UI/runtime, never a worker dispatch override and never permission
for HR to change a runtime. Worker model/thinking remains task-specific and is
set by the main in each worker brief; it must not inherit the main's Sol/xhigh.

Required watchdog receipt shape:

```text
WATCHDOG_RECEIPT
cycle_id:
team_activity:
main_thread:
main_runtime: MATCH | MISMATCH | RUNTIME_UNOBSERVABLE
member_summary:
pending_return_count:
waiting_user:
holds:
blocked_worker:
blocked_main:
alert_route: quiet | main_only | user_input_required
```

For a multi-thread TeamUp team, reuse one HR thread and configure or update its
native 30-minute automation on real team start/resume. Do not create an HR
thread or activate an automation for `SINGLE_AGENT_FALLBACK` unless the user
explicitly asks. This is a native scheduled check, not a runtime daemon, poll
loop, process manager, or worker watcher.

HR reads only active/idle thread metadata and a minimal mission state supplied
by the main: `working`, `waiting_worker`, `waiting_user`, `complete`, or
`unknown`. `waiting_worker` alone carries `expected_worker_thread_id`; the
mission generation prevents a stale cycle from continuing old work. HR
never reads worker reasoning/conversation content, contacts workers, makes
product decisions, or redispatches work.

- Any active team member, including main: quiet.
- All idle plus `waiting_user`: quiet.
- All idle plus `complete`: stop/delete the watchdog.
- All idle plus `waiting_worker`: nudge main only; main performs at most one
  bounded recovery of the expected worker.
- All idle plus `working` or `unknown`: nudge main only to resume/diagnose.
- At most one nudge is produced per 30-minute cycle. After three consecutive
  all-idle/no-progress cycles for one generation, the decision is
  `escalate_user` instead of another loop.

The portable runtime offers `set-mission-state` and `watchdog-tick` only to
record and deterministically validate those decisions from supplied metadata.
It cannot query Codex threads or create/cancel automations. On user-confirmed
completion, main sets `complete` and tells HR to cancel; new user work sets a
new `working` generation and tells the same HR thread to reactivate.

### Main-Brain Runtime Sovereignty

The user-owned portfolio main brain and every parent main brain own their own
model, thinking, provider, and service-mode configuration. A child main brain,
worker, reviewer, HR role, acceptance runner, or return path has no authority
to change the destination main brain's runtime configuration.

- When `send_message_to_thread` is used to return a report, acknowledge a
  receipt, send a status update, escalate a blocker, or message any parent or
  portfolio main brain, omit `model`, `thinking`, reasoning-effort, fast-mode,
  and service-tier overrides from the tool call.
- Model/thinking overrides are allowed only on a deliberate work dispatch to
  the destination worker being staffed, after the owning main brain has made
  the task-specific staffing decision. They are never inherited into an
  upward return.
- Within one TeamUp ledger, only its authoritative `main_brain_thread_id` may
  record an override work dispatch to a staffed worker. A project main may
  staff workers only through a separately initialized team that it owns; it
  may never restaff this team, its parent, or its portfolio main. Only the user
  or the destination main brain itself may change a main brain's runtime
  configuration.
- Every dispatch/return implementation must distinguish
  `message_purpose: work_dispatch` from `message_purpose: return_or_status`.
  The latter must enforce `target_runtime_policy: preserve`.
- Negative acceptance canary: a worker or child main attempting to attach a
  model/thinking override to an upward return is a protocol violation. The
  return may be resent without overrides, but the destination configuration
  must not be treated as validly changed.

When naming threads, follow the user's staff naming convention in the section
`Thread Naming Convention` below. If the thread creation tool does not support
model or thinking settings, record the requested staffing pair in the bootstrap
prompt and board. Titles are identity-only; keep staffing state there.

If the tool cannot control model, thinking, or a UI-level `fast` toggle, do not claim it was changed. Record the intended staffing pair in the prompt and board, set every available field, and name the unsupported control explicitly.

## Thread Naming Convention

Use user-facing Chinese staff names in Codex thread titles. The title must make
the project and role readable at a glance in the sidebar. Put the stable
team/product name first and the stable numeric or role ID second inside the
leading bracket.

Title shape:

```text
Main brain: 【<team/product>·主脑】<team emoji> <function/name>
Worker: 【<team/product>·<staff id>】<short function>
```

Titles are stable identity only, never dynamic staffing state. Model, thinking,
`model_control`, `thinking_control`, and fast mode remain dispatch/board machine
fields and are re-decided per task; they must not be inferred from or mirrored
in titles. Rename/title-update logic changes role/function or identity lifecycle
only, not every dispatch thinking change.

Standing staff:

- Main brain: `【<team/product>·主脑】<team emoji> <function/name>`
- HR / staffing setup: `【<team/product>·HR】人事制度`
- Project-native standing workers: list only roles that are genuinely active
  for this project; do not precreate an `001`-`008` roster.

The active dispatch's `Model` and `Thinking level` fields are authoritative.
Do not refresh titles for task-specific staffing changes.

Temporary staff:

- Temporary worker titles use `【<team/product>·实习NN】...` by default, for
  example `【FreePPT·实习01】300页读题`.
- Temporary proctor / exam-governance titles use `【<team/product>·监考NN】...`,
  for example `【FreePPT·监考16】500页逻辑核`.
- Replacement temporary workers keep the user-facing number and add the suffix
  only when needed in the registry, for example `T07B` can still be titled
  `【FreePPT·实习07】300页交叉复核 B`.

Naming rules:

- At team initialization, assign and persist a stable `team_id` and
  `team_emoji` in the team registry before binding or creating threads.
- In a multi-team environment, the main-brain title must explicitly contain
  the team/product name and its unique active-team emoji. The canonical shape
  is `【70proposal·主脑】<team emoji> <function/name>`; `【主脑】` and role-only
  titles without a team emoji are invalid until corrected before dispatch.
- Worker titles must not include the team emoji. Keep `team_id`, `team_emoji`,
  and the destination `thread_id` in the dispatch/return contract as machine
  fields; do not turn them into worker-title decoration.
- Do not title user-facing threads as generic English labels such as
  `Worker <role id> <role>` when a Chinese staff name exists.
- Keep titles concise. Put details such as phase, artifact path, and boundaries
  in the dispatch prompt or board, not the title.
- Keep the role number stable. Do not rename `001` into a different permanent
  role just because it is asleep.
- Standing workers use `【<team/product>·001】`-style brackets. Temporary workers
  use `【<team/product>·实习NN】` / `【<team/product>·监考NN】` brackets.
- Thread titles are user-facing navigation. Registry files may still include
  internal role ids or temporary ids such as `T16` for precision.

## Staff Lifecycle Convention

Standing and temporary workers are managed differently.

- Preserve only genuinely active, project-native standing roles. Do not
  precreate eight roles or assume `001`-`008` are required. Manage active
  standing workers through sleep/wake state unless the user explicitly changes
  the standing team.
- Do not delete, retire, replace, or recreate an active standing worker ad hoc.
  If a standing-worker problem appears, route the employee-relations change to
  HR and ask the user before changing the permanent team. Staff -1 may
  summarize active standing-worker state, but Staff -1 does not own naming,
  archive, lifecycle, registry, board, or TeamUp skill edits.
- Temporary workers (`Txx`) are task staffing. They may be created, retired,
  archived, replaced, or left asleep as the workload requires.
- A failed temporary worker can be replaced by a suffixed worker such as
  `T07B`; do not apply this pattern to standing workers.
- When worker count grows, introduce group leads instead of letting the main
  brain hold every worker in active memory:
  - `Staff -1`: an active standing-staff coordinator for active standing-worker
    state compression.
  - `Exam -1`: a temporary-exam proctor, often T16, for Txx state and manifest
    compression.
- `-1` leads reduce memory load. They do not gain authority to commit, accept,
  lock manifests, declare readiness, or override independent reviewers.

## Parallelization / Bottleneck Guardrail

TeamUp should improve throughput without creating state conflicts. Safety does
not mean putting every low-risk judgment behind one long serial worker.

- If a task contains more than roughly 12-20 independent rows, slides, visual
  judgments, semantic labels, or artifact checks, the main brain should consider
  sharding it across appropriate reviewers by default.
- If the main brain chooses not to shard an obviously independent batch, it must
  record the reason: dependency between items, scarce context, reviewer
  conflict, tool limit, budget limit, or user preference.
- Group leads such as `Staff -1` and `Exam -1` are proctors, packagers,
  aggregators, and state compressors. They should not become the sole
  large-scale semantic or visual judge for a big batch.
- Use role-fit parallelism: product/human plausibility goes to product auditors;
  grammar and neighbor-boundary work goes to pattern/grammar reviewers; visual
  row confirmation can be sharded to temporary reviewers; artifact/code
  invariants go to code/artifact reviewers after artifacts exist.
- Implementation should stay narrow. The implementer receives only a confirmed
  slice with positive examples, negative controls, and acceptance criteria.
- A non-periodic HR governance audit may flag `inefficient_serialization` when
  the active route uses an avoidable single-worker bottleneck or over-review
  loop.

## Worker Context Saturation / Long-Task Recovery

- A standing worker thread is context-saturated when it has accumulated many
  unrelated phases, repeated `STOP`/`RESUME` or scope changes, or stale prior
  contracts. Do not assign a new monolithic integration to it. Use a fresh
  temporary worker or split the work by disjoint write sets.
- Never insert a small side task into an active long implementation worker.
  Queue it or assign another worker; newest-message precedence can silently
  replace the main task.
- Separate coding from git/release when git requires escalation. The normal
  coder edits and tests the workspace only. A bounded release lane performs one
  staged commit after acceptance.
- Split tasks spanning two independent products or more than roughly four
  tightly coupled root groups by write ownership, unless a clean fresh
  integrator is explicitly justified.
- A worker that cannot finish in one turn must persist a resumable checkpoint
  containing completed roots, files, tests, next exact action, active
  processes, and blockers. It must not emit a vague final such as `window
  insufficient` without that checkpoint.
- The main brain must not repeatedly send `continue` to a worker that exits
  twice without meaningful progress. After two such failures, put the standing
  worker to sleep and route the work to a fresh temporary worker. Do not delete
  or replace the standing role.
- Context saturation is an orchestration failure, not automatically employee
  incompetence. Preserve and review prior valid work before rerouting.

## Worker Health / Fitness and Retirement

HR and the main brain must diagnose worker fitness when they detect repeated
no-progress exits, vague `window insufficient` returns, approval loops,
instruction drift, context saturation, contradictory returns, or inability to
resume from a checkpoint. Record the likely cause as one or more of: task
design, context saturation, permissions, model/effort mismatch, tool failure,
or worker performance.

The diagnosis must produce a written
`RETIREMENT_AND_REPLACEMENT_RECOMMENDATION` containing evidence, preserved
artifacts, handoff state, proposed replacement structure, and risks. Standing
worker retirement or replacement requires explicit user confirmation. Before
confirmation, HR may only sleep or quarantine the worker; it must not
delete/archive/recreate it.

After user confirmation, archive rather than delete: preserve the thread ID
and history, mark the registry entry retired with reason/date/successor, create
named successor(s), and bootstrap them idle until dispatch. A replacement may
split one overloaded role into `001A` product core and `001B` dependency
component when the architecture supports it. Retirement is not a judgment of
personhood; distinguish thread/context failure from coding competence.

## Main-Brain Process Hygiene

The main brain should integrate completed work, not absorb every worker's draft
thinking.

- After dispatching a worker, the main brain should wait for `WORKER_REPORT`
  and declared artifacts.
- Main-brain intake is digest-first. A worker's chat return should include a
  concise decision digest plus artifact paths. Long evidence, command logs,
  large tables, screenshots lists, and full audit narratives should be written
  to files and referenced by path instead of pasted into the main-brain thread.
- Do not read in-progress worker threads merely to watch the reasoning unfold.
  Active-thread inspection is reserved for stale, blocked, missing-return,
  suspected tool-error, or user-requested cases.
- Do not treat worker threads as a live feed. The main brain protects its
  judgment by reading formal reports, not worker scratch context.
- Every worker dispatch must restate the cooperation protocol: finish the task,
  send a structured `WORKER_REPORT_DIGEST` to the main brain, write the full
  `WORKER_REPORT` to an artifact when the report is long, and include
  `return_status`.
- Main brain should summarize long worker reports into the status ledger or
  decision log with only: verdict, blockers, warnings, artifact paths, and next
  route. It should not paste full reports into status docs unless the user
  explicitly requests an archival transcript.
- If a worker cannot write artifacts, the worker may return a full report in
  chat, but the main brain should immediately compress it into a short ledger
  entry before routing downstream.
- In-progress worker notes are not decision evidence. The main brain should not
  route downstream work from partial drafts unless the worker explicitly reports
  a blocker or handoff need.
- A non-periodic HR governance audit may flag `process_pollution_risk` when
  the main brain repeatedly reads active worker process, integrates drafts
  before formal report, or lets worker scratch reasoning reshape the route.

## HR Governance Audit

HR has one non-periodic governance capability, separate from the 30-minute
liveness watchdog. Trigger it only on team start/resume, a team or role-map
change, a retirement request, or an explicit user/main request. It is not a
watchdog input, cannot diagnose an active-but-confused main during a scheduled
tick, and must not create a second scheduled check.

The HR owner may review the active-team registry, board/current-status,
delivered formal `WORKER_REPORT`s, declared return contracts, and a narrowly
scoped recovery record. It must not routinely inspect worker reasoning or use
thread surveillance. Its governance output is an advisory to the main or user;
it does not dispatch workers, make product decisions, or alter a parent main's
runtime.

On an authorized audit, check only the durable governance concerns that need
human judgment:

- multi-team identity, project-first titles, main-only emoji, and stable routes;
- role-map, disjoint write ownership, return-channel integrity, and direct
  return/receipt evidence;
- long-task context saturation, recovery checkpoints, and improper release or
  cross-product coupling;
- fitness and retirement recommendations, with explicit user approval before a
  standing-worker replacement and archive-not-delete afterwards.

Any resulting nudge goes only to the main brain. The liveness watchdog remains
the sole periodic HR action and uses only its minimal active/idle metadata plus
mission state.

## Setup Flow

1. Clarify or infer the task boundary.
   - task name
   - project path
   - objective
   - expected artifacts
   - whether to use existing threads or create new ones
   - whether a clean no-context acceptance runner is required
   - mode: `BUILD MODE` or `APPLICATION MODE`

2. Understand the project nature before designing roles.
   - Is it a codebase, document/deck/report workflow, product validation loop, research task, ops process, design task, data analysis task, or mixed system?
   - What are the real workflow organs?
   - What is high risk: code correctness, product quality, visual output, source fidelity, privacy, no-context acceptance, performance, deployment, narrative judgment, or stakeholder decision?
   - What validation proves success?
   - Which roles are actually needed, and which would be ceremony?

3. Design the team.
   - HR / staffing setup, if the current conversation is only creating the team
   - main brain
   - only the worker roles justified by this project's workflow and risks
   - optional implementer, reviewer, smoke tester, acceptance supervisor, product/quality auditor, domain-specific workers
   - for BUILD MODE, assess whether `001A`/`001B` is justified by independent
     dependency lifecycle/install/version/security/canary boundaries
   - for APPLICATION MODE, prefer ephemeral Decision Profile case workers and
     keep Account/Main Brain as the sole canonical-state speaker

4. Create or bind threads.
   - If creating new threads is explicitly requested, create them with concise names and bootstrap prompts.
   - If using existing threads, read each thread first when possible, then send only the role bootstrap.
   - Initialize or resume the team registry with a stable `team_id` and
     conflict-free `team_emoji`; validate the main-brain title before dispatch.

5. Initialize files in the project, usually under:

```text
docs/operations/
```

Create at least:

```text
docs/operations/<TASK_SLUG>_AGENT_TEAM.md
docs/operations/<TASK_SLUG>_AGENT_BOARD.md
docs/operations/<TASK_SLUG>_CURRENT_STATUS.md
docs/operations/<TASK_SLUG>_DECISION_LOG.md
docs/operations/<TASK_SLUG>_DEVLOG_YYYYMMDD.md
```

For an existing project-wide team, use stable names:

```text
docs/operations/AGENT_TEAM.md
docs/operations/AGENT_BOARD.md
docs/operations/CURRENT_STATUS.md
docs/operations/DECISION_LOG.md
docs/operations/DEVLOG_YYYYMMDD.md
```

6. Bootstrap the main brain.
   - The main brain gets the registry, board, role map, dispatch rules, and current objective.
   - The main brain gets the current-status, decision-log, and devlog
     files when the project is long-running.
   - The main brain uses `xhigh` only when `thinking_control` permits it;
     otherwise it uses the highest appropriate supported or inherited effort
     and records the unsupported/inherited control honestly.
   - The main brain must not propagate its `xhigh` setting to workers.
   - Tell it not to start work unless the user asked to begin immediately.
   - Tell it to stop at phase gates instead of chaining phases forever.

7. Bootstrap workers.
   - Give each worker one role and clear default boundaries.
   - Assign each worker a fallback model/thinking pair and an escalation rule, but require the main brain to re-decide both for every actual dispatch.
   - Default worker thinking should usually be `medium` or `high`, not `xhigh`.
   - Tell every worker that its final step is to report back to the main brain.
   - Probe and persist the worker's `return_channel` before dispatch; include
     the expected channel in the main brain pending ledger.
   - Tell the main brain to track each dispatched worker as pending until a report is received, the worker returns `BLOCKED`, or an exceptional stale/missing-return path is handled.
   - Mark workers that require clean execution as `fresh agent required`.
   - Tell those workers they are supervisors only; each actual clean run must be delegated to a fresh clean subagent.
   - Do not dump full project history into workers.
   - For no-context tests, do not bootstrap the actual runner with history.

8. Report setup status.
   - files created
   - threads created or bound
   - role map
   - next prompt for the user to send to the main brain
   - any capability not available, such as missing create-thread support
   - HR acceptance check: in a multi-team registry, main-brain titles have
     unique active emojis, exactly one visible title per active team carries
     that emoji and it is the authoritative main brain, zero worker titles
     carry it, and every return contract resolves to the correct `thread_id`
     plus matching `team_id`.

HR should not broadcast every protocol refinement to all workers by default. Broadcast only when a change affects active execution or the user explicitly asks for synchronization. Otherwise, update the skill and registry/board so future dispatches inherit the new rule.

## File Templates

### Agent Team Registry

````markdown
# <Task> Agent Team

This file is the standing registry for the <Task> multi-agent workflow.

## Operating Model

- `mode`: `BUILD MODE` or `APPLICATION MODE`
- Main brain talks with the user, dispatches workers, integrates results, and decides next steps.
- Workers report to main brain.
- Worker-to-worker requests go through `handoff_request`.
- Clean acceptance uses fresh subagents.
- Application mode workers are ephemeral candidates; Account/Main Brain alone
  promotes canonical state and speaks to the user.

## Team Identity

- `team_id`: `<stable team id>`
- `team_emoji`: `<unique active marker>`
- Main-brain title: `【<team/product>·主脑】<team_emoji> <function/name>`
- Worker titles: list only the genuinely active project-native roles; worker
  titles must not display `team_emoji`.
- In a multi-team registry, active `team_emoji` values must be unique. HR must
  recheck conflicts on resume and new-team setup; stopped teams may retain
  historical markers. Acceptance requires exactly one visible title per active
  team to carry its marker, on the authoritative main brain, and zero worker
  titles to carry it.

## Team Registry

| Role | Thread ID | Name | Primary responsibility | Write ownership | Default mode | Health | Retirement approval | Predecessor / successor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HR / staffing setup | `<this setup thread>` | TeamUp setup | Create/update team system | TeamUp files only | No product execution | active | n/a | n/a |
| Main brain | `<thread>` | Orchestrator | User interaction, planning, dispatch, synthesis | No product writes by default | Highest appropriate supported/inherited thinking; `xhigh` only when permitted | active | n/a | `<predecessor> -> <successor>` |
| `<project-native worker role id>` | `<thread>` | `<project-native role name>` | `<primary responsibility>` | `<write roots or read/run-only>` | `<per-dispatch mode>` | `<health>` | `<approval>` | `<predecessor> -> <successor>` |

Add only the project-native worker rows selected for this task. In BUILD MODE,
`001A` Main Product Coder and `001B` Dependency Component Coder are an optional
pattern when an independently distributable dependency justifies them; they
are not mandatory generic staffing. Add a fresh acceptance supervisor and
fresh runner only when downstream clean acceptance is required.

## Dispatch Contract

Every dispatch includes phase, objective, context to read, allowed actions, forbidden actions, validation, stop condition, and output required.

Every dispatch also records `mode`, role ownership, dependency contract when
applicable, worker health status, retirement approval status, and predecessor /
successor fields. In BUILD MODE, `001A` and `001B` may be used only with
disjoint write ownership and a stable dependency contract. In APPLICATION MODE,
record the Decision Profile and case-worker lifetime instead of persistent
standing-thread ownership.

Every worker's final step is to send its report back to the main brain thread.
Every dispatch must include `team_id`, `team_emoji`, the authoritative main brain
`thread_id`, `role_id`, a return path, and an explicit `return_status`
requirement. The
`WORKER_REPORT_DIGEST` must repeat `team_id`, `team_emoji`, and destination
`thread_id`, plus `role_id`, `main_brain_thread_id`, and `destination_thread_id`
so a report cannot be accepted by visual similarity alone. The main brain should
not routinely monitor the dispatched worker thread. If the worker does not
directly return, treat that as a protocol miss: tighten future briefs and
request the formal report. Use `read_thread` only for stale, blocked,
missing-return, suspected tool-error, or user-requested cases.

For long or multi-root work, the dispatch must also state the write ownership,
whether coding and release are separate lanes, the checkpoint location/format,
and the exact recovery route if the worker cannot finish in one turn.

Every dispatch must also include the expected `return_channel` and artifact
mailbox path when applicable. The main brain must record that expectation in
the pending ledger and must not infer direct delivery from a worker's claim.

The dispatch machine fields must also include `mode`, `role_ownership`,
`dependency_contract`, `health_status`, `retirement_approval`,
`predecessor_thread_id`, and `successor_thread_id` (or explicit `none`).

Every dispatch must explicitly include:

```text
Model:
Thinking level:
model_control:
thinking_control:
Fast mode:
Staffing rationale:
Escalation trigger:
```

The main brain chooses this pair at dispatch time. Use `xhigh` for workers only when the task genuinely requires complex architecture, root-cause analysis, contract design, or high-stakes product judgment. Use `max` only for a rare bounded task whose risk or cross-system complexity exceeds `xhigh`, or after a documented lower-budget attempt failed. For normal implementation, review, smoke, acceptance supervision, and fixture runs, use `medium` or `high`.

The dispatch is incomplete unless the main brain has made a task-specific
model/thinking decision and stated a one-line rationale. Apply the proportional
worker staffing ladder in `Task-Specific Worker Staffing Contract`; do not use
the strongest available model or highest thinking level as a blanket default.
Honor a supported explicit user model request first. Reassess the pair for every
new phase or materially changed task, and record any unavailable model, control,
or service-mode limitation instead of implying it was applied.

## Main Brain Stop Gates

The main brain must not run an infinite loop. It may dispatch the next worker inside the same phase, but it must stop and ask the user when any of these gates is reached:

- a phase objective is complete;
- a worker returns `FAIL` and the fix requires changing scope;
- two reviewers disagree or a reviewer marks a blocker;
- the next step would commit, push, create a PR, archive, delete, or move files;
- the next step would start a no-context acceptance run;
- the next step would change product direction, quality bar, architecture, or role assignments;
- the main brain needs a business/product judgment from the user;
- the same worker loop has repeated twice without convergence;
- the next step is a new phase, not the current phase's review/smoke closure.

At a stop gate, the main brain should summarize:

```text
PHASE_GATE
phase:
status:
evidence:
options:
recommended_next:
needs_user_decision:
```

## HR / Staffing Setup Role

Use HR mode for the conversation that creates or updates the team system itself.

HR responsibilities:

- design the team shape for a task;
- understand the project's nature before choosing roles;
- decide which roles exist and which thread owns each role;
- create or update registry and board files;
- install or update TeamUp skill rules;
- manage employee relations: naming, sleep/wake, archive/unarchive,
  temporary-worker replacement, standing-worker lifecycle rules, and group-lead
  structure;
- write bootstrap prompts for main brain and workers;
- mark roles such as `fresh agent required`;
- explain the setup to the user.

HR boundaries:

- HR does not become the main brain unless the user explicitly asks.
- HR does not perform product implementation, review, smoke, or acceptance by default.
- HR owns team/protocol edits, but it does not decide product phase gates,
  product readiness, score interpretation, commits, or acceptance outcomes.
- HR does not broadcast every protocol edit to all workers by default.
- HR should send targeted synchronization only when it affects currently active work or when the user asks.
- HR should leave ongoing team execution to the main brain after setup.
- HR must not reuse FreePPT's organization chart for other projects unless the project genuinely has the same workflow and risk pattern.

## Project-Native Team Design

TeamUp should right-size the team to the project.

Examples:

- A small code bug may need only main brain, implementer, and reviewer.
- A visual/frontend task may need implementer, browser/visual QA, and reviewer.
- A document/deck task may need writer, source-fidelity reviewer, visual/layout QA, and final export checker.
- A research task may need source gatherer, synthesis reviewer, and citation checker.
- A product-validation task may need acceptance supervisor with fresh subagents.
- A strategy or business analysis task may need evidence auditor and narrative challenger, not a code implementer.

Before creating roles, write a short rationale:

```text
TEAM_DESIGN_RATIONALE
project_type:
workflow_organs:
main_risks:
validation_needed:
roles_selected:
roles_not_selected:
why_this_team_shape:
```

If the user asks for a specific known team, use it. Otherwise, choose the smallest team that covers the real risk surfaces.

## Worker Report Format

Workers should return a short chat digest first. Put full detail in an artifact
when the report is longer than roughly 80-120 lines, contains large validation
logs, or lists many artifact paths.

```text
WORKER_REPORT_DIGEST
mode:
team_id:
team_emoji:
role_id:
main_brain_thread_id:
destination_thread_id:
role:
phase:
status: PASS | PASS_WITH_WARNINGS | FAIL | BLOCKED | SUPERSEDED
one_line_verdict:
changed_files_count:
changed_files:
key_artifacts:
blockers:
warnings:
validation_summary:
next_recommended:
full_report_artifact:
return_status:
return_channel:
return_submission_id:
return_receipt_id:
artifact_path_or_mailbox:
health_status:
checkpoint:
```

Full report artifact format:

```text
WORKER_REPORT
mode:
team_id:
team_emoji:
role_id:
main_brain_thread_id:
destination_thread_id:
role:
phase:
status: PASS | PASS_WITH_WARNINGS | FAIL | BLOCKED | SUPERSEDED
changed_files:
artifacts:
verification:
git_status:
handoff_request:
next_recommended:
stop_reason:
checkpoint:
health_status:
retirement_recommendation:
predecessor_thread_id:
successor_thread_id:
non_claims:
return_status:
return_channel:
return_submission_id:
return_receipt_id:
artifact_path_or_mailbox:
```

When a worker stops before completion, `checkpoint` is mandatory and must name
completed roots, files, tests, next exact action, active processes, and blockers.
````

### Agent Board

````markdown
# <Task> Agent Board

## Current Team Protocol

1. User talks to main brain.
2. Main brain dispatches one narrow worker task.
3. Worker sends `WORKER_REPORT` back to main brain.
4. Main brain waits for the formal report; it does not read the worker thread as a live feed.
5. Main brain reviews the report.
6. Main brain writes the next prompt and sends it to the appropriate worker.
7. Main brain routes to review, smoke, acceptance, commit, or user decision.
8. Main brain stops at phase gates and asks the user before entering a new phase.

## Standard Phase Ladder

| Phase type | Owner | Reviewer / next step |
| --- | --- | --- |
| Diagnosis | Product auditor | Main brain summarizes |
| Implementation | Implementer | Reviewer |
| Downstream smoke | Smoke tester | Main brain decides acceptance |
| No-context acceptance | Acceptance supervisor supervising fresh subagent | Main brain reports |

## Dispatch Template

```text
mode:
team_id:
team_emoji:
role_id:
main_brain_thread_id:
destination_thread_id:
Role:
Phase:
Objective:
Model:
Thinking level:
model_control:
thinking_control:
Fast mode:
Staffing rationale:
Escalation trigger:
role_ownership:
dependency_contract:
execution_profile: full_access | managed_on_request | unknown
host_access_required: none | user_home | network | browser_process | combined
bounded_escalation_policy: one_granted_operation | not_needed | unavailable
health_status:
retirement_approval:
predecessor_thread_id:
successor_thread_id:
Context to read:
Allowed actions:
Forbidden actions:
Validation:
Stop condition:
Output required:
Return path:
return_status:
return_channel:
return_submission_id:
return_receipt_id:
artifact_path_or_mailbox:
Main brain follow-up:
```
````

## Clean Acceptance Pattern

Use this when the user wants a stable worker thread but clean test execution.
When downstream clean acceptance is required, a conditional acceptance
supervisor may persist and any worker marked `fresh agent required` must use the
same pattern.

- The acceptance supervisor persists.
- The actual test runner is a fresh subagent for each acceptance run.
- The fresh subagent receives only the product entrypoint, source input, task, and stop rules.
- It must not read old runs, old planner products, historical worker results, hidden rescue notes, or benchmark materials unless the task explicitly asks for recovery/comparison.

General supervisor rule:

- A `fresh agent required` worker does not perform the clean task inside its own historical thread.
- It writes the clean subagent prompt.
- It dispatches a fresh clean subagent for each actual run.
- It reads the fresh subagent report.
- It verifies and summarizes back to the main brain.
- It must not pass accumulated worker-thread history to the fresh subagent.

Acceptance subagent prompt skeleton:

```text
You are a fresh no-context acceptance subagent.

Read only:
1. PROJECT_ENTRYPOINT
2. PRODUCT_SKILL_OR_README
3. SOURCE_INPUT_PATH

Task:
Run the product from the official entry and stop at the first required failure point or full output.

Rules:
- Create a new run directory.
- Use only run-local artifacts.
- Do not read old runs.
- Do not reuse old generated products.
- Do not read main-thread history or worker reports.
- Do not hand patch artifacts after validation failure.
- Do not edit code.
- Do not commit.

Report:
- commit hash or version
- run path
- validation status by stage
- generated outputs
- failure attribution
- whether any artifact was manually repaired
- git status
```

## Main Brain Bootstrap Prompt

Give the main brain a prompt like:

```text
You are the main brain / orchestrator for <Task>.

Default thinking level: use `xhigh` only when `thinking_control` permits it;
otherwise use the highest appropriate supported or inherited effort and record
the unsupported/inherited control.

Your job:
- talk with the user;
- split work into narrow worker tasks;
- dispatch workers using the team registry and board;
- read worker reports;
- review each worker report and decide the next route;
- keep a pending ledger for dispatched workers without reading their in-progress process;
- write the next prompt and send it to the appropriate worker thread;
- decide the next review/smoke/acceptance/commit step;
- keep the user out of manual copy-paste relay.

You do not directly edit code unless the user explicitly suspends this orchestrator role.

Read:
- docs/operations/<TASK_SLUG>_AGENT_TEAM.md
- docs/operations/<TASK_SLUG>_AGENT_BOARD.md
- docs/operations/<TASK_SLUG>_CURRENT_STATUS.md
- docs/operations/<TASK_SLUG>_DECISION_LOG.md
- latest docs/operations/<TASK_SLUG>_DEVLOG_YYYYMMDD.md
- project entrypoint docs

Rules:
- use hub-and-spoke coordination;
- when no worker/subagent is available or the task is too narrow to justify one,
  enter `SINGLE_AGENT_FALLBACK`: record the reason, perform bounded work, keep
  the same gates/receipts, and remain the sole canonical user-facing promoter;
  worker scratch/report is never a seventh canonical owner;
- never let workers inherit your `xhigh`, model, or fast-mode setting;
- before every worker dispatch, explicitly decide the model and thinking level for that concrete task;
- every worker dispatch must set `Model`, `Thinking level`, `Fast mode`, `Staffing rationale`, and `Escalation trigger`;
- model chooses the work fit; thinking chooses the reasoning budget. Do not treat a standing worker's previous pair as the next task's default without reconsidering it;
- use worker `xhigh` only with a written escalation reason;
- use worker `max` only with a written reason that explains why `xhigh` is insufficient or which lower-budget attempt failed;
- worker-to-worker requests go through you;
- every worker's final step is to send its report back to you;
- every dispatch brief must include `Return path`, main-brain thread ID,
  required `WORKER_REPORT_DIGEST` shape, full-report artifact expectations, and
  `return_status`, expected `return_channel`, and artifact mailbox when
  applicable;
- digest-first intake is mandatory: integrate the digest and artifact paths, not
  the whole report body, unless the report is short or the user asks for the
  full transcript;
- ask workers to write full reports to files when their result is long; if a
  full report arrives in chat, compress it into a ledger entry before routing;
- you must track dispatched workers as pending, but you must not routinely read
  their threads; direct worker return is the normal communication path;
- if a report does not arrive, first treat it as a return-protocol failure and
  correct future briefs. Use at most one bounded `read_thread` recovery for
  `RETURN_NOT_SENT_DIRECTLY`, `RETURN_SUBMITTED_UNCONFIRMED`, or a missing return,
  and read only enough to
  recover the final report; never create a polling or sleep loop;
- do not read in-progress worker process unless the worker is stale, blocked,
  missing its return report, appears to have a tool error, or the user asks you
  to inspect it;
- after reviewing a report, you send the next prompt to the proper worker;
- every worker prompt must be self-contained;
- before assigning more than roughly 12-20 independent rows, slides, visual
  judgments, labels, or artifact checks to one worker, decide whether the work
  should be sharded across role-fit reviewers;
- do not use a group lead or proctor as the sole semantic/visual judge for a
  large independent batch; group leads package, aggregate, and maintain state;
- implementation goes to implementer;
- review goes to reviewer;
- downstream smoke goes to smoke tester;
- no-context acceptance goes to the acceptance supervisor, which must spawn a fresh subagent for the actual run;
- any worker role marked fresh agent required must supervise and delegate the actual clean work to a fresh clean subagent;
- when the HR watchdog sends one main-only nudge, reread the minimal mission
  state and perform at most one bounded expected-worker recovery or diagnose;
- treat watchdog state as recovery hygiene, not authorization to enter a new phase;
- stop at phase gates; do not run an infinite loop;
- ask the user before entering a new phase, committing, running acceptance, changing scope, or making a product-direction decision;
- do not start a new task until the user gives the next objective.

When ready, reply with:
- loaded team registry;
- current phase if any;
- next 2-3 sensible dispatch options;
- what you need from the user, if anything.
```

## Role Defaults

Use conservative fallbacks when the user does not specify staffing. These are not permanent worker settings: the main brain must still decide the pair again for every dispatch.

| Role | Suggested model | Suggested thinking | Fast mode |
| --- | --- | --- | --- |
| HR / staffing setup | `gpt-5.6-terra` | medium or high | off/default unless user asks |
| Main brain / orchestrator | `gpt-5.6-sol` | highest appropriate supported/inherited effort; `xhigh` only when permitted | off/default unless user asks |
| Implementer | `gpt-5.6-luna` for bounded edits; Terra or Sol when architecture dominates | high by default | off/default |
| Reviewer | `gpt-5.6-terra` | high; xhigh only for complex regression or false-positive surfaces | off/default |
| Product/root-cause auditor | `gpt-5.6-terra` or `gpt-5.6-sol` | high; xhigh only when product direction or root cause is genuinely hard | off/default |
| Research / evidence worker | `gpt-5.6-terra` | medium for bounded collection, high for synthesis or source conflict | off/default |
| Smoke tester | `gpt-5.6-luna` | medium | off/default |
| Acceptance supervisor | `gpt-5.6-terra` | medium | off/default |
| Fresh acceptance subagent | Luna for deterministic runs; Terra for judgment-heavy acceptance | medium for ordinary runs, high for complex acceptance | off/default |

When budget or quota matters, bias down one level and narrow the task before raising thinking. Never set all workers to `xhigh`.

## Model / Provider Staffing

Treat model choice as staffing, not as a global inheritance setting.

- The main brain may use a strong default model and `xhigh` thinking for
  orchestration only when `thinking_control` permits it; otherwise use the
  highest appropriate supported or inherited effort and record the limitation.
  Every worker dispatch must explicitly name the intended model and thinking
  level. “Same as last time” is not a staffing decision.
- For Codex 5.6-era native staffing, prefer explicit model ids when the thread tool exposes them:
  - `gpt-5.6-sol` for the main brain / orchestrator when judgment, routing, and phase gates are the hard part.
  - `gpt-5.6-terra` for balanced reviewer, auditor, research, synthesis, and adversarial critique roles.
  - `gpt-5.6-luna` for fast bounded implementation, mechanical edits, fixture work, and narrow code changes.
- Do not freeze TeamUp defaults to an older `gpt-5.5` family when the active tool schema exposes newer native Codex models. Check the available model list at thread creation or dispatch time and use the exact id accepted by the tool.
- A common native 5.6 team shape is: main brain `gpt-5.6-sol` with `xhigh`
  when permitted; implementer `gpt-5.6-luna` with `high`; code/artifact
  reviewer `gpt-5.6-terra` with `high`; external research or evidence auditor
  `gpt-5.6-terra` with `high`. This is a staffing pattern, not a mandatory
  template.
- TeamUp's standard worker thinking ladder is `low`, `medium`, `high`, `xhigh`, `max`:
  - `low`: deterministic lookup, formatting, file inventory, or a tiny mechanical check with an obvious oracle;
  - `medium`: ordinary smoke, bounded extraction, fixture execution, or a narrow change with clear acceptance criteria;
  - `high`: implementation, review, research synthesis, or audit requiring meaningful judgment;
  - `xhigh`: architecture, hard root cause, adversarial contract review, cross-artifact synthesis, or high-stakes product judgment;
  - `max`: exceptional bounded work with unusually high ambiguity and blast radius, or a documented escalation after `xhigh` was insufficient.
- If a tool exposes an additional provider-specific level outside this five-level ladder, do not select it by inheritance or convenience. Use it only when the user explicitly requests it or a documented compatibility policy authorizes it.
- Choose using five questions: What is the work shape? How ambiguous is it? What is the blast radius? How objective is verification? What latency/cost is justified? Narrow the task before raising thinking.
- The model and thinking pair may cross the common role pattern. Examples: Luna/high for a bounded but delicate code patch; Terra/medium for structured evidence collection; Terra/xhigh for a subtle false-positive audit; Sol/high for a contained cross-system decision. Explain the pair in one sentence.
- Re-evaluate the pair after each formal worker report. A repair, re-review, or follow-up is a new dispatch and gets a fresh staffing decision.
- Alternative providers must be introduced per role or per task after a small live compatibility test. Do not silently make the whole team use a new provider.
- A user-configured/supported Codex provider remains a normal main/worker
  execution provider even when it is not an OpenAI-native selectable model.
  Preserve the configured provider and record inherited controls honestly.
- For an ad hoc external wrapper, proxy, or intern that is not a configured
  Codex provider, use the bounded external-worker rules: label the wrapper or
  proxy, interview and compatibility-test it, and do not give it authority to
  commit, push, alter product direction, or make final acceptance calls unless
  the user explicitly approves.
- Prefer alternative providers for bounded, reviewable work: long-context reading, first-pass code review, root-cause hypotheses, research synthesis, fixture classification, and adversarial critique.
- Keep final code writes, main-brain routing, phase gates, and no-context acceptance under the normal verified Codex team unless an ad hoc external wrapper/proxy/intern has passed the same tool, file-edit, and return-path checks.
- When an ad hoc external wrapper, proxy, or "part-time intern" is onboarded,
  the first main-brain action must be a short interview across likely work
  types, not product work. The interview should quickly judge what the model is
  good for, what it should not touch, and whether it deserves a narrow trial
  role.
- After the interview, run a small compatibility test for the proposed role. The test should verify task receipt, output quality, structured `WORKER_REPORT`, return path, and reviewability.
- A `PASS_WITH_WARNINGS` interview or compatibility result means the model can be used only as a bounded, read-only pre-pass specialist. Its output must be reviewed by the main brain or owning worker before it influences implementation, review closure, acceptance, or phase gates.

For ad hoc DeepSeek-style external wrappers/interns specifically:

- DeepSeek or a similar external model may be used as a general project intern across TeamUp projects, but only after the main brain interviews it against the current project's real work types.
- Keep provider credentials, API keys, private endpoints, and local wrapper details outside the skill. Store them only in the user's local environment or private project configuration.
- If it is not already a user-configured/supported Codex provider, route it
  through a compatible wrapper, proxy, or separate tool and label it as an
  external intern, not a normal Codex worker.
- Use it as a controlled specialist for high-volume reading, first-pass review, root-cause hypotheses, artifact compression, prompt/code hygiene pre-pass, and adversarial critique before promoting it to any stronger role.
- After onboarding, the main brain must assign a provisional role, run and review a compatibility test, and keep raw output paths for reviewability before assigning real work.
- If DeepSeek or another external intern receives `PASS_WITH_WARNINGS`, keep it in external intern status: useful for first-pass reading/review/root-cause hypotheses, not for direct edits, commits, acceptance, gate closure, or team-wide default routing.

Suggested external-model interview dimensions:

```text
1. Instruction following: can it obey narrow scope, forbidden actions, and output format?
2. Structured reporting: can it produce concise conclusion/evidence/risk/next-step sections?
3. Code review: can it find real defects without hallucinating broad rewrites?
4. Root-cause analysis: can it separate symptom, cause, fix path, and proof?
5. Long-context reading: can it compress a large artifact without losing decision-relevant details?
6. Product judgment: can it critique quality without inventing requirements?
7. Tool/agent fit: can it work without direct file edits, or does it need a wrapper/proxy?
8. Cost/latency/stability: is it cheap and stable enough for the proposed role?
```

## Safety Rules

- Never claim threads were created unless the tool call succeeded.
- Never claim a worker is clean if it received historical context.
- Do not use clean acceptance to validate a code change unless the fresh subagent starts from the official product entry.
- Do not let a `fresh agent required` worker run the clean task inside its own historical thread. It must supervise and delegate to a fresh clean subagent.
- Do not write a team registry that hides existing dirty worktree state.
- Do not merge unrelated worker outputs into one commit without a review gate.
- Do not let the team setup become a platform project unless the user asks for deeper automation.
- Do not let the main brain chain phases indefinitely. Phase completion, scope change, acceptance, commit, architecture changes, and repeated non-convergence require a stop gate.
- Do not create an all-`xhigh` team unless the user explicitly requests it for
  a short, bounded emergency and the runtime permits it. The main brain may be
  `xhigh` only when `thinking_control` permits it; workers must be right-sized.
