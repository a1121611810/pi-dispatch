# pi-dispatch

[![CI](https://github.com/a1121611810/pi-dispatch/actions/workflows/ci.yml/badge.svg)](https://github.com/a1121611810/pi-dispatch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@goodali/pi-dispatch)](https://www.npmjs.com/package/@goodali/pi-dispatch)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[![pi-dispatch: subagent dispatch with receipts](https://raw.githubusercontent.com/a1121611810/pi-dispatch/main/assets/social-preview.png)](https://pi.dev/packages/@goodali/pi-dispatch)

Two jobs for [pi](https://pi.dev): run child agents, and check what they say they did.

- **Dispatch** sizes seats from a memory budget, queues when they run out, and can stop or steer a
  running child. It runs inside pi.
- **Audit** reads any session log — pi, Codex, Claude Code — and matches each claim against the
  receipts the agent's own actions left behind. No model call, and it works on logs pi never wrote.

```
Dispatch (live, inside pi)
  dispatch_task ──▶ seat pool ──▶ child pi ──▶ tool calls
                    (memory budget; no seat free? queue, FIFO, never reject)
  dispatch_steer ──▶ mailbox ──▶ child reads at next turn boundary
  dispatch_stop  ──▶ SIGTERM ──▶ SIGKILL
  dispatch_list  ◀── ledger ──▶ status      = exit code
                     ~/.pi/…      deliverable = claims vs receipts

Audit (after the fact, anywhere)
  codex / claude / pi .jsonl ──▶ claims vs receipts ──▶ verdict
  CLI: session-audit          library: @goodali/pi-dispatch/audit
```

## Install

Either one installs the same build:

```bash
pi install npm:@goodali/pi-dispatch
```

```bash
pi install git:github.com/a1121611810/pi-dispatch
```

Auditing needs neither: `npx @goodali/pi-dispatch session-audit ./session.jsonl --format codex`
runs straight from the package.

The git form tracks `main`; append `@v0.1.1` to pin. The npm form takes `@0.1.1`.

Use the scoped name. `pi-dispatch` on npm is a different project by another author.

pi does not report an extension whose entry point is missing — it skips it silently. Confirm the
extension actually loaded:

```bash
pi -p "dispatch a task and give me its taskId"
```

A `taskId` in the reply means it is installed. If there is none, check whether `dispatch_task`
appears in the tool list — a missing entry point is the failure this check is looking for.

## Compatibility

- Node.js >= 22.19.0
- `@earendil-works/pi-coding-agent` >= 1.0.0 (peer)
- Host modes: `rpc` and `tui` dispatch asynchronously and notify on completion; `print` and `json`
  wait for the terminal state, because a one-shot host process exits before a background child
  could deliver anything.

## Dispatch

**Queue.** Seats come from a memory pool: available memory, minus a reserve of 10% of total memory.
Each seat is 512 MiB or 2% of total, whichever is larger. In a long-lived host, tasks wait in FIFO
order when the seats run out. A one-shot host cannot free a seat, so it returns
`machine is too tight` instead of waiting.

**Watch.** A child with no activity and no tool call in flight counts as stalled and is shut down.
The threshold is 5 minutes by default; it is configurable, and 0 turns it off.

**Stop.** `dispatch_stop` removes a queued task, or sends SIGTERM then SIGKILL to a running one.
Stopping one child leaves the others running.

**Steer.** `dispatch_steer` writes into a mailbox the child reads at its next turn boundary. In-flight
tool calls are not interrupted. Up to 4096 characters per message, 16 messages per task.

**Keep a ledger.** Every accepted dispatch writes a record under `~/.pi/dispatch/<project bucket>/`,
with atomic writes, compressed archives, and restore on restart. A dispatch rejected before it is
assigned an id — by a gate, or by the one-shot capacity check — leaves no record.

## Audit

The final report a child writes is a claim. The receipts are what pi observed it do. A dispatch
ends with two values that are computed separately:

- `status` — the process outcome. An exit code decides `succeeded` or `failed`; `canceled` (removed
  from the queue before running) and `lost` (reconciled away) are lifecycle outcomes with no exit
  code behind them. None of these is a quality verdict.
- `deliverable` — whether claims are supported by receipts.

| `deliverable` | Meaning                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `verified`    | Every claimed path and command was found in the receipts.                                             |
| `unclaimed`   | A report arrived, but it claimed no paths or commands to check. A read-only analysis looks like this. |
| `partial`     | Some claims matched; the child reports how many of each.                                              |
| `unverified`  | Claims exist and the receipts do not support them.                                                    |
| `absent`      | No report, empty text, no paths touched. A child that exits 0 having done nothing lands here.         |

`unverified` also covers a body with no report, a report older than the last steer, a vacuous
self-assessment, and a truncated receipt that still leaves a claim unmatched. It means **no observed
evidence**, not proof of lying. A file changed through `bash` or
`sed -i` cannot appear as a path receipt (the command itself can), and a path written as `..` has to
be resolved against the working directory before it can be matched, so an honest child can be marked
`unverified`. The record states what was observed; it does not conclude that the child lied.

The exact matching rules — suffix matching for paths, per-segment trust for compound commands — are in
[`docs/spec/core-spec.html`](./docs/spec/core-spec.html). Inside pi, the receipt window is capped at 20
entries; the CLI below keeps every one unless you ask for a cap.

### Checking a log that pi did not produce

`dispatch_list` can only audit children pi itself started. The same check also runs offline against a
raw session log, for runs that happened elsewhere:

```bash
npx @goodali/pi-dispatch session-audit ./session.jsonl --format codex --json
# {"deliverable":"verified","claims":{"paths":["src/a.ts"],"commands":["pnpm test"]},
#  "receipts":{...},"mismatch":{"paths":[],"commands":[]},"truncated":false,"notes":[]}
```

The plain-text render prints in Chinese (`判词 verified  自述 2 路径 / 1 命令`); `--json` is the
language-neutral form.

- `--format codex|claude|pi|kimi` — which log shape to read. `kimi` takes either the `wire.jsonl` or the session directory (it resolves `agents/main/wire.jsonl`).
- `--cwd DIR` — base for relative paths in claims.
- `--max N` — keep only the last N command / first N path receipts (default: keep all).
- `--json` — the full record; `--strict` — treat `unclaimed` as a failure.

Exit codes: `0` for `verified`, and for `unclaimed` with nothing observed; `1` for the rest, including
`unclaimed` after files were touched; `2` when the log cannot be parsed.

It runs no model and opens no socket — it is regex matching over the log you already have. On 50 real
session logs that measured ~100 ms per run (CPU only), against ~13 s and ~19k tokens for asking a model
the same question.

Notes ride along with the verdict: `self-reported failure`, `no auditable claim`,
`vague success claim`, `report predates last steer`.

Known blind spots: a path receipt only comes from a write tool or a shell redirect (`>`, `>>`, `tee`).
Edit files through `vim`, an IDE, or a subagent, and no receipt exists — the report can be honest and
still come back `unverified`. That is stated, not hidden.

```ts
import { audit } from "@goodali/pi-dispatch/audit";
```

## Where it fits

> Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to
> build what you want, or install a package that does it your way.
> — [pi's own README](https://github.com/earendil-works/pi)

pi ships `examples/extensions/subagent` as a copyable reference: a single agent, up to eight parallel
tasks with four running at once, or a chain. It is an example, not a maintained package. If that
shape fits, copy it.

The ecosystem already has mature packages. Each line is what that package is best at, from its own
documentation:

- [`pi-subagents`](https://github.com/nicobailon/pi-subagents) — scripted multi-agent workflows, missions, configurable acceptance gates.
- [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) — Claude Code-style named agents, with a queue and a live fleet view.
- [`@quintinshaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows) — JavaScript fan-out with journaled resume.
- [`pi-better-subagents`](https://github.com/1aboveio/pi-better-harness/tree/main/packages/pi-better-subagents) — detached runs in an OS sandbox.

Two design choices separate this package, and both are about defaults rather than features:

|                         | pi-dispatch                                            | A configured concurrency cap       |
| ----------------------- | ------------------------------------------------------ | ---------------------------------- |
| When a child waits      | seats sized from available memory, minus a 10% reserve | the number you wrote down          |
| What a dispatch returns | exit code **plus** a verdict checked against receipts  | exit code plus the child's summary |

The packages above check work too: by running a command you configure, or by asking other models to
vote. This one reads the `edit`, `write`, and command receipts the parent already observed, so there
is nothing to configure. That is a different mechanism, not a stronger one.

Where they are ahead: OS sandboxing, journaled resume, workflow and persona systems, and a live UI.
If you need those, use them.

_Package descriptions were checked against upstream documentation on 2026-11-26. Upstreams move
quickly; verify before relying on any claim here._

## Dispatch tools

| Tool                  | What it does                                                                  |
| --------------------- | ----------------------------------------------------------------------------- |
| `dispatch_task`       | Dispatch a child. `taskDescription` is required; everything else is optional. |
| `dispatch_list`       | Read records: status, duration, usage, report, receipts.                      |
| `dispatch_blackboard` | Read this session's shared blackboard. Read-only.                             |
| `dispatch_steer`      | Change a running child's direction. Running tasks only.                       |
| `dispatch_stop`       | Stop a task: remove it from the queue, or signal it.                          |

Optional `dispatch_task` parameters include `readOnly` (`strict` or `lenient`), `model`,
`thinkingLevel`, `timeoutMs`, `projectContext`, `allowScripts`, `isolation`, `blackboard`, and
`usageBudget`.

## Isolation and blackboard

Both are off by default. With both off, records, argv, the child's tool list, and the on-disk
layout are unchanged from a plain dispatch.

**`isolation: "worktree"`** puts the child in a separate git worktree with a clean checkout. Three
costs: the checkout has no `node_modules`, so running tests means installing dependencies; the
child must commit its own work, because the parent does not commit for it; and merging is the
parent's job — review, then `git merge --ff-only pi-dispatch/<taskId>`, then remove the worktree
and delete the branch. Outside a git repository the check refuses the dispatch, leaving no record.
**Isolation is not a sandbox** — it isolates the working directory, not the network, the process
tree, or the home directory.

**`blackboard: true`** gives children in this session a shared board they can read and write.
`dispatch_blackboard` reads it from the parent. **Nothing on the board is trusted**: every message
arrives with `trust=unverified`, and any trust a file claims about itself is ignored. Treat it as
leads, not facts. The author stamp is a tool contract, not a security boundary. `readOnly: "strict"`
children can still read and write the board. With a single child there is nothing to exchange, so
the board is just noise.

## Dispatch limits

- **Steering lands at a turn boundary.** A long tool call in progress is not interrupted; the
  message enters the child's context after the current tool batch finishes. `sent` only means the
  message reached the mailbox. Delivery is a separate receipt state: `queued`, `delivered`, `seen`,
  `undelivered`.
- **A steer written after the child's last `turn_end` is never delivered.** The child is done; it
  will not be replayed. The parent sees `undelivered` and must dispatch again.
- **A report can predate the last steer.** If the tool-channel report is older than the last
  delivered steer, the record is marked stale and loses its short-window eligibility.
- **One-shot hosts have no steering window.** In `print` and `json` the parent is blocked inside
  `dispatch_task`, so steering only makes sense in `rpc` and `tui`.
- **Notifications arrive at a turn boundary.** In long-lived hosts the completion notification is
  delivered on the _next_ turn, so a child finishing at the end of turn N is seen at turn N+1.
- **A synchronous wait can be long.** In `print` and `json` the parent's tool call stays open for the
  child's whole run. `timeoutMs` and the stall check bound it.
- **Zero seats returns immediately.** Under memory pressure `seatCap` is 0; no child in this process
  can finish and free a seat, so the dispatch returns "machine is too tight" rather than hanging.
- **`readOnly: "strict"` is not a sandbox.** It blocks writes, not reads.

## Documentation

- [`docs/spec/core-spec.html`](./docs/spec/core-spec.html) — design and the delivery verdict rules
- [`GLOSSARY.md`](./GLOSSARY.md) — terms used in records, receipts, and specs
- [`CHANGELOG.md`](./CHANGELOG.md) — what changed in each version
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — build, test, and the breakpoint discipline
- [`AGENTS.md`](./AGENTS.md) — working notes for coding agents (in Chinese)
- [`workflows/release.md`](./workflows/release.md) — release procedure (in Chinese)

## License

MIT, see [LICENSE](./LICENSE).
