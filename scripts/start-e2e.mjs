import { spawnSync,spawn } from 'node:child_process';
import { mkdirSync,mkdtempSync } from 'node:fs';
mkdirSync('.cloudflare/e2e',{recursive:true});
const state=mkdtempSync('.cloudflare/e2e/run-');
const env={...process.env,APP_TEST_PORT:'4322',VITE_TEST_STATE:state};
for(const args of [['scripts/migrate.mjs','--test']]){const r=spawnSync(process.execPath,args,{env,stdio:'inherit'});if(r.status)process.exit(r.status);}
const child=spawn('npm',['run','dev:test'],{env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??0));
