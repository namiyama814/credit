import { mkdir, copyFile, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
const source=resolve('node_modules/@fontsource-variable/noto-sans-jp');
await mkdir('public/fonts',{recursive:true});
await copyFile(`${source}/index.css`,'public/fonts/noto.css');
await copyFile(`${source}/LICENSE`,'public/fonts/LICENSE.txt');
await cp(`${source}/files`,'public/fonts/files',{recursive:true});
