// Single-writer, replica-local metadata. Never persist prompts, signatures or tokens.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const NATIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export function nativeStorageError(reason) {
  return Object.assign(new Error(`Native thinking: ${reason}; provenance storage is unavailable.`), {
    code: 'NATIVE_THINKING_STORAGE_ERROR', status: 503,
  });
}
export function readNativeState(file) {
  try {
    if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('oversize');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1) throw new Error('version');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw nativeStorageError('cannot read saved metadata');
  }
}
export function writeNativeState(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ ...value, version: 1 }));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } catch {
    throw nativeStorageError('cannot save metadata');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
  }
}
