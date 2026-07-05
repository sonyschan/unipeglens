const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const versionEl = document.getElementById('version');

versionEl.textContent = chrome.runtime.getManifest().version;

function renderEnabled(enabled) {
  toggle.checked = enabled;
  status.textContent = enabled ? 'Active on myupeg.art' : 'Disabled';
}

(async () => {
  const { enabled = true } = await chrome.storage.local.get(['enabled']);
  renderEnabled(enabled);
})();

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  await chrome.storage.local.set({ enabled });
  renderEnabled(enabled);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) renderEnabled(changes.enabled.newValue !== false);
});
