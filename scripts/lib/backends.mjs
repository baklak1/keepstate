import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseJsonLinesTail(stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Keep scanning backwards
    }
  }
  return null;
}

function stripOuterMarkdownFence(text) {
  const trimmed = text.trim();
  const match = /^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/**
 * Run Claude Code CLI headless compactor (defaults to claude-haiku-5-5 with effort xhigh).
 */
function runClaudeBackend(backend, prompt, cwd, timeoutMs) {
  const args = ['-p', '--model', backend.model || 'claude-haiku-5-5'];
  if (backend.effort) args.push('--effort', backend.effort);
  args.push(
    '--no-session-persistence',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--output-format',
    'json'
  );

  const res = spawnSync(backend.command || 'claude', args, {
    cwd,
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, KEEPSTATE_COMPACTING: '1' },
  });

  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`claude exited with ${res.status}: ${(res.stderr || res.stdout || '').slice(0, 500)}`);
  }

  const parsed = parseJsonLinesTail(res.stdout || '');
  const text = parsed?.result ?? res.stdout ?? '';
  if (!text.trim()) throw new Error('claude returned empty compaction result');
  return {
    text: stripOuterMarkdownFence(text),
    meta: {
      backend: backend.name,
      model: backend.model,
      effort: backend.effort || null,
      costUsd: parsed?.total_cost_usd ?? null,
      durationMs: parsed?.duration_ms ?? null,
      usage: parsed?.usage ?? null,
    },
  };
}

/**
 * Run Antigravity CLI headless compactor (defaults to gemini-4-hydrogen-medium).
 * Uses a temp file because `agy -p` does not read long prompts from stdin and Windows CLI limits arg length.
 */
function runAgyBackend(backend, prompt, cwd, timeoutMs) {
  const tmpPath = path.join(os.tmpdir(), `keepstate-compact-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(tmpPath, prompt, 'utf8');

  try {
    const shortPrompt =
      `Read the exact file at ${tmpPath} using read_file, follow the instructions inside it strictly, ` +
      `and respond with ONLY the resulting Markdown bullet list (no intro, no code fence).`;

    const args = [
      '--model',
      backend.model || 'gemini-4-hydrogen-medium',
      '--output-format',
      'json',
      '--disable-slash-commands',
      '--dangerously-skip-permissions',
      `-p=${shortPrompt}`,
    ];
    if (backend.effort) args.push('--effort', backend.effort);

    const res = spawnSync(backend.command || 'agy', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, KEEPSTATE_COMPACTING: '1' },
    });

    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`agy exited with ${res.status}: ${(res.stderr || res.stdout || '').slice(0, 500)}`);
    }

    const parsed = parseJsonLinesTail(res.stdout || '');
    const text = parsed?.response ?? parsed?.result ?? res.stdout ?? '';
    if (!text.trim()) throw new Error('agy returned empty compaction result');
    return {
      text: stripOuterMarkdownFence(text),
      meta: {
        backend: backend.name,
        model: backend.model,
        effort: backend.effort || null,
        durationSeconds: parsed?.duration_seconds ?? null,
        usage: parsed?.usage ?? null,
      },
    };
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore temp cleanup error
    }
  }
}

/**
 * Extensible custom CLI backend: supports `{promptFile}` and `{model}` placeholders in `backend.args`.
 */
function runCustomCliBackend(backend, prompt, cwd, timeoutMs) {
  const tmpPath = path.join(os.tmpdir(), `keepstate-compact-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(tmpPath, prompt, 'utf8');
  try {
    const args = (backend.args || []).map((a) =>
      String(a)
        .replaceAll('{promptFile}', tmpPath)
        .replaceAll('{model}', backend.model || '')
    );
    const out = execFileSync(backend.command, args, {
      cwd,
      input: backend.stdinPrompt ? prompt : undefined,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, KEEPSTATE_COMPACTING: '1' },
    });
    if (!out.trim()) throw new Error(`${backend.command} returned empty output`);
    return {
      text: stripOuterMarkdownFence(out),
      meta: { backend: backend.name, model: backend.model || null },
    };
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup
    }
  }
}

const RUNNERS = {
  'claude-cli': runClaudeBackend,
  'agy-cli': runAgyBackend,
  'custom-cli': runCustomCliBackend,
};

export function runCompactorBackend(backend, prompt, cwd, timeoutMs = 180000) {
  const runner = RUNNERS[backend.type];
  if (!runner) {
    throw new Error(`Unsupported backend type "${backend.type}" for "${backend.name}"`);
  }
  return runner(backend, prompt, cwd, timeoutMs);
}
