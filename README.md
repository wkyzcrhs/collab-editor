# 协同编辑器 · Demo

面向「面试作品：基于 DOM 的简单协同编辑器」的入门友好参考实现（第二版）。

技术栈：
- 前端：React + TypeScript + Vite
- 后端：Node.js + tsx + ws（WebSocket）
- 协同：Yjs（CRDT）+ y-protocols + y-websocket 协议
- UI：类 Notion 风格侧边栏 / 工具栏 / 深色模式 / 5 种块类型

> 演进版本：v1（块锁 + 手写协议）→ **v2（块级 CRDT）** → v3（字符级 CRDT，计划中）
> 查看全部版本：[Tags](https://github.com/wkyzcrhs/collab-editor/tags)

## 快速开始

```bash
# 1. 安装依赖
npm run install:all

# 2. 同时启动 后端(:8787) 与 前端(:5173)
npm run dev

# 3. 打开两个浏览器窗口
#    http://localhost:5173
```

手动分开跑：

```bash
npm --prefix server run start  # ws://localhost:8787
npm --prefix client run dev    # http://localhost:5173
```

**手机 / 局域网访问**：前端默认监听所有地址，启动后用 `Network` 那个 IP 访问（如 `http://192.168.1.7:5173`），WebSocket 地址自动跟随页面域名。

## 已实现功能（对照题目加分项）

| 板块 | 状态 | 说明 |
|---|---|---|
| WebSocket 同步 | ✅ | Yjs sync + update 协议，增量同步 |
| Block / Block ID | ✅ | 每块唯一 ID，块级共享数组 |
| 乐观更新 | ✅ | 本地立即生效，Yjs 后台同步 |
| ACK | ⚠️ 不再需要 | CRDT 最终一致 + 幂等，不需要 ACK 队列 |
| 断线重连 | ✅ | y-websocket 内置自动重连 |
| 操作重试 | ⚠️ 不再需要 | update 消息幂等，重复收到无副作用 |
| Block 锁 | ❌ 已移除 | CRDT 无冲突，不需要锁 |
| 在线用户 | ✅ | Yjs Awareness 协议 |
| 文档版本 | ✅ | 操作累计计数（近似版本号） |
| Undo / Redo | ✅ | Y.UndoManager |
| 冲突处理 | ✅ 块级 CRDT | 不同块完全无冲突；同一块为整块替换（见已知问题） |
| Snapshot 持久化 | ❌ | 内存态 |
| 用户光标 | ❌ | 可基于 Awareness + RelativePosition 扩展 |
| 字符级 CRDT | ❌ 计划中 | 下一站：将 block.text 升级为 Y.Text |

## 已知问题

当前版本为**块级 CRDT**：Block 是 Y.Array 中的共享对象，但每个块的 `text` 仍是普通字符串，修改时整块替换。

因此**两个人同时编辑同一块**会出现重复块——因为"删旧块 + 插新块"是两个 CRDT 操作，双方操作都会被保留。这是块级 CRDT 的天然局限，也是升级到字符级 CRDT（Y.Text）的动机。

> 这是有意为之的中间版本，用于对比和理解 CRDT 的"粒度"问题。详见版本演进。

## 版本演进

| 版本 | Tag | 核心方案 | 特点 |
|---|---|---|---|
| v1 | `v1-block-lock` | 块锁 + 手写协议（乐观更新/ACK/重试/幂等） | 传统方案，易理解 |
| **v2** | **`v2-crdt-block`** | **块级 CRDT（Yjs）** | **去掉锁，但粒度仍为块** |
| v3 | 计划中 | 字符级 CRDT（Y.Text） | 真正的无冲突合并 |

## 目录结构

```
collab-editor/
├─ package.json          # 根：concurrently 一键启动
├─ shared/               # 前后端共享的类型
│  └─ types.ts
├─ server/
│  └─ src/index.ts       # ws 服务端：Yjs 同步协议 + Awareness
└─ client/
   └─ src/
      ├─ useYjsDoc.ts    # 核心 hook：Y.Doc + WebsocketProvider + Awareness
      ├─ Editor.tsx      # 块编辑区 / 工具栏 / 块操作
      ├─ App.tsx         # 侧边栏 / 顶栏 / 状态栏 / 深色模式
      └─ index.css       # 样式（浅色 + 深色主题）
```

## 关键设计说明

**为什么选 CRDT 而不是 OT？**  CRDT 天然支持离线编辑、不需要中央服务器做转换、开源库 Yjs 非常成熟。OT 需要中心化服务端做操作转换，且操作类型越多转换规则越复杂。现在的行业趋势（Figma / Notion / 飞书文档）都在向 CRDT 演进。

**为什么当前是块级而不是字符级？**  这是演进过程中的一步。先用 Block 结构快速跑通 CRDT 的整体流程（同步、Awareness、Undo/Redo），再深入到字符级。块级 CRDT 暴露出来的"同一块并发重复"问题，正是升级到 Y.Text 的理由——有问题、有动机、有解法，完整的思考链条比直接上 Y.Text 更有价值。

## 继续开发方向

按优先级：
1. **字符级 CRDT**：将 `block.text` 从字符串换成 `Y.Text`，解决同一块并发问题
2. **光标同步**：Y.RelativePosition + Awareness，显示远程光标
3. **服务端持久化**：LevelDB / SQLite 存储 Y.Doc 状态
4. **版本快照**：Y.Snapshot 实现版本回退
5. **离线编辑**：y-indexeddb 本地缓存

## License

MIT
