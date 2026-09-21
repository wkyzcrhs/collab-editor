import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

// 共享协议/操作逻辑在 client 的父级 shared/ 目录，
// 需要把 fs 访问范围放宽到项目根，便于 dev server 读取。
export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [searchForWorkspaceRoot('..')]
    }
  }
});