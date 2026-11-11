// Settings page: the tab group settings (see groups.js), kept in chrome.storage.local. The worker
// and the panels watch them, so a change applies at once.

import { readSettings } from './groups.js';

const form = document.getElementById('settings');

function show(settings) {
  for (const [name, value] of Object.entries(settings)) {
    const input = form.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  }
}

form.addEventListener('change', async () => {
  const data = new FormData(form);
  const settings = readSettings({ groups: data.get('groups'), ownGroups: data.get('ownGroups') });
  await chrome.storage.local.set({ settings });
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.settings) show(readSettings(changes.settings.newValue));
});

show(readSettings((await chrome.storage.local.get('settings')).settings));
