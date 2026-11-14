import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  enabled: true,
  thresholdBytes: 36864,
  keepRecentSessions: 2,
  maxMilestones: 18,
  handoffPath: null,
  handoffCandidates: ['HANDOFF.md', 'docs/HANDOFF.md'],
  backupsDirName: 'handoffbackups',
  suggestMissingHandoff: true,
  autoCompactOnStop: true,
  compactTimeoutMs: 180000,
  lockTtlMs: 300000,
  platformBackendMap: {
    claude: 'claude',
    antigravity: 'antigravity',
  },
  backends: {
    claude: {
      type: 'claude-cli',
      command: 'claude',
      model: 'claude-haiku-5-5',
      effort: 'xhigh',
    },
    antigravity: {
      type: 'agy-cli',
      command: 'agy',
      model: 'gemini-4-hydrogen-medium',
    },
  },
};

/**
 * Directory for local runtime state (session snapshots, suggested-repo markers, logs).
 * Override via KEEPSTATE_STATE_DIR for isolated testing.
 */
export function getStateDir() {
  return process.env.KEEPSTATE_STATE_DIR || path.join(os.homedir(), '.keepstate');
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return base;
  return {
    ...base,
    ...override,
    platformBackendMap: {
      ...base.platformBackendMap,
      ...(override.platformBackendMap || {}),
    },
    backends: {
      ...base.backends,
      ...(override.backends || {}),
    },
  };
}

/**
 * Load effective keepstate configuration from defaults, global config, project config, and env vars.
 */
export function loadConfig(projectRoot) {
  let cfg = mergeConfig({}, DEFAULT_CONFIG);
  const globalCfg = readJsonIfExists(path.join(getStateDir(), 'config.json'));
  cfg = mergeConfig(cfg, globalCfg);

  if (projectRoot) {
    const projectCfg = readJsonIfExists(path.join(projectRoot, '.keepstate.json'));
    cfg = mergeConfig(cfg, projectCfg);
  }

  if (process.env.KEEPSTATE_ENABLED === '0' || process.env.KEEPSTATE_ENABLED === 'false') {
    cfg.enabled = false;
  }
  if (process.env.KEEPSTATE_THRESHOLD_BYTES) {
    const parsed = Number.parseInt(process.env.KEEPSTATE_THRESHOLD_BYTES, 10);
    if (Number.isFinite(parsed) && parsed > 0) cfg.thresholdBytes = parsed;
  }
  if (process.env.KEEPSTATE_HANDOFF_PATH) {
    cfg.handoffPath = process.env.KEEPSTATE_HANDOFF_PATH;
  }
  return cfg;
}

/**
 * Resolve which backend config should run compaction for the given platform or explicit override.
 */
export function resolveBackend(config, platform, explicitBackend) {
  const backendName =
    process.env.KEEPSTATE_BACKEND ||
    explicitBackend ||
    config.platformBackendMap?.[platform] ||
    'claude';

  const base = config.backends?.[backendName];
  if (!base) {
    throw new Error(`Unknown keepstate backend: ${backendName}`);
  }

  return {
    name: backendName,
    ...base,
    ...(process.env.KEEPSTATE_MODEL ? { model: process.env.KEEPSTATE_MODEL } : {}),
    ...(process.env.KEEPSTATE_EFFORT ? { effort: process.env.KEEPSTATE_EFFORT } : {}),
  };
}
