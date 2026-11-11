// Locate a Chromium build that still accepts --load-extension (branded Chrome dropped it
// in version 137): Chrome for Testing or Chromium, e.g. the copies Puppeteer and
// Playwright download. Set CHROME_PATH to use a specific binary.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EXECUTABLES = {
  win32: ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'],
  darwin: [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['chrome-linux64/chrome', 'chrome-linux/chrome'],
};

function cacheRoots() {
  const home = homedir();
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  return [
    // Playwright: ms-playwright/chromium-<build>/<platform dir>/...
    { dir: process.platform === 'win32' ? join(local, 'ms-playwright')
      : process.platform === 'darwin' ? join(home, 'Library', 'Caches', 'ms-playwright')
      : join(home, '.cache', 'ms-playwright'), match: /^chromium-\d+$/ },
    // Puppeteer: .cache/puppeteer/chrome/<platform>-<version>/...
    { dir: join(home, '.cache', 'puppeteer', 'chrome'), match: /^[a-z0-9]+-[\d.]+$/ },
  ];
}

const versionKey = (name) => name.match(/[\d.]+$/)?.[0].split('.').map(Number) ?? [0];

function newestFirst(a, b) {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  }
  return 0;
}

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = EXECUTABLES[process.platform] ?? EXECUTABLES.linux;
  for (const { dir, match } of cacheRoots()) {
    if (!existsSync(dir)) continue;
    const builds = readdirSync(dir).filter((name) => match.test(name)).sort(newestFirst);
    for (const build of builds) {
      for (const executable of candidates) {
        const path = join(dir, build, executable);
        if (existsSync(path)) return path;
      }
    }
  }
  throw new Error(
    'No Chrome for Testing / Chromium found. Run `npx @puppeteer/browsers install chrome@stable` '
      + 'or set CHROME_PATH to a Chromium binary (branded Chrome cannot load unpacked extensions from the command line).',
  );
}
