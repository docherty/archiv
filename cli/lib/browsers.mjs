import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { directorySize, pathExists } from './util.mjs';

const home = os.homedir();
const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
const programFiles = process.env.PROGRAMFILES || 'C:/Program Files';

function platformBrowser({ macExecutable, macData, windowsExecutable, windowsData, linuxExecutable, linuxData }) {
  if (process.platform === 'win32') return { executable: windowsExecutable, userDataDirectory: windowsData };
  if (process.platform === 'linux') return { executable: linuxExecutable, userDataDirectory: linuxData };
  return { executable: macExecutable, userDataDirectory: macData };
}

export const BROWSERS = {
  brave: {
    id: 'brave',
    name: 'Brave',
    ...platformBrowser({
      macExecutable: process.env.VENICE_BRAVE_EXECUTABLE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      macData: process.env.VENICE_BRAVE_USER_DATA || path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser'),
      windowsExecutable: process.env.VENICE_BRAVE_EXECUTABLE || path.join(programFiles, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      windowsData: process.env.VENICE_BRAVE_USER_DATA || path.join(localAppData, 'BraveSoftware/Brave-Browser/User Data'),
      linuxExecutable: process.env.VENICE_BRAVE_EXECUTABLE || '/usr/bin/brave-browser',
      linuxData: process.env.VENICE_BRAVE_USER_DATA || path.join(home, '.config/BraveSoftware/Brave-Browser')
    })
  },
  chrome: {
    id: 'chrome',
    name: 'Google Chrome',
    ...platformBrowser({
      macExecutable: process.env.VENICE_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      macData: process.env.VENICE_CHROME_USER_DATA || path.join(home, 'Library/Application Support/Google/Chrome'),
      windowsExecutable: process.env.VENICE_CHROME_EXECUTABLE || path.join(programFiles, 'Google/Chrome/Application/chrome.exe'),
      windowsData: process.env.VENICE_CHROME_USER_DATA || path.join(localAppData, 'Google/Chrome/User Data'),
      linuxExecutable: process.env.VENICE_CHROME_EXECUTABLE || '/usr/bin/google-chrome',
      linuxData: process.env.VENICE_CHROME_USER_DATA || path.join(home, '.config/google-chrome')
    })
  }
};

async function readJson(filePath, fallback = {}) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return fallback; }
}

export async function discoverProfiles(browserId = 'brave') {
  const browser = BROWSERS[browserId];
  if (!browser) throw new Error(`Unsupported browser: ${browserId}`);
  if (!(await pathExists(browser.userDataDirectory))) return { browser, profiles: [] };

  const localState = await readJson(path.join(browser.userDataDirectory, 'Local State'));
  const infoCache = localState?.profile?.info_cache || {};
  const entries = await readdir(browser.userDataDirectory, { withFileTypes: true });
  const profileNames = entries
    .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
    .map((entry) => entry.name);

  const profiles = [];
  for (const directoryName of profileNames) {
    const directory = path.join(browser.userDataDirectory, directoryName);
    const preferences = await readJson(path.join(directory, 'Preferences'));
    const indexedDbRoot = path.join(directory, 'IndexedDB');
    const veniceLevelDb = path.join(indexedDbRoot, 'https_venice.ai_0.indexeddb.leveldb');
    const veniceBlobs = path.join(indexedDbRoot, 'https_venice.ai_0.indexeddb.blob');
    const indexedDbBytes = await directorySize(veniceLevelDb) + await directorySize(veniceBlobs);
    const opfsBytes = await directorySize(path.join(directory, 'File System'));
    profiles.push({
      directoryName,
      name: infoCache[directoryName]?.name || preferences?.profile?.name || directoryName,
      path: directory,
      isLastUsed: localState?.profile?.last_used === directoryName,
      hasVeniceData: indexedDbBytes > 0,
      indexedDbBytes,
      opfsCandidateBytes: opfsBytes,
      evidenceBytes: indexedDbBytes + opfsBytes
    });
  }

  profiles.sort((left, right) => Number(right.hasVeniceData) - Number(left.hasVeniceData) || right.evidenceBytes - left.evidenceBytes);
  return { browser, profiles };
}

export function chooseProfile(profiles, requested) {
  if (requested) {
    const match = profiles.find((profile) => profile.directoryName === requested || profile.name.toLowerCase() === requested.toLowerCase());
    if (!match) throw new Error(`Profile not found: ${requested}`);
    return match;
  }
  const match = profiles.find((profile) => profile.hasVeniceData);
  if (!match) throw new Error('No browser profile containing Venice IndexedDB data was found.');
  return match;
}
