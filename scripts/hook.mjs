import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStateDir, loadConfig } from './lib/config.mjs';
import {
  findHandoffFile,
  findProjectRoot,
  getBackupsDir,
  getCommittedChangesSince,
  getGitHead,
  getRecentCommits,
  getWorkingTreeChanges,
  hashString,
  isGitRepo,
  isIgnoredArtifact,
} from './lib/handoff.mjs';
import { isLockActive } from './lib/lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPACT_SCRIPT = path.join(HERE, 'compact.mjs');

function parseArgs(argv) {
  const opts = { platform: 'claude', event: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platform' && argv[i + 1]) opts.platform = argv[++i];
    else if (argv[i] === '--event' && argv[i + 1]) opts.event = argv[++i];
  }
  return opts;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function sessionSnapshotPath(projectRoot, sessionId) {
  const key = crypto
    .createHash('sha1')
    .update(`${projectRoot.toLowerCase()}::${sessionId}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(getStateDir(), 'sessions', `${key}.json`);
}

function writeSessionSnapshot(projectRoot, sessionId, data) {
  try {
    const file = sessionSnapshotPath(projectRoot, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  } catch {
    // Non-fatal
  }
}

function readSessionSnapshot(projectRoot, sessionId) {
  try {
    const file = sessionSnapshotPath(projectRoot, sessionId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function suggestedStorePath() {
  return path.join(getStateDir(), 'suggested.json');
}

function wasSuggested(projectRoot) {
  try {
    const store = JSON.parse(fs.readFileSync(suggestedStorePath(), 'utf8'));
    return Boolean(store[projectRoot.toLowerCase()]);
  } catch {
    return false;
  }
}

function markSuggested(projectRoot) {
  try {
    const p = suggestedStorePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let store = {};
    if (fs.existsSync(p)) {
      try {
        store = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        store = {};
      }
    }
    store[projectRoot.toLowerCase()] = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

function emitSessionStart(platform, text) {
  if (!text) {
    process.stdout.write('{}\n');
    return;
  }
  if (platform === 'antigravity') {
    process.stdout.write(
      `${JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] })}\n`
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`
  );
}

function blockStop(platform, reason) {
  if (platform === 'antigravity') {
    process.stdout.write(`${JSON.stringify({ decision: 'continue', reason })}\n`);
    process.exit(0);
  }
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function allowStop(platform) {
  if (platform === 'antigravity') {
    process.stdout.write('{}\n');
  }
  process.exit(0);
}

function spawnBackgroundCompact(projectRoot, platform) {
  try {
    const child = spawn(
      process.execPath,
      [COMPACT_SCRIPT, '--cwd', projectRoot, '--platform', platform],
      {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, KEEPSTATE_COMPACTING: '1' },
      }
    );
    child.unref();
  } catch {
    // Never break user session stop if background spawn fails
  }
}

function handleSessionStart(platform, payload, projectRoot, config) {
  const sessionId = payload.session_id || payload.conversationId || 'default';
  const handoffPath = findHandoffFile(projectRoot, config);
  const headSha = isGitRepo(projectRoot) ? getGitHead(projectRoot) : null;

  if (!handoffPath) {
    writeSessionSnapshot(projectRoot, sessionId, {
      headSha,
      handoffRel: null,
      handoffMtimeMs: 0,
      handoffHash: '',
    });
    emitSessionStart(platform, '');
    return;
  }

  const stat = fs.statSync(handoffPath);
  const raw = fs.readFileSync(handoffPath, 'utf8');
  const handoffRel = path.relative(projectRoot, handoffPath).replace(/\\/g, '/');

  writeSessionSnapshot(projectRoot, sessionId, {
    headSha,
    handoffRel,
    handoffMtimeMs: stat.mtimeMs,
    handoffHash: hashString(raw),
  });

  const maxInjectChars = 36000;
  const body =
    raw.length > maxInjectChars
      ? `${raw.slice(0, 14000)}\n\n... [keepstate: файл слишком большой (${raw.length} символов), скоро сработает авто-сжатие; при необходимости читай остаток напрямую] ...\n\n${raw.slice(-14000)}`
      : raw;

  const commits = isGitRepo(projectRoot) ? getRecentCommits(projectRoot, 5) : '';
  const blocks = [`=== keepstate: ${handoffRel} ===\n${body}`];
  if (commits) blocks.push(`=== Последние коммиты ===\n${commits}`);

  emitSessionStart(platform, blocks.join('\n\n'));
}

