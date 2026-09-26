# 部署指南：阿里云/腾讯云香港轻量 + 宝塔面板

> 目标：把协同编辑器部署到公网，支持 HTTPS + WebSocket，面试官点开网址就能用。
> 预计耗时：1~2 小时（含买服务器、解析域名、申请证书）

---

## 一、购买服务器

### 1.1 选购

- **平台**：阿里云轻量应用服务器 / 腾讯云轻量应用服务器（二选一，哪个便宜买哪个）
- **地域**：**香港**（不用备案，国内访问也还行）
- **镜像**：**Ubuntu 22.04 LTS**（别选带环境的，纯净系统就行）
- **配置**：2核2G 起步（够跑 Node.js + Nginx + PM2），带宽 3M 以上
- **时长**：先买 1 个月试试水

### 1.2 拿到服务器后

拿到 **公网 IP** 和 **root 密码**（或 SSH 密钥），先在控制台**开放安全组/防火墙端口**：

| 端口 | 用途 | 必须 |
|------|------|------|
| 22 | SSH 远程连接 | ✅ |
| 80 | HTTP | ✅ |
| 443 | HTTPS | ✅ |
| 8787 | 后端 Node.js（仅宝塔反代用，可不开） | ❌（走 Nginx 反代不需要对外开） |
| 8888 | 宝塔面板默认端口 | ✅（装完宝塔后建议改掉） |

> ⚠️ 阿里云/腾讯云的"安全组"和系统防火墙是两层，安全组一定要在网页控制台里开。

---

## 二、安装宝塔面板

### 2.1 SSH 连上去

```bash
# 本地终端（Windows 用 PowerShell / CMD / FinalShell 都行）
ssh root@你的服务器IP
# 输入密码
```

### 2.2 装宝塔（Ubuntu 专用命令）

```bash
wget -O install.sh https://download.bt.cn/install/install-ubuntu_6.0.sh && sudo bash install.sh ed8484bec
```

大概 5~10 分钟，装完会显示：
- 面板地址（`http://IP:8888/一串字母`）
- 用户名和密码

**保存好这三个东西**，然后浏览器打开面板地址登录。

### 2.3 宝塔推荐安装套件

登录后会弹"推荐安装"，选 **LNMP**：

- **Nginx**：选 1.24 或最新稳定版
- **MySQL**：不用装（我们用 LevelDB 文件存储，不需要数据库）❌ 取消
- **PHP**：不用装 ❌ 取消

只装 Nginx 就行，点"一键安装"。

### 2.4 装 PM2 管理器

宝塔左侧菜单 → **软件商店** → 搜索 "PM2" → 安装 "PM2 管理器"。

---

## 三、前端打包与上传

### 3.1 本地打包（已完成）

```bash
cd collab-editor/client
npm run build
```

产物在 `client/dist/` 目录，里面是 `index.html` + `assets/` 文件夹。

### 3.2 上传到服务器

**方式一：宝塔文件管理器（最简单）**

1. 宝塔 → 文件 → `/www/wwwroot/` → 新建文件夹 `collab-editor`
2. 进入 `collab-editor`，上传本地 `client/dist/` 里的所有文件（把 dist 里的内容直接拖进去）

**方式二：scp 命令（推荐，更快）**

```bash
# 在本地项目根目录执行
scp -r collab-editor/client/dist/* root@你的服务器IP:/www/wwwroot/collab-editor/
```

---

## 四、后端部署（PM2 守护进程）

### 4.1 上传后端代码

把 `server/` 目录整个传到服务器 `/www/wwwroot/collab-editor/server/`。

```bash
# 本地执行（排除 node_modules 和 data，省流量）
scp -r collab-editor/server/src root@你的服务器IP:/www/wwwroot/collab-editor/server/
scp collab-editor/server/package.json root@你的服务器IP:/www/wwwroot/collab-editor/server/
scp collab-editor/server/package-lock.json root@你的服务器IP:/www/wwwroot/collab-editor/server/
scp collab-editor/server/.env.example root@你的服务器IP:/www/wwwroot/collab-editor/server/.env
```

或者用宝塔文件管理器上传整个 server 文件夹（记得删掉本地的 `server/node_modules` 和 `server/data` 再传，体积小很多）。

### 4.2 服务器上装依赖

```bash
# SSH 连上去
cd /www/wwwroot/collab-editor/server
npm install
```

### 4.3 配置环境变量

```bash
# 编辑 .env 文件
nano .env
```

写入：

```
PORT=8787
DEEPSEEK_API_KEY=你的DeepSeek密钥
```

按 `Ctrl+O` 保存，`Ctrl+X` 退出。

### 4.4 PM2 启动后端

在宝塔面板里操作：

1. 左侧 → **软件商店** → PM2 管理器 → **设置**
2. 点 **"添加项目"**：
   - **项目名称**：`collab-editor-server`
   - **启动文件**：`/www/wwwroot/collab-editor/server/src/index.ts`
   - **运行目录**：`/www/wwwroot/collab-editor/server`
   - **启动方式**：选 `tsx`（如果没有，先在"模块管理"里装 `tsx`）
   - **环境变量**：留空（从 .env 读）
3. 点"提交"，状态变成"运行中"就 OK

或者命令行方式：

```bash
cd /www/wwwroot/collab-editor/server
npm install -g tsx pm2
pm2 start src/index.ts --name collab-editor-server --interpreter tsx
pm2 save
pm2 startup   # 开机自启
```

### 4.5 验证后端在跑

