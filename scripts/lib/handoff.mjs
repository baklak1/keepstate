import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NOTICE_START = '<!-- keepstate:backup-notice:start -->';
const NOTICE_END = '<!-- keepstate:backup-notice:end -->';
const LEGACY_PREAMBLE_CAP_BYTES = 10240;

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

export function isGitRepo(cwd) {
  try {
    return runGit(['rev-parse', '--is-inside-work-tree'], cwd).trim() === 'true';
  } catch {
    return false;
  }
}

export function findProjectRoot(cwd) {
  try {
    const top = runGit(['rev-parse', '--show-toplevel'], cwd).trim();
    return top ? path.resolve(top) : path.resolve(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function getGitHead(projectRoot) {
  try {
    return runGit(['rev-parse', 'HEAD'], projectRoot).trim();
  } catch {
    return null;
  }
}

export function getRecentCommits(projectRoot, count = 5) {
  try {
    return runGit(['log', `-${count}`, '--oneline'], projectRoot).trim();
  } catch {
    return '';
  }
}

function normalizeRel(p) {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function parsePorcelainLine(line) {
  // Porcelain v1 format: "XY path" or "XY old -> new"
  const raw = line.slice(3).trim();
  const arrowIdx = raw.indexOf(' -> ');
  const target = arrowIdx >= 0 ? raw.slice(arrowIdx + 4) : raw;
  return normalizeRel(target.replace(/^"(.*)"$/, '$1'));
}

export function getWorkingTreeChanges(projectRoot) {
  try {
    const out = runGit(['status', '--porcelain'], projectRoot);
    if (!out.trim()) return [];
    return out.split(/\r?\n/).filter(Boolean).map(parsePorcelainLine);
  } catch {
    return [];
  }
}

export function getCommittedChangesSince(projectRoot, startSha) {
  if (!startSha) return [];
  const head = getGitHead(projectRoot);
  if (!head || head === startSha) return [];
  try {
    const out = runGit(['diff', '--name-only', `${startSha}..HEAD`], projectRoot);
    return out.split(/\r?\n/).filter(Boolean).map(normalizeRel);
  } catch {
    return [];
  }
}

export function isIgnoredArtifact(relPath, backupsRelDir) {
  const norm = normalizeRel(relPath);
  const backupsNorm = normalizeRel(backupsRelDir).replace(/\/$/, '');
  return (
    norm === '.keepstate.json' ||
    norm === '.keepstate.lock' ||
    norm.endsWith('/.keepstate.lock') ||
    norm.startsWith(`${backupsNorm}/`) ||
    norm === backupsNorm
  );
}

export function findHandoffFile(projectRoot, config) {
  if (config.handoffPath) {
    const explicit = path.resolve(projectRoot, config.handoffPath);
    return fs.existsSync(explicit) ? explicit : null;
  }
  for (const rel of config.handoffCandidates || ['HANDOFF.md', 'docs/HANDOFF.md']) {
    const candidate = path.resolve(projectRoot, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function getBackupsDir(handoffPath, config) {
  return path.join(path.dirname(handoffPath), config.backupsDirName || 'handoffbackups');
}

export function buildBackupFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `handoff_backup_${y}-${m}-${d}_${hh}-${mm}-${ss}.md`;
}

export function createUniqueBackupPath(backupsDir, date = new Date()) {
  fs.mkdirSync(backupsDir, { recursive: true });
  const baseName = buildBackupFilename(date);
  let candidate = path.join(backupsDir, baseName);
  if (!fs.existsSync(candidate)) return candidate;
  const stem = baseName.replace(/\.md$/, '');
  for (let i = 2; i < 1000; i += 1) {
    candidate = path.join(backupsDir, `${stem}_${i}.md`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(backupsDir, `${stem}_${Date.now()}.md`);
}

export function hashString(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export function stripBackupNotice(text) {
  const startIdx = text.indexOf(NOTICE_START);
  const endIdx = text.indexOf(NOTICE_END);
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = text.slice(0, startIdx).replace(/[\r\n]+---\s*$/, '').trimEnd();
    const after = text.slice(endIdx + NOTICE_END.length).trim();
    return after ? `${before}\n\n${after}` : before;
  }
  return text.trimEnd();
}

function splitTopLevelSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const preambleLines = [];
  const sections = [];
  let current = null;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && /^##\s+/.test(line)) {
      if (current) sections.push(current);
      current = { heading: line.trim(), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);

  return {
    preamble: preambleLines.join('\n').trim(),
    sections: sections.map((s) => ({
      heading: s.heading,
      body: s.bodyLines.join('\n').trim(),
      full: `${s.heading}\n\n${s.bodyLines.join('\n').trim()}`.trim(),
    })),
  };
}

function isInvariantsHeading(heading) {
  return /^##\s+.*(инвариант|invariant|критичн|rules|правила\s+проекта)/i.test(heading);
}

function isMilestonesHeading(heading) {
  return /^##\s+.*(вехи|ключевые решения|долгая память|milestones|key decisions|архивная выжимка)/i.test(heading);
}

function isRecentWrapperHeading(heading) {
  return /^##\s+.*(последние сессии|recent sessions)/i.test(heading);
}

/**
 * Split HANDOFF.md into 3 compaction layers:
 * 1) invariants (preserved verbatim)
 * 2) milestones + older history (compacted into rolling 1-year milestones)
 * 3) recentSessions (last N sessions preserved verbatim)
 */
export function parseHandoff(rawText, keepRecentSessions = 2, maxRecentBytes = 16384) {
  const cleaned = stripBackupNotice(rawText);
  const { preamble, sections } = splitTopLevelSections(cleaned);

  // Extract H1 title from preamble if present
  const preambleLines = preamble ? preamble.split(/\r?\n/) : [];
  let docTitle = '# HANDOFF';
  let extraPreamble = '';
  if (preambleLines[0] && /^#\s+/.test(preambleLines[0])) {
    docTitle = preambleLines[0].trim();
    extraPreamble = preambleLines.slice(1).join('\n').trim();
  } else {
    extraPreamble = preamble;
  }

  const invariantParts = [];
  if (extraPreamble && Buffer.byteLength(extraPreamble, 'utf8') <= LEGACY_PREAMBLE_CAP_BYTES) {
    invariantParts.push(extraPreamble);
  }

  let existingMilestones = '';
  const historySections = [];

  for (const sec of sections) {
    if (isInvariantsHeading(sec.heading)) {
      invariantParts.push(sec.full);
    } else if (isMilestonesHeading(sec.heading)) {
      existingMilestones = sec.body;
    } else if (isRecentWrapperHeading(sec.heading)) {
      // Unwrap legacy wrapper into its inner text if it was used
      if (sec.body) historySections.push({ heading: sec.heading, body: sec.body, full: sec.body });
    } else {
      historySections.push(sec);
    }
  }

  // If preamble was oversized without an invariants heading, fold it into history so it shrinks
  if (extraPreamble && Buffer.byteLength(extraPreamble, 'utf8') > LEGACY_PREAMBLE_CAP_BYTES) {
    historySections.unshift({ heading: '## Старая преамбула', body: extraPreamble, full: extraPreamble });
  }

  // Keep up to `keepRecentSessions` trailing sections, bounded by maxRecentBytes (always keep at least 1)
  let recentCount = Math.min(keepRecentSessions, historySections.length);
  while (recentCount > 1) {
    const candidateBytes = Buffer.byteLength(
      historySections.slice(-recentCount).map((s) => s.full).join('\n\n'),
      'utf8'
    );
    if (candidateBytes <= maxRecentBytes) break;
    recentCount -= 1;
  }

  const splitIdx = Math.max(0, historySections.length - recentCount);
  const oldSections = historySections.slice(0, splitIdx);
  const recentSections = historySections.slice(splitIdx);

  return {
    docTitle,
    invariantsText: invariantParts.filter(Boolean).join('\n\n').trim(),
    existingMilestones,
    oldSections,
    recentSections,
  };
}

export function buildBackupNotice(backupsRelDir, latestBackupName) {
  const normDir = normalizeRel(backupsRelDir).replace(/\/$/, '');
  const latestNote = latestBackupName ? ` (последний: \`${latestBackupName}\`)` : '';
  return [
    NOTICE_START,
    '---',
    '> [!IMPORTANT]',
    `> **Бекапы истории:** оригиналы до сжатия хранятся в [\`${normDir}/\`](./${normDir}/)${latestNote} под именами \`handoff_backup_ГГГГ-ММ-ДД_ЧЧ-ММ-СС.md\`.`,
    `> **ОБЯЗАТЕЛЬНО ПЕРЕПРОВЕРЯЙ КРИТИЧЕСКИ ВАЖНУЮ ИНФОРМАЦИЮ** (ТОЛЬКО критически важную — точные креды/порты/команды отката/причины старых багов/детали архитектуры, а НЕ всю текучку подряд) в файлах \`${normDir}/\`, если в текущем сжатом HANDOFF не хватает точных деталей!`,
    NOTICE_END,
  ].join('\n');
}

export function assembleCompactedHandoff({
  docTitle,
  invariantsText,
  milestonesBody,
  recentSections,
  backupsRelDir,
  latestBackupName,
  dateStr,
}) {
  const parts = [docTitle || '# HANDOFF'];

  if (invariantsText) {
    parts.push(invariantsText);
  } else {
    parts.push(
      '## КРИТИЧНЫЕ ИНВАРИАНТЫ\n- (Зафиксируй здесь постоянные запреты, правила деплоя и архитектуру — этот блок никогда не сжимается.)'
    );
  }

  const cleanMilestones = milestonesBody
    .replace(/^##\s+.*(?:\r?\n)+/, '')
    .trim();
  parts.push(`## Вехи и ключевые решения (компакт ${dateStr})\n\n${cleanMilestones}`);

  if (recentSections.length > 0) {
    parts.push(recentSections.map((s) => s.full).join('\n\n'));
  }

  parts.push(buildBackupNotice(backupsRelDir, latestBackupName));
  return parts.join('\n\n').trimEnd() + '\n';
}

export function buildInitialHandoffTemplate(projectName) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return [
    `# ${projectName} — HANDOFF`,
    '',
    '## КРИТИЧНЫЕ ИНВАРИАНТЫ',
    '- (Добавь сюда то, что нельзя забывать: команды теста/деплоя, запреты вроде «не запускать прод локально», схему БД.)',
    '',
    '## Вехи и ключевые решения',
    '- (Заполняется автоматически при сжатии старых сессий.)',
    '',
    `## ${stamp} — старт ведения хэндоффа`,
    '- Инициализирован `HANDOFF.md` через `keepstate`.',
    '',
    buildBackupNotice('handoffbackups', ''),
    '',
  ].join('\n');
}
