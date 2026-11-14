---
name: handoff
description: Enforce HANDOFF.md updates across sessions, compact bloated handoffs into 3-layer memory with handoffbackups/, and cross-check critical historical facts in backups. Use when the user invokes /keepstate:handoff (or /handoff), asks to initialize HANDOFF.md, inspect handoff status, run compaction, or verify critical details against handoffbackups/.
---

# Keepstate (`/keepstate:handoff`)

Zero-daemon auto-handoff enforcement and 3-layer threshold compaction for **Claude Code** and **Antigravity**.

## Locating the CLI

Find `scripts/cli.mjs` relative to the installed plugin root:
1. If `$CLAUDE_PLUGIN_ROOT` is set: `node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs"`
2. If `$PLUGIN_ROOT` is set: `node "$PLUGIN_ROOT/scripts/cli.mjs"`
3. Otherwise resolve `../../scripts/cli.mjs` relative to this `SKILL.md` file.

## Workflows (`/keepstate:handoff` / `/handoff`)

### 1. Initialize (`init`)
When a project does not yet have `HANDOFF.md` (or `docs/HANDOFF.md`):
1. Run:
   `node "<plugin-root>/scripts/cli.mjs" init --cwd "<project-root>"`
   (or `--target docs/HANDOFF.md` if the user prefers keeping it under `docs/`).
2. Read the repo's `AGENTS.md`, `CLAUDE.md`, `README.md`, `package.json` / `pyproject.toml`, and `git log -n 10 --oneline`.
3. Replace the placeholder bullet inside `## КРИТИЧНЫЕ ИНВАРИАНТЫ` with real, durable project constraints:
   - Forbidden commands / dangerous operations (e.g. prod DB rules, service restart procedures)
   - Required test / lint / build commands and environments
   - Critical architecture invariants, auth/security boundaries, and irreversible quirks
4. Remind the user that `handoffbackups/` is intentionally NOT gitignored so historical backups stay tracked with the repository.

### 2. Check Status (`status`)
Run:
`node "<plugin-root>/scripts/cli.mjs" status --cwd "<project-root>"`

Report: current `HANDOFF.md` byte size vs `thresholdBytes` (`36864` bytes / ~36 KB by default), whether compaction is due, backup count, and latest backup filename. Check `~/.keepstate/compact.log` (or `$KEEPSTATE_STATE_DIR/compact.log`) if investigating background compaction runs.

### 3. Manual / Forced Compaction (`compact`)
Run:
`node "<plugin-root>/scripts/cli.mjs" compact --cwd "<project-root>" --platform <claude|antigravity> --force`

Defaults:
- Claude Code backend: `claude-haiku-5-5` with `--effort xhigh`
- Antigravity backend: `gemini-4-hydrogen-medium`

How the 3-layer pyramid works:
1. **Top (`## КРИТИЧНЫЕ ИНВАРИАНТЫ`)** — never touched, preserved verbatim across every compaction.
2. **Middle (`## Вехи и ключевые решения`)** — rolling memory capped at `18` bullets (`maxMilestones`). Merges old session history + previous milestones, retaining architectural rationale, non-obvious bug root causes, and DB/API/deploy constraints while dropping obsolete tactical churn so the file stays compact even after a year+.
3. **Bottom (`## YYYY-MM-DD — ...`)** — appends chronologically; preserves at least `2` recent top-level `##` session sections verbatim and pulls in up to `6` trailing sections while staying within `14336` bytes (`maxRecentBytes`), so short updates never wipe out larger same-day sessions.
4. **Backup + Footer Notice** — saves the full uncompacted original to `handoffbackups/handoff_backup_YYYY-MM-DD_HH-MM-SS.md` and appends an `<!-- keepstate:backup-notice -->` block instructing agents to double-check ONLY critically important facts in `handoffbackups/`.

When updating `HANDOFF.md` at the end of a coding session:
- Keep critical long-lived rules updated in `## КРИТИЧНЫЕ ИНВАРИАНТЫ` (never duplicate routine logs there).
- Append a new top-level `## YYYY-MM-DD HH:MM — <short title>` section at the bottom (above the `<!-- keepstate:backup-notice -->` block, or let compaction re-anchor the notice).

### 4. Verify Critical Info in Backups (`verify`)
Before making risky changes involving auth, migrations, infra/deploys, credentials, ports, rollback commands, or subtle historical bugs whose exact details are missing from compacted `HANDOFF.md`:
- Search `handoffbackups/` (`rg -n` / `grep`) from newest `handoff_backup_*.md` to oldest for the specific symbol, command, host, or subsystem.
- Read ONLY the matching block and cross-check only **critically important** details — never bulk-read old backups for routine tasks.

### 5. Per-Project Config (`.keepstate.json`)
Optional `.keepstate.json` at project root (or `~/.keepstate/config.json` globally) overrides defaults:
- `enabled` (bool, default `true`)
- `thresholdBytes` (int, default `36864`)
- `keepRecentSessions` (int, default `2` — minimum recent sections to keep)
- `maxRecentSessions` (int, default `6` — cap when packing extra recent sections under `maxRecentBytes`)
- `maxRecentBytes` (int, default `14336`)
- `maxMilestones` (int, default `18`)
- `handoffPath` (string or `null`, default checks `HANDOFF.md` then `docs/HANDOFF.md`)
- `backupsDirName` (string, default `"handoffbackups"`)
- `suggestMissingHandoff` (bool, default `true`)
- `autoCompactOnStop` (bool, default `true`)
- `platformBackendMap` / `backends` — map platforms or add `custom-cli` compactors (e.g. `codex`, `gemini`, custom scripts with `{promptFile}` and `{model}` placeholders).
