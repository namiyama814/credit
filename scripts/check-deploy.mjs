import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

// Return names only. Secret values must never appear in diagnostics.
export function deploymentIssues(env, secretText) {
  const issues = [];
  for (const [name, pattern] of Object.entries({
    CLOUDFLARE_ACCOUNT_ID: /^[a-f0-9]{32}$/i,
    D1_DATABASE_ID: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
    OAUTH_KV_ID: /^[a-f0-9]{32}$/i,
  })) if (!pattern.test(env[name] ?? '')) issues.push(name);
  if (env.OWNER_GITHUB_ID && !/^[1-9]\d*$/u.test(env.OWNER_GITHUB_ID)) issues.push('OWNER_GITHUB_ID');
  let secrets;
  try { secrets = parseEnv(secretText); } catch { return [...issues, '.dev.vars']; }
  const required = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'];
  for (const name of required) {
    const value = env[name] ?? secrets[name];
    if (!value || /replace-with|example|test-client|test-secret|\$/iu.test(value)) issues.push(name);
  }
  // cf uploads every declared key from --secrets-file. Do not upload unrelated values.
  if (Object.keys(secrets).some(key => !required.includes(key))) issues.push('.dev.vars（GitHubの2項目以外）');
  return issues;
}

export async function checkDeployment() {
  const secretText = await readFile('.dev.vars', 'utf8').catch(() => '');
  const issues = deploymentIssues(process.env, secretText);
  if (issues.length) {
    console.error('本番設定が未完了です: ' + issues.join(', '));
    console.error('READMEの本番配置手順を確認してください。秘密情報を出力する必要はありません。');
    return false;
  }
  console.log('本番の接続設定を確認しました。値は表示していません。');
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!await checkDeployment()) process.exitCode = 1;
}
