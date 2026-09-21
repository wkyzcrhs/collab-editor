# 协同编辑器 · Demo

面向「面试作品：基于 DOM 的简单协同编辑器」的入门友好参考实现。技术栈：

- **前端**：React + TypeScript + Vite
- **后端**：Node.js + `tsx` + `ws`（WebSocket）
- **共享**：前后端共用 `shared/` 下的协议与块操作逻辑

开放两个浏览器标签页即可体验实时同步。

## 快速开始

```bash
# 1. 安装依赖（根目录 + server + client）
npm run install:all

# 2. 同时启动 后端(:8787) 与 前端(:5173)
npm run dev

# 3. 打开
#    http://localhost:5173   ← 再开一个窗口，即可两浏览器同步
```

手动分开跑：

```bash
npm --prefix server run dev   # ws://localhost:8787
npm --prefix client run dev   # http://localhost:5173
```

## 已实现功能（对照题目 + 加分项清单）

| 板块 | 状态 | 说明 |
| --- | --- | --- |
| WebSocket 同步 | ✅ | 文档状态增量广播（`state` 消息） |
| Block / Block ID | ✅ | 每块唯一 ID，操作按块定位 |
| 乐观更新 | ✅ | 本地立即生效，不等服务端确认 |
| ACK | ✅ | 服务端确认，客户端确认后才出队下一条 |
| 断线重连 | ✅ | 指数退避自动重连 |
| 操作重试 | ✅ | 未确认操作周期性重发，服务端按 opId 幂等去重 |
| Block 锁 | ✅ | 聚焦自动上锁，他人按块只读；失焦/删除自动释放 |
| 在线用户 | ✅ | presence 实时名单 + 每人配色 |
| 文档版本 | ✅ | 服务端维护版本号，随每次操作递增 |
| Undo / Redo | ✅ | 基于 before/after 的本地历史，经操作回放同步 |
| 冲突处理 | ⚠️ 简化 | 块级锁防并发 + 最后写入生效；未用 OT/CRDT |
| Snapshot 持久化 | ❌ | 内存态；可扩展为快照 + 操作日志落库 |
| 用户光标 | ❌ | 可继续扩展（presence 已具备命名/配色基础） |

## 目录结构

```
collab-editor/
├─ package.json          # 根： concurrently 一键启动
├─ shared/
│  ├─ protocol.ts        # 前后端共享的消息类型协议
│  └─ mutate.ts          # 块操作应用逻辑（幂等/一致语义）
├─ server/
│  └─ src/index.ts       # ws 服务端：同步/锁/在线名单/版本
└─ client/
   └─ src/
      ├─ useCollab.ts    # 核心 hook：连接/乐观/ACK/重试/重连
      ├─ Editor.tsx      # 块编辑区 + 锁 + 撤销
      └─ App.tsx         # 头部（在线/版本）+ 页脚说明
```

## 关键设计说明

- **可靠性是「按序队列 + ACK + 重试 + 幂等」**，而不是 OT。对这道题足够：块锁把"同一块并发编辑"挡在门外，少量并发由最后写入兜底。
- **要真正做加分项里的强一致协作**（多人同一块同时编辑不丢字），建议再引入 CRDT（如 [Yjs](https://github.com/yjs/yjs)）替换 replaceText 整段替换、或实现 OT。
- 服务端是内存态、单房间；多文档/持久化可在 `server/src/index.ts` 的 `blocks/version` 处扩展，配合 PostgreSQL/Redis 与 Snapshot。