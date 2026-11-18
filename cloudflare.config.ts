import { bindings, defineConfig, triggers } from 'cf/config';

export default defineConfig(({ mode }) => {
  const test = mode === 'test';
  const development = mode === 'development' || test;
  return {
    ...(process.env.CLOUDFLARE_ACCOUNT_ID ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID } : {}),
    worker: {
      name: test ? `info1-study-test${process.env.APP_TEST_PORT ? '-'+process.env.APP_TEST_PORT : ''}` : 'info1-study',
      entrypoint: './src/server/index.ts',
      compatibilityDate: '2026-11-13',
      compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
      assets: { runWorkerFirst: true, htmlHandling: 'auto-trailing-slash' },
      env: {
        ASSETS: bindings.assets(),
        DB: bindings.d1({ ...(development ? { id: test ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002' } : process.env.D1_DATABASE_ID ? { id: process.env.D1_DATABASE_ID } : {}), name: test ? `info1-study-test${process.env.APP_TEST_PORT ? '-'+process.env.APP_TEST_PORT : ''}` : 'info1-study' }),
        OAUTH_KV: bindings.kv(process.env.OAUTH_KV_ID ? { id: process.env.OAUTH_KV_ID } : {}),
        AI: bindings.ai({ dev: { remote: process.env.AI_REMOTE === 'true' } }),
        APP_ORIGIN: bindings.text(development ? `http://127.0.0.1:${process.env.APP_TEST_PORT ?? '4321'}` : 'https://info1-study.namiyama814.workers.dev'),
        OWNER_GITHUB_ID: bindings.text(process.env.OWNER_GITHUB_ID ?? '253646578'),
        AI_MODEL: bindings.text('@cf/zai-org/glm-4.7-flash'),
        AI_DAILY_NEURONS: bindings.text('8000'),
        APP_MODE: bindings.text(test ? 'test' : development ? 'development' : 'production'),
        GITHUB_CLIENT_ID: test ? bindings.text('test-client') : bindings.secret(),
        GITHUB_CLIENT_SECRET: test ? bindings.text('test-secret') : bindings.secret(),
      },
      triggers: [triggers.scheduled({ schedule: '* * * * *' })],
      observability: { enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: false }, traces: { enabled: true, headSamplingRate: 0.1 } },
    },
  };
});
