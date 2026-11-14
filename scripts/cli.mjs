import fs from 'node:fs';
import path from 'node:path';
import { compactProject } from './compact.mjs';
import { loadConfig } from './lib/config.mjs';
import {
  buildInitialHandoffTemplate,
  findHandoffFile,
  findProjectRoot,
  getBackupsDir,
} from './lib/handoff.mjs';
import { atomicWriteFile } from './lib/lock.mjs';

function parseArgs(argv) {
  const cmd = argv[0] || 'status';
  const opts = { cmd, cwd: process.cwd(), platform: 'claude', backend: null, force: false, target: 'HANDOFF.md' };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cwd' && argv[i + 1]) opts.cwd = argv[++i];
    else if (a === '--platform' && argv[i + 1]) opts.platform = argv[++i];
    else if (a === '--backend' && argv[i + 1]) opts.backend = argv[++i];
    else if (a === '--target' && argv[i + 1]) opts.target = argv[++i];
    else if (a === '--force') opts.force = true;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const projectRoot = findProjectRoot(opts.cwd);
const config = loadConfig(projectRoot);

if (opts.cmd === 'init') {
  const existing = findHandoffFile(projectRoot, config);
  if (existing) {
    console.log(JSON.stringify({ ok: true, created: false, handoffPath: existing }));
    process.exit(0);
  }
  const dest = path.resolve(projectRoot, opts.target);
  atomicWriteFile(dest, buildInitialHandoffTemplate(path.basename(projectRoot)));
  fs.mkdirSync(getBackupsDir(dest, config), { recursive: true });
  console.log(JSON.stringify({ ok: true, created: true, handoffPath: dest }));
} else if (opts.cmd === 'status') {
  const handoffPath = findHandoffFile(projectRoot, config);
  if (!handoffPath) {
    console.log(JSON.stringify({ ok: true, projectRoot, exists: false, thresholdBytes: config.thresholdBytes }));
    process.exit(0);
  }
  const stat = fs.statSync(handoffPath);
  const backupsDir = getBackupsDir(handoffPath, config);
  const backups = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((n) => n.endsWith('.md')).sort() : [];
  console.log(
    JSON.stringify(
      {
        ok: true,
        projectRoot,
        exists: true,
        handoffPath,
        bytes: stat.size,
        thresholdBytes: config.thresholdBytes,
        needsCompact: stat.size > config.thresholdBytes,
        backupsDir,
        backupsCount: backups.length,
        latestBackup: backups[backups.length - 1] || null,
      },
      null,
      2
    )
  );
} else if (opts.cmd === 'compact') {
  const res = compactProject({
    cwd: projectRoot,
    platform: opts.platform,
    backend: opts.backend,
    force: opts.force,
  });
  console.log(JSON.stringify(res, null, 2));
} else {
  console.error('Usage: node scripts/cli.mjs <init|status|compact> [--cwd <dir>] [--platform claude|antigravity] [--force]');
  process.exit(1);
}
