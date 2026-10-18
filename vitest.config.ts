import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Runtime seed of the DSH web shell; never installed here.
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/stubs/dsh-client-ui-primitives.tsx', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 20_000,
    // 插件把学到的能力、上下文窗口和回合轨迹写在 $DSH_HOME/cache 下。测试会真的走 apply()，
    // 不隔离的话就会往用户真实的缓存里塞 mock 路由。
    env: { DSH_HOME: join(tmpdir(), 'dsh-codebuddy-llm-tests') },
  },
})
