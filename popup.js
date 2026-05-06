const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const versionEl = document.getElementById('version');
const keyInput = document.getElementById('key-input');
const keyState = document.getElementById('key-state');
const keySave = document.getElementById('key-save');
const keyClear = document.getElementById('key-clear');

versionEl.textContent = chrome.runtime.getManifest().version;

function renderEnabled(enabled) {
  toggle.checked = enabled;
  status.textContent = enabled ? 'Showing badges' : 'Disabled';
}

function renderKey(key) {
  const has = !!(key && key.trim());
  keyInput.value = has ? key : '';
  keyInput.placeholder = has ? '' : 'Paste your OpenSea API key';
  keyState.textContent = has ? 'using your key' : 'auto-managed';
  keyState.classList.toggle('settings__state--active', has);
}

(async () => {
  const { enabled = true, opensea_user_key = '' } = await chrome.storage.local.get([
    'enabled',
    'opensea_user_key',
  ]);
  renderEnabled(enabled);
  renderKey(opensea_user_key);
})();

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  await chrome.storage.local.set({ enabled });
  renderEnabled(enabled);
});

keySave.addEventListener('click', async () => {
  const v = keyInput.value.trim();
  await chrome.storage.local.set({ opensea_user_key: v });
  renderKey(v);
});

keyClear.addEventListener('click', async () => {
  await chrome.storage.local.set({ opensea_user_key: '' });
  renderKey('');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) renderEnabled(changes.enabled.newValue !== false);
  if (changes.opensea_user_key) renderKey(changes.opensea_user_key.newValue || '');
});
