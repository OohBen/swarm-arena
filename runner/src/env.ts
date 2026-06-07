import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Load OPENROUTER_API_KEY from the process env or ~/.ai.env. Fail fast if absent
// — the worker loop cannot run without it (no silent fallback).
function parseEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[m[1]] = value;
  }
  return env;
}

const aiEnvPath = path.join(os.homedir(), '.ai.env');
const fileEnv = fs.existsSync(aiEnvPath) ? parseEnvFile(aiEnvPath) : {};

export const OPENROUTER_API_KEY: string =
  process.env.OPENROUTER_API_KEY ?? fileEnv.OPENROUTER_API_KEY ?? '';

if (!OPENROUTER_API_KEY) {
  throw new Error('OPENROUTER_API_KEY missing from environment and ~/.ai.env');
}
