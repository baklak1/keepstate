import fs from 'node:fs';
import path from 'node:path';
import { runCompactorBackend } from './lib/backends.mjs';
import { getStateDir, loadConfig, resolveBackend } from './lib/config.mjs';
import {
  assembleCompactedHandoff,
  createUniqueBackupPath,
  findHandoffFile,
  findProjectRoot,
  getBackupsDir,
  hashString,
  parseHandoff,
} from './lib/handoff.mjs';
import { acquireLock, atomicWriteFile, releaseLock } from './lib/lock.mjs';

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), platform: 'claude', backend: null, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cwd' && argv[i + 1]) opts.cwd = argv[++i];
    else if (a === '--platform' && argv[i + 1]) opts.platform = argv[++i];
    else if (a === '--backend' && argv[i + 1]) opts.backend = argv[++i];
    else if (a === '--force') opts.force = true;
  }
  return opts;
}

function appendLog(line) {
  try {
    const logDir = getStateDir();
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'compact.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // Never fail compaction over log write
  }
}

function buildCompactionPrompt({ projectName, existingMilestones, oldSectionsText, maxMilestones }) {
  return [
    `Ты сжимаешь долгую историю HANDOFF.md проекта "${projectName}" (рассчитанную на год+ развития).`,
    'Задача: объедини "Текущие вехи" и "Старые сессии" в ОДИН обновлённый список вех и ключевых решений.',
    '',
    'ЖЁСТКИЕ ПРАВИЛА:',
    `1. Максимум ${maxMilestones} буллетов (по 1-2 строки каждый).`,
    '2. СОХРАНЯЙ только долгоживущую ценность: почему выбрали архитектуру/библиотеку, нетривиальные причины старых багов, ограничения БД/API/деплоя, важные границы модулей.',
    '3. БЕЗЖАЛОСТНО ВЫБРАСЫВАЙ устаревшую текучку: мелкие правки отступов/опечаток, старые прогоны тестов («264/264 ок»), отменённые эксперименты, рутинные логи шагов.',
    '4. Если среди старого текста встретятся критические креды/порты/команды отката, не тащи их целиком, а коротко упомяни ключевую суть (детали останутся в handoffbackups/).',
    '5. Верни ТОЛЬКО markdown-список буллетов (каждая строка начинается с `- `), БЕЗ заголовков `##`, БЕЗ вступлений и БЕЗ обертки в ```.',
    '',
    '=== ТЕКУЩИЕ ВЕХИ (если были) ===',
    existingMilestones || '(пока пусто)',
    '',
    '=== СТАРЫЕ СЕССИИ ДЛЯ СЖАТИЯ И ПРОРЕЖИВАНИЯ ===',
    oldSectionsText,
  ].join('\n');
}

export function compactProject({ cwd, platform = 'claude', backend: explicitBackend = null, force = false }) {
  const projectRoot = findProjectRoot(cwd);
  const config = loadConfig(projectRoot);
  if (!config.enabled) return { compacted: false, reason: 'disabled' };

  const handoffPath = findHandoffFile(projectRoot, config);
  if (!handoffPath) return { compacted: false, reason: 'no_handoff' };

  const stat = fs.statSync(handoffPath);
  if (!force && stat.size <= config.thresholdBytes) {
    return { compacted: false, reason: 'below_threshold', bytes: stat.size, thresholdBytes: config.thresholdBytes };
  }

  const lockPath = path.join(path.dirname(handoffPath), '.keepstate.lock');
  if (!acquireLock(lockPath, config.lockTtlMs)) {
    return { compacted: false, reason: 'locked' };
  }

  try {
    const rawText = fs.readFileSync(handoffPath, 'utf8');
    const originalHash = hashString(rawText);
    const parsed = parseHandoff(
      rawText,
      config.keepRecentSessions,
      config.maxRecentBytes,
      config.maxRecentSessions
    );

    if (parsed.oldSections.length === 0) {
      return { compacted: false, reason: 'nothing_to_compact', bytes: Buffer.byteLength(rawText, 'utf8') };
    }

    const backupsDir = getBackupsDir(handoffPath, config);
    const backupPath = createUniqueBackupPath(backupsDir);
    atomicWriteFile(backupPath, rawText);

    const oldSectionsText = parsed.oldSections.map((s) => s.full).join('\n\n');
    const prompt = buildCompactionPrompt({
      projectName: path.basename(projectRoot),
      existingMilestones: parsed.existingMilestones,
      oldSectionsText,
      maxMilestones: config.maxMilestones,
    });

    const backend = resolveBackend(config, platform, explicitBackend);
    const result = runCompactorBackend(backend, prompt, projectRoot, config.compactTimeoutMs);

    // Re-read in case another session appended to HANDOFF.md while compactor ran
    const currentDiskText = fs.readFileSync(handoffPath, 'utf8');
    let recentSections = parsed.recentSections;
    let invariantsText = parsed.invariantsText;
    if (hashString(currentDiskText) !== originalHash) {
      const latestParsed = parseHandoff(
        currentDiskText,
        config.keepRecentSessions,
        config.maxRecentBytes,
        config.maxRecentSessions
      );
      recentSections = latestParsed.recentSections;
      if (latestParsed.invariantsText) invariantsText = latestParsed.invariantsText;
    }

    const today = new Date().toISOString().slice(0, 10);
    const backupsRelDir = path.relative(path.dirname(handoffPath), backupsDir) || 'handoffbackups';
    const nextText = assembleCompactedHandoff({
      docTitle: parsed.docTitle,
      invariantsText,
      milestonesBody: result.text,
      recentSections,
      backupsRelDir,
      latestBackupName: path.basename(backupPath),
      dateStr: today,
    });

    const beforeBytes = Buffer.byteLength(currentDiskText, 'utf8');
    const afterBytes = Buffer.byteLength(nextText, 'utf8');

    // Sanity check: never overwrite with garbage/empty output or inflate without force
    if (!result.text.trim() || (!force && afterBytes >= beforeBytes)) {
      appendLog(
        `SKIPPED project=${path.basename(projectRoot)} before=${beforeBytes} after=${afterBytes} backup=${path.basename(backupPath)}`
      );
      return {
        compacted: false,
        reason: 'not_smaller',
        beforeBytes,
        afterBytes,
        backupPath,
      };
    }

    atomicWriteFile(handoffPath, nextText);
    appendLog(
      `COMPACTED project=${path.basename(projectRoot)} backend=${backend.name}:${backend.model} before=${beforeBytes} after=${afterBytes} backup=${path.basename(backupPath)}`
    );

    return {
      compacted: true,
      handoffPath,
      backupPath,
      beforeBytes,
      afterBytes,
      meta: result.meta,
    };
  } catch (err) {
    appendLog(`ERROR cwd=${cwd}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    releaseLock(lockPath);
  }
}

const isCliEntry = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isCliEntry) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const res = compactProject(opts);
    process.stdout.write(`${JSON.stringify(res)}\n`);
  } catch (err) {
    process.stderr.write(`keepstate compact error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
