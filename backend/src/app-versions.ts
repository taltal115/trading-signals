import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { EMBEDDED_BOT_VERSION } from './embedded-bot-version';

export interface AppVersions {
  status: 'ok';
  version: string;
  botVersion: string;
}

function readJsonVersion(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { version?: unknown };
    const v = String(raw.version || '').trim();
    return v || null;
  } catch {
    return null;
  }
}

function readPyprojectVersion(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const text = readFileSync(filePath, 'utf8');
    const m = text.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function findRepoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(join(dir, 'backend', 'package.json')) &&
      existsSync(join(dir, 'pyproject.toml'))
    ) {
      return dir;
    }
    if (
      existsSync(join(dir, 'package.json')) &&
      existsSync(join(dir, '..', 'pyproject.toml'))
    ) {
      return resolve(dir, '..');
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd());
}

let cached: AppVersions | null = null;

/** Backend package.json + bot versions (cached). Prefer env when set on Cloud Run. */
export function getAppVersions(): AppVersions {
  if (cached) return cached;
  const envBe = (process.env.APP_VERSION || '').trim();
  const envBot = (process.env.BOT_VERSION || '').trim();
  const root = findRepoRoot();
  const be =
    envBe ||
    readJsonVersion(join(root, 'backend', 'package.json')) ||
    readJsonVersion(join(process.cwd(), 'package.json')) ||
    '0.0.0';
  const bot =
    envBot ||
    readPyprojectVersion(join(root, 'pyproject.toml')) ||
    EMBEDDED_BOT_VERSION ||
    '0.0.0';
  cached = { status: 'ok', version: be, botVersion: bot };
  return cached;
}
