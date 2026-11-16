import { it, expect } from 'vitest';
import { deploymentIssues } from '../scripts/check-deploy.mjs';
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111', OAUTH_KV_ID: 'b'.repeat(32) };
const secrets = 'GITHUB_CLIENT_ID="Iv1.synthetic-client"\nGITHUB_CLIENT_SECRET="synthetic-private-value"';
it('必要な本番設定を確認し、秘密情報を診断へ含めない', () => {
  expect(deploymentIssues(env, secrets)).toEqual([]);
  const issues = deploymentIssues({}, secrets + '\nUNRELATED_SECRET="private-extra"');
  expect(issues).toContain('D1_DATABASE_ID');
  expect(issues.some(value => value.includes('.dev.vars'))).toBe(true);
  expect(JSON.stringify(issues)).not.toMatch(/synthetic-private-value|private-extra/u);
});
it('雛形・未設定・空の上書き値ではデプロイできない', () => {
  expect(deploymentIssues(env, 'GITHUB_CLIENT_ID="replace-with-your-client-id"')).toEqual(['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']);
  expect(deploymentIssues({ ...env, GITHUB_CLIENT_SECRET: '' }, secrets)).toEqual(['GITHUB_CLIENT_SECRET']);
  expect(deploymentIssues(env, 'GITHUB_CLIENT_ID=real-client\nGITHUB_CLIENT_SECRET="$HOME"')).toEqual(['GITHUB_CLIENT_SECRET']);
});