```bash
curl http://localhost:8787/health
# 应该返回 {"ok":true,"docs":0}
```

---

## 五、域名解析

### 5.1 买域名

- 推荐：阿里云万网 / 腾讯云 DNSPod 买 `.top` 或 `.xyz`，首年几块钱
- 不需要备案（香港服务器）

### 5.2 解析

在域名控制台添加解析记录：

| 主机记录 | 记录类型 | 记录值 |
|---------|---------|--------|
| `@` 或 `www` | A | 你的服务器公网 IP |

等几分钟生效，可以用 `ping 你的域名` 验证是否指向你的 IP。

---

## 六、宝塔建站 + Nginx 配置

### 6.1 新建站点

宝塔 → **网站** → **添加站点**：

- **域名**：填你的域名（比如 `xxx.top`）
- **根目录**：`/www/wwwroot/collab-editor`
- **PHP版本**：纯静态
- **数据库**：不创建
- 提交

### 6.2 配置 Nginx 反向代理 + WebSocket

宝塔 → 网站 → 你的域名 → **配置文件**，把里面的内容全替换成下面这个：

```nginx
server
{
    listen 80;
    server_name 你的域名; # 比如 collab.example.top

    # 前端静态文件
    location / {
        root /www/wwwroot/collab-editor;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # AI 接口反代到后端
    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket 反代到后端（所有 ws:// 请求走 /ws/ 前缀）
    location /ws/ {
        proxy_pass http://127.0.0.1:8787/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }

    # 健康检查
    location = /health {
        proxy_pass http://127.0.0.1:8787/health;
    }

    access_log /www/wwwlogs/collab-editor-access.log;
    error_log /www/wwwlogs/collab-editor-error.log;
}
```

保存，Nginx 会自动重载。

> ⚠️ 注意：前端 WebSocket 地址是 `ws://域名/ws/prd` 这种，Nginx 会把 `/ws/` 去掉后转给后端的 `8787`。
> 所以前端代码里 `useYjsDoc.ts` 的 WebSocket 地址需要改一下，加 `/ws` 前缀。

### 6.3 前端 WebSocket 地址适配

把 `client/src/useYjsDoc.ts` 里的 WebSocket 地址改成根据当前环境走相对路径：

```ts
// 改前
const wsHost = window.location.hostname || 'localhost';
const provider = new WebsocketProvider(
  `ws://${wsHost}:8787`,
  roomName,
  ...
);

// 改后（根据当前页面协议自动选 ws/wss，路径走 /ws/ 前缀让 Nginx 反代）
const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsHost = window.location.host;
const provider = new WebsocketProvider(
  `${wsProto}//${wsHost}/ws`,
  roomName,
  ...
);
```

> 这样本地开发 `localhost:5173` 连 `ws://localhost:8787/` 不对。
> 更好的做法是：**开发环境还是直连 8787，生产环境走 /ws 反代**，用 Vite 环境变量区分。
>
> 在 `client/.env.production` 里加：
> ```
> VITE_WS_PATH=/ws
> ```
>
> 然后代码里：
> ```ts
> const wsPath = import.meta.env.VITE_WS_PATH ?? '';
> const wsUrl = import.meta.env.DEV
>   ? `ws://${window.location.hostname}:8787`
>   : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${wsPath}`;
> ```

改完后**重新打包前端**，再上传一次 dist。

---

## 七、开启 HTTPS

### 7.1 申请 Let's Encrypt 免费证书

宝塔 → 网站 → 你的域名 → **SSL** → **Let's Encrypt**：

- 勾选你的域名
- 邮箱随便填一个
- 点"申请"

几十秒就好。申请成功后：

1. 打开右上角的 **"强制 HTTPS"** 开关
2. 宝塔会自动把 Nginx 配置加上 443 和 301 跳转

### 7.2 验证

浏览器打开 `https://你的域名`：
- 地址栏有小锁 ✅
- 页面加载正常 ✅
- 在线用户能显示 ✅
- AI 助手能对话 ✅

---

## 八、常见坑 & 排查

| 问题 | 排查方向 |
|------|---------|
| 页面打不开 | 安全组 80/443 端口开了吗？Nginx 在跑吗？`systemctl status nginx` |
| WebSocket 连不上 | 浏览器 F12 → Network → WS，看状态码。4xx 是路径不对，5xx 是后端没起来 |
| AI 助手没反应 | 看 `/api/ai/chat` 请求的状态码。500 的话去 PM2 看后端日志 |
| 在线用户不更新 | 确认 WebSocket 是 `wss://`（HTTPS 页面不能连 `ws://`，浏览器会拦） |
| 后端挂了 | PM2 里看日志，大概率是 `.env` 里的 API Key 没配对 |
| 服务器内存不够 | 2G 内存跑 Node + Nginx 够用，但要记得别开别的东西 |

### 常用命令速查

```bash
# 看 PM2 日志
pm2 logs collab-editor-server

# 重启后端
pm2 restart collab-editor-server

# 看 Nginx 错误日志
tail -f /www/wwwlogs/collab-editor-error.log

# 看端口占用
netstat -tlnp | grep 8787
```

---

## 九、部署完成后验证清单

- [ ] 浏览器打开域名，页面正常加载
- [ ] 开两个浏览器窗口，都能看到对方（在线用户 2 人）
- [ ] 同时编辑同一段，CRDT 穿插正确
- [ ] 切换文档，内容各自独立
- [ ] AI 助手能正常回答（当前文档模式 + 工作区模式都试一下）
- [ ] 手机用流量访问也能打开（验证公网可达）
