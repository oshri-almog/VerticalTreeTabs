import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TREE_COLORS } from '../extension/tree.js';

// The tree colours live in sidepanel.css, once per theme. Check that every one is there and can
// be told apart where it is drawn: chips and lines on the background and on the hover, selected
// and active fills; the count, drawn in the background colour, on the chip; each shade apart from
// the next; and every shade apart from the accent of focus rings and drop lines.
const css = await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
const [light, dark] = css.split('@media (prefers-color-scheme: dark)');
const THEMES = {
  light: { block: light, bg: '#ffffff', fg: '#1f1f1f', active: '#d3e3fd', accent: '#0b57d0', hover: ['#1f1f1f', 0.06], selected: ['#0b57d0', 0.08] },
  dark: { block: dark, bg: '#1f1f1f', fg: '#e3e3e3', active: '#004a77', accent: '#a8c7fa', hover: ['#e3e3e3', 0.08], selected: ['#a8c7fa', 0.1] },
};

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toHex = (rgb) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
/** `fg` at `alpha` over `bg`, as the browser composites it. */
const over = (bg, [fg, alpha]) => toHex(channels(bg).map((c, i) => channels(fg)[i] * alpha + c * (1 - alpha)));

function contrast(a, b) {
  const luminance = (hex) => {
    const [r, g, bl] = channels(hex).map(linear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Distance in OKLab: about 0.02 is just noticeable. */
function distance(a, b) {
  const oklab = (hex) => {
    const [r, g, bl] = channels(hex).map(linear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const [p, q] = [oklab(a), oklab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

for (const [theme, t] of Object.entries(THEMES)) {
  test(`every tree colour has three shades that read on every fill in the ${theme} theme`, () => {
    const fills = { background: t.bg, active: t.active, hover: over(t.bg, t.hover), selected: over(t.bg, t.selected) };
    for (const color of TREE_COLORS) {
      const shades = [0, 1, 2].map((shade) => t.block.match(new RegExp(`--tree-${color}-${shade}: (#[0-9a-f]{6});`))?.[1]);
      shades.forEach((hex, shade) => {
        const name = `--tree-${color}-${shade} ${hex}`;
        assert.ok(hex, `--tree-${color}-${shade} is missing`);
        assert.ok(contrast(hex, t.bg) >= 4.5, `${name}: the count on the chip is ${contrast(hex, t.bg).toFixed(2)}:1`);
        for (const [fill, value] of Object.entries(fills)) {
          assert.ok(contrast(hex, value) >= 3, `${name} on the ${fill} fill: ${contrast(hex, value).toFixed(2)}:1`);
        }
        assert.ok(distance(hex, t.accent) >= 0.06, `${name} is too close to the accent: ${distance(hex, t.accent).toFixed(3)}`);
        if (shade) {
          const step = distance(hex, shades[shade - 1]);
          assert.ok(step >= 0.08, `${name} is too close to the shade before it: ${step.toFixed(3)}`);
        }
      });
    }
    assert.match(t.block, /--chip-hover: rgba\(/);
  });
}
