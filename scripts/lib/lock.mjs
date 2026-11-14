import fs from 'node:fs';
import path from 'node:path';

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isLockActive(lockPath, ttlMs = 300000) {
  if (!fs.existsSync(lockPath)) return false;
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > ttlMs) {
      fs.unlinkSync(lockPath);
      return false;
    }
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (data?.pid && !isPidAlive(data.pid)) {
      fs.unlinkSync(lockPath);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(lockPath, ttlMs = 300000) {
  if (isLockActive(lockPath, ttlMs)) return false;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: 'wx', encoding: 'utf8' }
    );
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    // Ignore cleanup errors
  }
}

export function atomicWriteFile(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, targetPath);
}
