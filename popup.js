const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const versionEl = document.getElementById('version');

versionEl.textContent = chrome.runtime.getManifest().version;

function render(enabled) {
  toggle.checked = enabled;
  status.textContent = enabled ? 'Showing badges' : 'Disabled';
}

(async () => {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  render(enabled);
})();

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  await chrome.storage.local.set({ enabled });
  render(enabled);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) {
    render(changes.enabled.newValue !== false);
  }
});