function handleStop(platform, payload, projectRoot, config) {
  if (payload.terminationReason && payload.terminationReason !== 'NO_TOOL_CALL') {
    allowStop(platform);
  }
  if (!isGitRepo(projectRoot)) {
    allowStop(platform);
  }

  const sessionId = payload.session_id || payload.conversationId || 'default';
  const snapshot = readSessionSnapshot(projectRoot, sessionId);
  const handoffPath = findHandoffFile(projectRoot, config);
  const isRetry = Boolean(payload.stop_hook_active || payload.continuationActive);

  // Trigger background compaction whenever HANDOFF exceeds threshold (even on Stop retry!)
  if (handoffPath && config.autoCompactOnStop) {
    const stat = fs.statSync(handoffPath);
    const lockPath = path.join(path.dirname(handoffPath), '.keepstate.lock');
    if (stat.size > config.thresholdBytes && !isLockActive(lockPath, config.lockTtlMs)) {
      spawnBackgroundCompact(projectRoot, platform);
    }
  }

  if (isRetry) {
    allowStop(platform);
  }

  const workingChanges = getWorkingTreeChanges(projectRoot);
  const committedChanges = getCommittedChangesSince(projectRoot, snapshot?.headSha);
  const allChanges = Array.from(new Set([...workingChanges, ...committedChanges]));

  if (!handoffPath) {
    const anyCodeChange = allChanges.some((f) => !isIgnoredArtifact(f, config.backupsDirName));
    if (anyCodeChange && config.suggestMissingHandoff && !wasSuggested(projectRoot)) {
      markSuggested(projectRoot);
      blockStop(
        platform,
        'KEEPSTATE INFO: В этом проекте ещё нет HANDOFF.md. В конце своего ответа коротко (1-2 предложения) предложи пользователю завести HANDOFF.md через `/keepstate init` (объяснив, что он сохраняет важные запреты и прогресс между чатами с авто-сжатием и бекапами). Ничего не создавай без его ответа.'
      );
    }
    allowStop(platform);
  }

  const handoffRel = path.relative(projectRoot, handoffPath).replace(/\\/g, '/');
  const backupsRel = path.relative(projectRoot, getBackupsDir(handoffPath, config)).replace(/\\/g, '/');

  const codeChanged = allChanges.some(
    (f) => f !== handoffRel && !isIgnoredArtifact(f, backupsRel)
  );
  if (!codeChanged) {
    allowStop(platform);
  }

  const currentRaw = fs.readFileSync(handoffPath, 'utf8');
  const currentStat = fs.statSync(handoffPath);
  const handoffUpdated =
    allChanges.includes(handoffRel) ||
    (snapshot &&
      snapshot.handoffHash &&
      (hashString(currentRaw) !== snapshot.handoffHash ||
        currentStat.mtimeMs > snapshot.handoffMtimeMs + 100));

  if (!handoffUpdated) {
    blockStop(
      platform,
      `KEEPSTATE STOP BLOCK: Ты изменил файлы проекта, но не обновил \`${handoffRel}\`. ` +
        `Добавь короткий раздел с текущей датой (что сделано, какие файлы изменены, чем проверено, что осталось / следующий шаг) в \`${handoffRel}\` ` +
        `ПЕРЕД блоком \`<!-- keepstate:backup-notice:start -->\` (верхний блок \`## КРИТИЧНЫЕ ИНВАРИАНТЫ\` не трогай), и только потом завершай ответ.`
    );
  }

  allowStop(platform);
}

function main() {
  if (process.env.KEEPSTATE_COMPACTING === '1') {
    process.exit(0);
  }

  const opts = parseArgs(process.argv.slice(2));
  const rawInput = readStdin();
  let payload = {};
  try {
    payload = rawInput.trim() ? JSON.parse(rawInput) : {};
  } catch {
    payload = {};
  }

  const cwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd();
  const projectRoot = findProjectRoot(cwd);
  const config = loadConfig(projectRoot);

  if (!config.enabled) {
    if (opts.platform === 'antigravity') process.stdout.write('{}\n');
    process.exit(0);
  }

  if (opts.event === 'session-start') {
    handleSessionStart(opts.platform, payload, projectRoot, config);
  } else if (opts.event === 'stop') {
    handleStop(opts.platform, payload, projectRoot, config);
  } else {
    process.exit(0);
  }
}

try {
  main();
} catch {
  // Never crash the host agent loop on unexpected hook error
  process.exit(0);
}
