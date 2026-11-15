import { spawnSync } from 'node:child_process';
const test=process.argv.includes('--test');
const local=!process.argv.includes('--remote');
const database=local?(test?'00000000-0000-4000-8000-000000000001':'00000000-0000-4000-8000-000000000002'):process.env.D1_DATABASE_ID;
if(!database)throw new Error('D1_DATABASE_IDを設定してください。');
const args=['cf','d1','migrations','apply',database,...(local?['--local']:[]),'--mode',test?'test':local?'development':'production',...(process.env.VITE_TEST_STATE?['--persist-to',process.env.VITE_TEST_STATE]:[])];
const result=spawnSync('npx',args,{stdio:'inherit',env:process.env});process.exit(result.status??1);
