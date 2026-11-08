/* Public release metadata only. No visitor or product telemetry. */
const suffixes = { windows: '.exe', macos: '.dmg', linux: '.appimage', deb: '.deb' };
async function updateDownloads() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch('https://api.github.com/repos/hermes-lekkas/Kalynt/releases/latest', { signal: controller.signal, credentials: 'omit' });
    if (!response.ok) throw new Error('Release information unavailable');
    const release = await response.json();
    if (!release.tag_name || !Array.isArray(release.assets) || release.prerelease || release.draft) throw new Error('Invalid release');
    const version = String(release.tag_name).replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error('Invalid version');
    document.querySelectorAll('[data-platform]').forEach(link => {
      const asset = release.assets.find(a => typeof a.name === 'string' && a.name.toLowerCase().endsWith(suffixes[link.dataset.platform]));
      if (!asset) {
        link.href = 'https://github.com/hermes-lekkas/Kalynt/releases/latest';
        link.querySelector('.download-action').textContent = 'Check availability ↗';
        return;
      }
      const url = new URL(asset.browser_download_url);
      if (url.origin !== 'https://github.com' || !/^\/hermes-lekkas\/Kalynt\/releases\/download\//i.test(url.pathname)) return;
      link.href = url.href;
      if (typeof asset.size === 'number' && asset.size > 0) link.querySelector('.download-meta').textContent += ` · ${Math.round(asset.size / 1_000_000)} MB`;
    });
    document.querySelectorAll('[data-version]').forEach(label => { label.textContent = `Version ${version}`; });
    document.querySelector('[data-release-label]').textContent = version === '2.0.0' ? '2.0 — the first stable release' : `${version} — available now`;
    document.querySelector('[data-release-status]').textContent = 'Downloads checked against the latest GitHub release.';
  } catch {
    document.querySelector('[data-release-status]').textContent = 'Showing the 2.0.0 downloads. Check release notes for the latest availability.';
  } finally { clearTimeout(timeout); }
}
document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy)?.textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text.trim());
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy ↗'; }, 1800);
    } catch { button.textContent = 'Select and copy the prompt above'; }
  });
});
updateDownloads();
