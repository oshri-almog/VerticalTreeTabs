// The look the settings chose (theme, row height, text size, indent: see applyLook in sidepanel.js), set on the page
// before it is first drawn, as the last of the extension's pages that read the settings kept it. A classic script in
// the page's head, so that it runs before the first paint; the page sets the look again once it has read the settings.
try {
  const look = JSON.parse(localStorage.getItem('look') ?? 'null');
  if (look && typeof look === 'object') {
    for (const key of ['theme', 'density', 'textSize', 'indent', 'unread', 'searchBox']) {
      if (typeof look[key] === 'string') document.documentElement.dataset[key] = look[key];
    }
  }
  // The user's own colours, as the panel last applied them (see applyColors in sidepanel.js): for the panel only.
  const colors = location.pathname.endsWith('/sidepanel.html') ? JSON.parse(localStorage.getItem('colors') ?? 'null') : null;
  const names = { bg: '--bg', fg: '--fg', active: '--active', activeFg: '--active-fg', hover: '--hover', accent: '--accent' };
  if (colors?.on && colors.values) {
    document.documentElement.dataset.ownColors = '';
    for (const [key, name] of Object.entries(names)) {
      const value = colors.values[key];
      if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) document.documentElement.style.setProperty(name, value);
    }
    if (colors.gradient && /^#[0-9a-f]{6}$/i.test(colors.gradientTo ?? '')) {
      document.documentElement.style.setProperty('--active-paint', `linear-gradient(90deg, var(--active), ${colors.gradientTo})`);
    }
  }
} catch {
  // nothing kept yet, or no storage for this page
}
