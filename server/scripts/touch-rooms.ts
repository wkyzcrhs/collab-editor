/**
 * touch-rooms.ts — 调试用：模拟一个无缓存的全新客户端逐个访问房间，
 * 触发服务端的默认内容初始化（用于验证初始化逻辑，替代手动开浏览器）
 * 用法：服务端运行中，npx tsx scripts/touch-rooms.ts
 */
import WebSocket from 'ws';

const rooms = ['prd', 'meeting', 'todo', 'daily', 'doc-test1'];
for (const room of rooms) {
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://localhost:8787/${room}?clientId=999999`);
    ws.on('open', () => {
      setTimeout(() => {
        ws.close();
        resolve();
      }, 800);
    });
    ws.on('error', () => resolve());
  });
  console.log(`touched room: ${room}`);
}
process.exit(0);
