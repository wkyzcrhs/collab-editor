/**
 * dump-docs.ts — 调试用：直接从 LevelDB 读取每个房间的实际块内容
 * 用法：先停掉服务端（LevelDB 单进程锁），再 npx tsx scripts/dump-docs.ts
 */
import { LeveldbPersistence } from 'y-leveldb';
import * as Y from 'yjs';

const persistence = new LeveldbPersistence('./data');

const rooms = ['prd', 'meeting', 'todo', 'daily', 'doc-test1'];
for (const name of rooms) {
  const ydoc = await persistence.getYDoc(name);
  const blocks = ydoc.getArray<any>('blocks').toArray() as Y.Map<any>[];
  console.log(`\n=== ${name} (${blocks.length} blocks) ===`);
  for (const b of blocks) {
    const t = b.get('text');
    const text = typeof t === 'string' ? t : (t as Y.Text)?.toString() ?? '';
    console.log(`  [${b.get('kind')}] ${text.slice(0, 40)}`);
  }
  ydoc.destroy();
}
process.exit(0);
