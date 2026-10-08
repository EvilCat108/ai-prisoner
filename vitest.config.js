import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    testTimeout: 30000,
    poolOptions: {
      workers: {
        // Disable per-test storage isolation: the Umpire DO's pending
        // .sqlite-shm files trip the suite-level storage pop assertion in
        // @cloudflare/vitest-pool-workers@0.6.16 (no evictAllDurableObjects
        // helper is exposed by cloudflare:test in that version).
        // D1 tables are still cleaned by the test's own beforeEach.
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});
