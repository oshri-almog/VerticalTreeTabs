// Render extension/icons/icon.svg to the PNG sizes the manifest uses.
//   npm run icons

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './find-chrome.mjs';

const ICONS = fileURLToPath(new URL('../extension/icons/', import.meta.url));
const SIZES = [16, 32, 48, 128];

const svg = await readFile(`${ICONS}icon.svg`, 'utf8');
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
try {
  const page = await browser.newPage();
  for (const size of SIZES) {
    // Rasterize at the target size rather than scaling a 128px bitmap down.
    const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
    const base64 = await page.evaluate(async (source, px) => {
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = px;
      canvas.getContext('2d').drawImage(image, 0, 0, px, px);
      return canvas.toDataURL('image/png').split(',')[1];
    }, sized, size);
    await writeFile(`${ICONS}icon${size}.png`, Buffer.from(base64, 'base64'));
    console.log(`icon${size}.png`);
  }
} finally {
  await browser.close();
}
