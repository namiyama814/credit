import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';

// Change the worker bytes whenever a public build asset changes, including the
// offline page. Installation then fills a fresh cache before old caches expire.
const root = resolve('dist/web');
const files = [];
async function collect(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await collect(path);
    else if (item.isFile() && item.name !== 'sw.js' && !item.name.startsWith('.')) files.push(path);
  }
}
await collect(root);
if (!files.length) throw new Error('Build the web assets before versioning the service worker.');
const hash = createHash('sha256');
for (const path of files.sort()) {
  hash.update(relative(root, path).replaceAll('\\', '/'));
  hash.update('\0');
  hash.update(await readFile(path));
}
const cache = 'info1-shell-' + hash.digest('hex').slice(0, 20);
const source = await readFile('public/sw.js', 'utf8');
if (!source.includes("const CACHE = 'info1-shell-v1';")) throw new Error('Service worker cache marker was not found.');
await writeFile(join(root, 'sw.js'), source.replace("const CACHE = 'info1-shell-v1';", `const CACHE = '${cache}';`));
