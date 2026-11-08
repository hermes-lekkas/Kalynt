import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist/website');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of ['index.html', 'website/styles.css', 'website/main.js']) {
  const destination = path.join(out, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, file), destination);
}
for (const asset of ['Kalynt.png', ...['Editor', 'Settings', 'Diff', 'Team_and_Collaboration'].map(n => `Kalynt_showcase/${n}.png`)]) {
  const target = path.join(out, 'apps/desktop/public', asset);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, 'apps/desktop/public', asset), target);
}
await cp(path.join(root, 'website/fonts'), path.join(out, 'website/fonts'), { recursive: true });
await writeFile(path.join(out, '.nojekyll'), '');
const html = await readFile(path.join(out, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  if (!/^(?:https?:|\.\/)/.test(match[1])) await readFile(path.join(out, match[1]));
}
console.log(`Website built at ${out}`);
