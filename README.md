# Keepstate

Zero-daemon auto-handoff enforcement and 3-layer threshold compaction for **Claude Code** and **Antigravity**.

Keepstate keeps long-lived project context in a version-controlled `HANDOFF.md` without background daemons, SQLite/vector databases, or external API keys—using your own CLI subscriptions for compaction.

## Why Keepstate

- **Automatic `HANDOFF.md` discipline**: On `SessionStart`, snapshots pre-existing dirty/untracked files so read-only sessions aren't falsely blocked; on `Stop`, if files actually changed during this session (working tree edits or new commits) without updating `HANDOFF.md` (or `docs/HANDOFF.md`), Keepstate pauses completion and tells the agent to record progress before exiting.
- **Session context injection**: On `SessionStart`, injects `HANDOFF.md` plus recent git commits directly into the session (with head + tail truncation notice if the file grows large before compaction finishes).
- **Zero-nag missing handoff prompt**: In git repositories without `HANDOFF.md`, suggests initializing one via `/keepstate:handoff init` (Claude Code) or `/handoff init` (Antigravity) at most **once per repo** (tracked in `~/.keepstate/suggested.json`).
- **Background compaction at ~36 KB**: When `HANDOFF.md` crosses `36864` bytes (`thresholdBytes`), `Stop` spawns a detached compactor protected by `.keepstate.lock`, content-hash concurrent-edit reconciliation, and `KEEPSTATE_COMPACTING=1` recursion prevention.
- **3-layer pyramid built for 1+ year projects**:
  1. **`## КРИТИЧНЫЕ ИНВАРИАНТЫ`** — preserved verbatim across every compaction.
  2. **`## Вехи и ключевые решения`** — rolling memory capped at `18` bullets (`maxMilestones`), merging architectural rationale, schema/deploy constraints, and non-obvious bug root causes while dropping tactical churn.
  3. **Recent sessions** — preserves at least `2` chronological `##` session sections verbatim and packs up to `6` recent sections within `14336` bytes (`maxRecentBytes`), preventing tiny status notes from evicting larger same-day deploys.
- **Full backups & mandatory double-check footer**: Before every compaction, the full original is saved next to `HANDOFF.md` in `handoffbackups/handoff_backup_YYYY-MM-DD_HH-MM-SS.md` (tracked in Git, not gitignored), and the compacted `HANDOFF.md` ends with a notice instructing future agents to double-check **critically important** details in `handoffbackups/`.

## Default Compactor Backends

| Platform | Default Backend | Model & Settings |
| :--- | :--- | :--- |
| **Claude Code** | `claude-cli` | `claude-haiku-5-5` with `--effort xhigh` |
| **Antigravity** | `agy-cli` | `gemini-4-hydrogen-medium` |

Custom backends (e.g. `codex`, `gemini`, or custom scripts) can be added via `type: "custom-cli"` using `{promptFile}` and `{model}` placeholders.

## Installation

### Claude Code

```bash
claude plugin marketplace add baklak1/keepstate
claude plugin install keepstate@baklak1-keepstate
```

### Antigravity

Clone this repository locally and install from the directory:

```bash
git clone https://github.com/baklak1/keepstate.git
agy plugin install ./keepstate
```

> **Requirement:** Node.js 18+ must be available on `PATH`.

## Usage (`/keepstate:handoff` & CLI)

Inside a session, invoke `/keepstate:handoff` (Claude Code) or `/handoff` (Antigravity) to initialize `HANDOFF.md`, inspect status, manually trigger compaction, or verify critical historical details against `handoffbackups/`.

You can also run the bundled CLI directly from the plugin root:

```bash
node scripts/cli.mjs init --cwd /path/to/repo [--target HANDOFF.md]
node scripts/cli.mjs status --cwd /path/to/repo
node scripts/cli.mjs compact --cwd /path/to/repo --platform claude --force
```

Write new session notes sequentially at the bottom of `HANDOFF.md` as top-level `## YYYY-MM-DD HH:MM — Short title` sections (above the `<!-- keepstate:backup-notice:start -->` footer block) so the compactor peels older sessions cleanly while keeping your latest work verbatim.

## Configuration (`.keepstate.json`)

Override defaults per repository via `.keepstate.json` or globally via `~/.keepstate/config.json`:

```json
{
  "enabled": true,
  "thresholdBytes": 36864,
  "keepRecentSessions": 2,
  "maxRecentSessions": 6,
  "maxRecentBytes": 14336,
  "maxMilestones": 18,
  "handoffPath": null,
  "handoffCandidates": ["HANDOFF.md", "docs/HANDOFF.md"],
  "backupsDirName": "handoffbackups",
  "suggestMissingHandoff": true,
  "autoCompactOnStop": true,
  "compactTimeoutMs": 180000,
  "platformBackendMap": {
    "claude": "claude",
    "antigravity": "antigravity"
  },
  "backends": {
    "claude": {
      "type": "claude-cli",
      "command": "claude",
      "model": "claude-haiku-5-5",
      "effort": "xhigh"
    },
    "antigravity": {
      "type": "agy-cli",
      "command": "agy",
      "model": "gemini-4-hydrogen-medium"
    }
  }
}
```

Check `~/.keepstate/compact.log` for background compaction logs and outcomes.

## License

MIT
