import { mkdir, copyFile, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const source=resolve('node_modules/@fontsource-variable/noto-sans-jp');
await mkdir('public/fonts',{recursive:true});
await copyFile(`${source}/index.css`,'public/fonts/noto.css');
await copyFile(`${source}/LICENSE`,'public/fonts/LICENSE.txt');
await cp(`${source}/files`,'public/fonts/files',{recursive:true});

// Precache only the font subsets needed by the offline screen.
const css=await readFile(`${source}/index.css`,'utf8');
const points=[...new Set('オフライン再読み込み ')].map(c=>c.codePointAt(0));
const offlineFonts=new Set();
for(const [,block] of css.matchAll(/@font-face\s*\{([^}]+)\}/gu)){
  const ranges=block.match(/unicode-range:\s*([^;]+)/u)?.[1];
  const file=block.match(/url\(['"]?(\.\/files\/[^)'" ]+)/u)?.[1];
  if(!ranges||!file)continue;
  if(ranges.split(',').some(range=>{const [start,end]=range.trim().replace(/^U\+/iu,'').split('-').map(v=>Number.parseInt(v,16));return points.some(point=>point>=start&&point<=(end??start));}))offlineFonts.add('/fonts/'+file.slice(2));
}
if(!offlineFonts.size)throw new Error('Offline font subsets were not found.');
await writeFile('public/pwa-fonts.json',JSON.stringify([...offlineFonts]));
