import { defineConfig,devices } from '@playwright/test';
export default defineConfig({testDir:'tests/e2e',workers:1,timeout:45000,use:{baseURL:'http://127.0.0.1:4322',trace:'retain-on-failure'},projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],webServer:{command:'node scripts/start-e2e.mjs',url:'http://127.0.0.1:4322/health',reuseExistingServer:false,timeout:60000}});
