import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compactProject } from '../scripts/compact.mjs';
import {
  assembleCompactedHandoff,
  buildBackupFilename,
  createUniqueBackupPath,
  parseHandoff,
  stripBackupNotice,
} from '../scripts/lib/handoff.mjs';
import { acquireLock, releaseLock } from '../scripts/lib/lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const HOOK_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'hook.mjs');
const CLI_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'cli.mjs');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir, files = {}) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore', windowsHide: true });
}

function runHook(platform, event, payload, stateDir) {
  return spawnSync(process.execPath, [HOOK_SCRIPT, '--platform', platform, '--event', event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      KEEPSTATE_STATE_DIR: stateDir,
      KEEPSTATE_COMPACTING: '',
    },
  });
}

test('buildBackupFilename and createUniqueBackupPath use full date and avoid collisions', () => {
  const dir = mkTempDir('keepstate-backup-');
  try {
    const dt = new Date(2026, 10, 14, 22, 5, 9);
    const name = buildBackupFilename(dt);
    assert.equal(name, 'handoff_backup_2026-11-14_22-05-09.md');

    const first = createUniqueBackupPath(dir, dt);
    fs.writeFileSync(first, 'v1', 'utf8');
    const second = createUniqueBackupPath(dir, dt);
    assert.equal(path.basename(first), 'handoff_backup_2026-11-14_22-05-09.md');
    assert.equal(path.basename(second), 'handoff_backup_2026-11-14_22-05-09_2.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseHandoff splits 3 layers, handles oversized preamble, and keeps sessions appended below notice', () => {
  const bigPreamble = `Intro notes\n${'x'.repeat(11000)}`;
  const doc = [
    '# Project — HANDOFF',
    '',
    bigPreamble,
    '',
    '## КРИТИЧНЫЕ ИНВАРИАНТЫ',
    '- Никогда не удалять прод БД',
    '- Тесты: npm test',
    '',
    '## Вехи и ключевые решения (компакт 2026-11-01)',
    '- Перешли на SQLite WAL.',
    '',
    '## 2026-11-02 — Сессия 1',
    '- Сделали логин.',
    '',
    '## 2026-11-05 — Сессия 2',
    '- Починили парсер.',
    '',
    '---',
    '<!-- keepstate:backup-notice:start -->',
    '> старое уведомление',
    '<!-- keepstate:backup-notice:end -->',
    '',
    '## 2026-11-14 — Сессия 3 (дописали ниже notice)',
    '- Новая фича X.',
  ].join('\n');

  const stripped = stripBackupNotice(doc);
  assert.ok(!stripped.includes('keepstate:backup-notice'));
  assert.ok(stripped.includes('Новая фича X.'));

  const parsed = parseHandoff(doc, 2, 14336, 2);
  assert.equal(parsed.docTitle, '# Project — HANDOFF');
  assert.ok(parsed.invariantsText.includes('Никогда не удалять прод БД'));
  assert.ok(!parsed.invariantsText.includes('Intro notes'));
  assert.equal(parsed.existingMilestones, '- Перешли на SQLite WAL.');
  assert.equal(parsed.oldSections.length, 2); // oversized preamble + Сессия 1
  assert.equal(parsed.recentSections.length, 2); // Сессия 2 + Сессия 3
  assert.match(parsed.recentSections[1].heading, /Сессия 3/);

  const assembled = assembleCompactedHandoff({
    docTitle: parsed.docTitle,
    invariantsText: parsed.invariantsText,
    milestonesBody: '## лишний заголовок\n\n- Объединённая веха 1.\n- Веха 2.',
    recentSections: parsed.recentSections,
    backupsRelDir: 'handoffbackups',
    latestBackupName: 'handoff_backup_2026-11-14_22-05-09.md',
    dateStr: '2026-11-14',
  });

  assert.equal((assembled.match(/keepstate:backup-notice:start/g) || []).length, 1);
  assert.ok(assembled.includes('## КРИТИЧНЫЕ ИНВАРИАНТЫ'));
  assert.ok(assembled.includes('- Объединённая веха 1.'));
  assert.ok(!assembled.includes('## лишний заголовок'));
  assert.ok(assembled.includes('ОБЯЗАТЕЛЬНО ПЕРЕПРОВЕРЯЙ КРИТИЧЕСКИ ВАЖНУЮ ИНФОРМАЦИЮ'));
  assert.ok(assembled.includes('handoff_backup_2026-11-14_22-05-09.md'));
});

test('hook.mjs suggests HANDOFF.md once per repo when missing and stays silent after', () => {
  const repo = mkTempDir('keepstate-nohandoff-');
  const stateDir = mkTempDir('keepstate-state-');
  try {
    initGitRepo(repo, { 'app.js': 'console.log(1);\n' });

    // No code change yet -> allow stop on both platforms
    let r = runHook('claude', 'stop', { cwd: repo, session_id: 's1' }, stateDir);
    assert.equal(r.status, 0);

    // Edit code -> first suggestion
    fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(2);\n', 'utf8');
    r = runHook('claude', 'stop', { cwd: repo, session_id: 's1' }, stateDir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /KEEPSTATE INFO/);

    // Second run -> does not nag again
    r = runHook('antigravity', 'stop', { workspacePaths: [repo], conversationId: 'ag1' }, stateDir);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), {});
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('hook.mjs stays silent on SessionStart by default (injectOnStart=false), supports opt-in injectOnStart=true, and enforces HANDOFF update on Stop', () => {
  const repo = mkTempDir('keepstate-enforce-');
  const stateDir = mkTempDir('keepstate-state-');
  try {
    initGitRepo(repo, {
      'src/index.js': 'export const x = 1;\n',
      'HANDOFF.md': '# Demo\n\n## КРИТИЧНЫЕ ИНВАРИАНТЫ\n- Port 4321\n\n## 2026-11-10 — Init\n- Setup.\n',
    });

    // Default SessionStart -> silent ({}), no token bloat
    const startClaudeSilent = runHook('claude', 'session-start', { cwd: repo, session_id: 'c0' }, stateDir);
    assert.equal(startClaudeSilent.status, 0);
    assert.deepEqual(JSON.parse(startClaudeSilent.stdout), {});

    const startAgySilent = runHook('antigravity', 'session-start', { workspacePaths: [repo], conversationId: 'a0' }, stateDir);
    assert.equal(startAgySilent.status, 0);
    assert.deepEqual(JSON.parse(startAgySilent.stdout), {});

    // Opt-in injectOnStart=true -> injects HANDOFF context
    fs.writeFileSync(path.join(repo, '.keepstate.json'), JSON.stringify({ injectOnStart: true }), 'utf8');

    const startClaude = runHook('claude', 'session-start', { cwd: repo, session_id: 'c1' }, stateDir);
    assert.equal(startClaude.status, 0);
    const parsedClaude = JSON.parse(startClaude.stdout);
    assert.match(parsedClaude.hookSpecificOutput.additionalContext, /Port 4321/);

    const startAgy = runHook('antigravity', 'session-start', { workspacePaths: [repo], conversationId: 'a1' }, stateDir);
    assert.equal(startAgy.status, 0);
    const parsedAgy = JSON.parse(startAgy.stdout);
    assert.match(parsedAgy.injectSteps[0].systemMessage.systemMessage, /Port 4321/);

    // No changes -> allow stop
    let stopAgy = runHook(
      'antigravity',
      'stop',
      { workspacePaths: [repo], conversationId: 'a1', terminationReason: 'NO_TOOL_CALL' },
      stateDir
    );
    assert.equal(stopAgy.status, 0);
    assert.deepEqual(JSON.parse(stopAgy.stdout), {});

    // Code committed since SessionStart WITHOUT touching HANDOFF.md -> must block!
    fs.writeFileSync(path.join(repo, 'src/index.js'), 'export const x = 2;\n', 'utf8');
    execFileSync('git', ['add', 'src/index.js'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['commit', '-m', 'bump x'], { cwd: repo, stdio: 'ignore', windowsHide: true });

    stopAgy = runHook(
      'antigravity',
      'stop',
      { workspacePaths: [repo], conversationId: 'a1', terminationReason: 'NO_TOOL_CALL' },
      stateDir
    );
    assert.equal(stopAgy.status, 0);
    const blockAgy = JSON.parse(stopAgy.stdout);
    assert.equal(blockAgy.decision, 'continue');
    assert.match(blockAgy.reason, /KEEPSTATE STOP BLOCK/);

    const stopClaude = runHook('claude', 'stop', { cwd: repo, session_id: 'c1' }, stateDir);
    assert.equal(stopClaude.status, 2);
    assert.match(stopClaude.stderr, /KEEPSTATE STOP BLOCK/);

    // Update HANDOFF.md -> allows stop cleanly
    fs.appendFileSync(path.join(repo, 'HANDOFF.md'), '\n## 2026-11-14 — Bump x\n- Updated x to 2.\n', 'utf8');
    const allowClaude = runHook('claude', 'stop', { cwd: repo, session_id: 'c1' }, stateDir);
    assert.equal(allowClaude.status, 0);

    const allowAgy = runHook(
      'antigravity',
      'stop',
      { workspacePaths: [repo], conversationId: 'a1', terminationReason: 'NO_TOOL_CALL' },
      stateDir
    );
    assert.deepEqual(JSON.parse(allowAgy.stdout), {});
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('compactProject saves backup, merges concurrent append, respects lock and threshold', () => {
  const repo = mkTempDir('keepstate-compact-');
  const stateDir = mkTempDir('keepstate-state-');
  const prevState = process.env.KEEPSTATE_STATE_DIR;
  process.env.KEEPSTATE_STATE_DIR = stateDir;

  try {
    // Mock compactor script that ALSO appends a concurrent session to HANDOFF.md mid-run
    const mockScript = path.join(repo, 'mock-compactor.mjs');
    fs.writeFileSync(
      mockScript,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        'const promptFile = process.argv[2];',
        "const prompt = fs.readFileSync(promptFile, 'utf8');",
        "if (!prompt.includes('Сессия 1')) throw new Error('missing old session');",
        'const handoff = path.join(process.cwd(), "HANDOFF.md");',
        'fs.appendFileSync(handoff, "\\n## 2026-11-15 — Сессия 5 (concurrent)\\n- Дописано параллельно.\\n", "utf8");',
        'process.stdout.write("- Архитектура: выбран WAL.\\n- Баг фикс: исправлен race condition.\\n");',
      ].join('\n'),
      'utf8'
    );

    const oldPad = 'Детали старой рутины. '.repeat(80);
    const initialHandoff = [
      '# Compact Demo',
      '',
      '## КРИТИЧНЫЕ ИНВАРИАНТЫ',
      '- Не трогать billing/webhook secret',
      '',
      '## Вехи и ключевые решения',
      '- Инициализировали проект.',
      '',
      '## 2026-11-01 — Сессия 1',
      `- ${oldPad}`,
      '',
      '## 2026-11-02 — Сессия 2',
      `- ${oldPad}`,
      '',
      '## 2026-11-03 — Сессия 3',
      '- Поправили кэш Redis.',
      '',
      '## 2026-11-04 — Сессия 4',
      '- Подключили тесты.',
    ].join('\n');

    initGitRepo(repo, {
      'HANDOFF.md': initialHandoff,
      '.keepstate.json': JSON.stringify(
        {
          thresholdBytes: 100000,
          keepRecentSessions: 2,
          maxRecentBytes: 2048,
          platformBackendMap: { claude: 'mock', antigravity: 'mock' },
          backends: {
            mock: {
              type: 'custom-cli',
              command: process.execPath,
              args: [mockScript, '{promptFile}'],
              model: 'mock-1',
            },
          },
        },
        null,
        2
      ),
    });

    // Below threshold -> skip
    const skipped = compactProject({ cwd: repo, platform: 'claude', force: false });
    assert.equal(skipped.compacted, false);
    assert.equal(skipped.reason, 'below_threshold');

    // Lock active -> returns locked
    const lockPath = path.join(repo, '.keepstate.lock');
    assert.equal(acquireLock(lockPath, 60000), true);
    const locked = compactProject({ cwd: repo, platform: 'claude', force: true });
    assert.equal(locked.compacted, false);
    assert.equal(locked.reason, 'locked');
    releaseLock(lockPath);

    // Lower threshold and compact
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.keepstate.json'), 'utf8'));
    cfg.thresholdBytes = 500;
    fs.writeFileSync(path.join(repo, '.keepstate.json'), JSON.stringify(cfg), 'utf8');

    const res = compactProject({ cwd: repo, platform: 'claude', force: false });
    assert.equal(res.compacted, true);
    assert.ok(res.afterBytes < res.beforeBytes);
    assert.ok(fs.existsSync(res.backupPath));

    const backupText = fs.readFileSync(res.backupPath, 'utf8');
    assert.equal(backupText, initialHandoff);

    const nextText = fs.readFileSync(path.join(repo, 'HANDOFF.md'), 'utf8');
    assert.ok(nextText.includes('Не трогать billing/webhook secret'));
    assert.ok(nextText.includes('Архитектура: выбран WAL.'));
    assert.ok(nextText.includes('Сессия 4'));
    assert.ok(nextText.includes('Сессия 5 (concurrent)')); // preserved concurrent append!
    assert.ok(!nextText.includes('Детали старой рутины.'));
    assert.ok(nextText.includes('ОБЯЗАТЕЛЬНО ПЕРЕПРОВЕРЯЙ КРИТИЧЕСКИ ВАЖНУЮ ИНФОРМАЦИЮ'));
  } finally {
    if (prevState === undefined) delete process.env.KEEPSTATE_STATE_DIR;
    else process.env.KEEPSTATE_STATE_DIR = prevState;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cli.mjs init and status create 3-layer HANDOFF.md and report metrics', () => {
  const repo = mkTempDir('keepstate-cli-');
  try {
    initGitRepo(repo, { 'README.md': '# Hi\n' });
    const initRes = execFileSync(process.execPath, [CLI_SCRIPT, 'init', '--cwd', repo], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(JSON.parse(initRes).created, true);
    assert.ok(fs.existsSync(path.join(repo, 'HANDOFF.md')));
    assert.ok(fs.existsSync(path.join(repo, 'handoffbackups')));

    const statusRes = execFileSync(process.execPath, [CLI_SCRIPT, 'status', '--cwd', repo], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const st = JSON.parse(statusRes);
    assert.equal(st.exists, true);
    assert.equal(st.needsCompact, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('parseHandoff packs extra recent sessions within maxRecentBytes while preserving old sections to compact', () => {
  const doc = [
    '# App — HANDOFF',
    '',
    '## КРИТИЧНЫЕ ИНВАРИАНТЫ',
    '- Rule 1',
    '',
    '## 2026-11-01 — Old 1',
    '- Old archive text.',
    '',
    '## 2026-11-14 15:00 — Deploy A',
    '- Big feature release details.',
    '',
    '## 2026-11-14 19:00 — Deploy B',
    '- Hotfix details.',
    '',
    '## 2026-11-14 21:00 — Tiny note 1',
    '- Short note.',
    '',
    '## 2026-11-14 21:20 — Tiny note 2',
    '- Status check.',
  ].join('\n');

  const parsed = parseHandoff(doc, 2, 14336, 6);
  assert.equal(parsed.oldSections.length, 1); // Old 1 kept for compaction
  assert.match(parsed.oldSections[0].heading, /Old 1/);
  assert.equal(parsed.recentSections.length, 4); // All 4 recent sessions preserved!
  assert.match(parsed.recentSections[0].heading, /Deploy A/);
  assert.match(parsed.recentSections[3].heading, /Tiny note 2/);
});

test('hook.mjs ignores pre-existing dirty files on read-only sessions and still catches edits in dirty folders or un-updated dirty HANDOFF', () => {
  const repo = mkTempDir('keepstate-dirtybaseline-');
  const stateDir = mkTempDir('keepstate-state-');
  try {
    initGitRepo(repo, {
      'src/app.js': 'export const a = 1;\n',
      'docs/HANDOFF.md': '# Demo\n\n## КРИТИЧНЫЕ ИНВАРИАНТЫ\n- Keep clean\n\n## 2026-11-10 — Init\n- Seed.\n',
    });

    // Pre-existing dirty working tree BEFORE SessionStart (like ParsMarket's work/ + dirty docs/HANDOFF.md)
    fs.mkdirSync(path.join(repo, 'work', 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'work', 'deploy', 'old.sh'), 'echo old\n', 'utf8');
    fs.appendFileSync(path.join(repo, 'docs', 'HANDOFF.md'), '- Prior uncommited note.\n', 'utf8');

    const sClaude = runHook('claude', 'session-start', { cwd: repo, session_id: 'd1' }, stateDir);
    assert.equal(sClaude.status, 0);

    // Agent did NO edits -> must allow stop cleanly!
    const stopReadOnly = runHook('claude', 'stop', { cwd: repo, session_id: 'd1' }, stateDir);
    assert.equal(stopReadOnly.status, 0);

    // Agent adds a new file inside pre-existing untracked folder without updating dirty docs/HANDOFF.md -> must block!
    fs.writeFileSync(path.join(repo, 'work', 'deploy', 'new.sh'), 'echo new\n', 'utf8');
    const stopBlocked = runHook('claude', 'stop', { cwd: repo, session_id: 'd1' }, stateDir);
    assert.equal(stopBlocked.status, 2);
    assert.match(stopBlocked.stderr, /KEEPSTATE STOP BLOCK/);

    // Agent appends current session note to docs/HANDOFF.md -> allows stop
    fs.appendFileSync(path.join(repo, 'docs', 'HANDOFF.md'), '\n## 2026-11-14 — Added deploy script\n- Added new.sh.\n', 'utf8');
    const stopAllowed = runHook('claude', 'stop', { cwd: repo, session_id: 'd1' }, stateDir);
    assert.equal(stopAllowed.status, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
