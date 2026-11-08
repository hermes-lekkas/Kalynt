/* Owner-only traffic remains in stdout; this script never publishes it. */
import { execFileSync } from 'node:child_process';
const repo = 'hermes-lekkas/Kalynt';
const read = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
const optional = endpoint => { try { return read(endpoint); } catch { return { unavailable: true }; } };
const repository = read(`repos/${repo}`);
const releases = read(`repos/${repo}/releases?per_page=100`);
const output = {
  fetchedAt: new Date().toISOString(),
  repository: repo,
  stars: repository.stargazers_count,
  views: optional(`repos/${repo}/traffic/views`),
  clones: optional(`repos/${repo}/traffic/clones`),
  releases: releases.filter(r => !r.draft).map(r => ({
    tag: r.tag_name, publishedAt: r.published_at,
    assets: r.assets.filter(a => /\.(exe|dmg|deb|appimage|zip)$/i.test(a.name)).map(a => ({ id: a.id, name: a.name, downloads: a.download_count, updatedAt: a.updated_at }))
  })),
  notes: ['Asset fetches are not unique users.', 'Traffic covers a rolling window; daily uniques overlap.', 'Website conversion and retention are not measured by these sources.']
};
console.log(JSON.stringify(output, null, 2));
