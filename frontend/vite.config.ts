import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 后端 API 路径列表（与 src/index.ts 中 Hono 路由对齐）
// 注意：前端使用 HashRouter，SPA 路由形如 /#/admin/users，
//       不会与下面的 /admin 真实后端路径冲突，可以安全地整段代理。
const API_PATHS = [
  '/bootstrap',
  '/login',
  '/setup',
  '/nonce',
  '/check',
  '/exits',
  '/apply',
  '/order',
  '/acmes',
  '/token',
  '/erase',
  '/certs',
  '/panel',
  '/users',
  '/tests',
  '/tasks',
  '/clean',
  // 管理员后台（/admin/users、/admin/certs、/admin/confs …）
  '/admin',
  // 开放 API（/api/v1/*）
  '/api',
  // 账号 API Token（/account/apitoken、/account/apitoken/rotate）
  '/account',
  // 证书打包下载
  '/ca_zip',
  '/ca_pfx',
];

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@api': path.resolve(__dirname, 'src/api'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@hooks': path.resolve(__dirname, 'src/hooks'),
      '@layouts': path.resolve(__dirname, 'src/layouts'),
      '@pages': path.resolve(__dirname, 'src/pages'),
      '@stores': path.resolve(__dirname, 'src/stores'),
      '@theme': path.resolve(__dirname, 'src/theme'),
      '@utils': path.resolve(__dirname, 'src/utils'),
    },
  },

  css: {
    postcss: './postcss.config.js',
  },

  build: {
    outDir: '../public',
    emptyOutDir: false, // 保留 public/static 等旧资源
    assetsDir: 'assets',
    cssCodeSplit: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    // ⚠️ **不要手动 manualChunks 拆分 vendor**（2026-10-21 两次踩坑）：
    //   把 react / antd / utils 拆成三个 chunk 后，Rollup 为共享模块生成的 import 关系
    //   会随代码改动在"单向"和"循环"之间来回变：
    //     · 27043be（全 lazy）        → antd 是根，单向，正常
    //     · b1233ea（同步 import 页面）→ antd → utils → antd，循环 → 白屏
    //     · 只保留 b1233ea 的动画改动  → 依然循环（main.tsx 引入 MotionConfig 也改变依赖图）
    //   循环时 `vendor-antd` 顶层读 `React.__SECRET_INTERNALS_...` 得到 undefined，
    //   整个入口崩掉 → 全站白屏。
    //   根因是这些包本身双向依赖（antd→dayjs 在 utils、framer-motion 在 utils→react），
    //   手动分组无法稳定保证无环。交给 Rollup 自动分包，它保证初始化顺序正确。
    //   代价：vendor 合并成一个大 chunk（gzip 约 490KB），但首屏本来就要下这些代码。
  },

  server: {
    port: 5173,
    host: '127.0.0.1',
    open: false,
    proxy: Object.fromEntries(
      API_PATHS.map((p) => [
        p,
        {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true,
          secure: false,
        },
      ]),
    ),
  },

  preview: {
    port: 4173,
    host: '127.0.0.1',
  },
});
