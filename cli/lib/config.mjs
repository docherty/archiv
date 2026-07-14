import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectory, pathExists } from './util.mjs';

export const STATE_DIRECTORY = '.venice-archive';
export const CONFIG_FILE = 'config.json';

export async function loadConfig(archiveDirectory) {
  const configPath = path.join(archiveDirectory, STATE_DIRECTORY, CONFIG_FILE);
  if (!(await pathExists(configPath))) return null;
  return JSON.parse(await readFile(configPath, 'utf8'));
}

export async function saveConfig(archiveDirectory, config) {
  const stateDirectory = await ensureDirectory(path.join(archiveDirectory, STATE_DIRECTORY));
  const value = { schemaVersion: 1, ...config, updatedAt: new Date().toISOString() };
  await writeFile(path.join(stateDirectory, CONFIG_FILE), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}
