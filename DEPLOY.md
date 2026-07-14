# Doze Relay 部署指南

## 目录

- [什么是 Doze Relay](#什么是-doze-relay)
- [平台对比](#平台对比)
- [方案一：Railway 部署（推荐）](#方案一railway-部署推荐)
- [方案二：Fly.io 部署](#方案二flyio-部署)
- [方案三：Render 部署](#方案三render-部署)
- [方案四：Docker 自建部署](#方案四docker-自建部署)
- [方案五：Vercel（不适用）](#方案五vercel不适用)
- [环境变量](#环境变量)
- [部署后验证](#部署后验证)
- [使用流程](#使用流程)
- [常见问题](#常见问题)

---

## 什么是 Doze Relay

```
  客户端平台 ──HTTP──→ Doze Relay (公网) ←──WebSocket──→ doze-bridge daemon
  (生成配对命令)       (握手 + 消息路由)                 (spawn Agent 子进程)
```

Doze Relay 是部署在公网的**中继服务器**，模拟 Coze 云的功能：

1. **配对握手**：客户端平台调用 `/api/pair/init` 生成配对命令
2. **Bridge 连接**：用户在本地执行配对命令，doze-bridge 通过 HTTP 握手获取 deviceId，然后建立 WebSocket 长连接
3. **消息路由**：Relay 在客户端平台和 Bridge daemon 之间转发 ACP 消息（对话、文件操作、技能管理等）
4. **Web UI**：内置聊天界面和管理面板，支持 Access Key 登录

---

## 平台对比

| 平台 | 免费额度 | WebSocket | SSE 流式 | 冷启动 | 部署难度 | 推荐度 |
|------|---------|-----------|---------|--------|---------|--------|
| **Railway** | $5/月额度（约 500h） | ✅ | ✅ | 无 | ⭐ 最简单 | ⭐⭐⭐⭐⭐ |
| **Fly.io** | 3 VM + 3GB 流量 | ✅ | ✅ | 按需启停，几秒 | ⭐⭐⭐ 中等 | ⭐⭐⭐⭐ |
| **Render** | 750h/月 | ✅ | ✅ | 15 分钟休眠后 30-60s | ⭐⭐ 简单 | ⭐⭐⭐⭐ |
| **Docker 自建** | 取决于你的服务器 | ✅ | ✅ | 无 | ⭐⭐⭐ 中等 | ⭐⭐⭐ |
| **Vercel** | 100GB 带宽 | ❌ | ⚠️ 有限 | 每次 0-1s | — | ❌ 不适用 |

**推荐顺序**：Railway > Fly.io > Render > Docker 自建

---

## 方案一：Railway 部署（推荐）

Railway 是最简单的方案，支持 WebSocket，无冷启动，部署只需几步。

### 前提

- GitHub 账号
- 本项目代码已推送到 GitHub 仓库

### 步骤

#### 方式 A：通过 Railway 网页部署（最简单）

1. **打开 Railway**
   - 访问 https://railway.app
   - 使用 GitHub 登录

2. **创建项目**
   - 点击 **New Project**
   - 选择 **Deploy from GitHub repo**
   - 选择你的 `coze-api` 仓库
   - 设置 **Root Directory** 为 `packages/server/deploy`

3. **配置环境变量**
   - 在 Variables 页签中添加：
     ```
     DOZE_ACCESS_KEY=your-access-key-123   # 必须设置，保护 Web UI 和 API
     ```
   - `PORT` 由 Railway 自动注入，无需手动设置

4. **部署**
   - Railway 会自动运行 `npm install && node relay.js`
   - 部署完成后点击 **Settings → Networking → Generate Domain**
   - 获得公网地址：`https://doze-relay-production.up.railway.app`

#### 方式 B：通过 Railway CLI 部署

```bash
# 1. 安装 Railway CLI
npm install -g @railway/cli

# 2. 登录
railway login

# 3. 进入部署目录
cd packages/server/deploy

# 4. 创建项目并部署
railway init --name doze-relay
railway up

# 5. 生成公网域名
railway domain
```

#### 方式 C：一键脚本

```bash
cd packages/server/deploy
./deploy-relay.sh railway
```

### 部署后

你会获得一个地址，如 `https://doze-relay-production.up.railway.app`

- 管理面板：`https://doze-relay-production.up.railway.app/`（需输入 Access Key 登录）
- 健康检查：`https://doze-relay-production.up.railway.app/health`
- 配对初始化：`POST https://doze-relay-production.up.railway.app/api/pair/init`
- Frontier WS：`wss://doze-relay-production.up.railway.app/frontier`

---

## 方案二：Fly.io 部署

Fly.io 提供全球边缘节点，支持按需启停，免费套餐包含 3 个 VM。

### 前提

- 安装 flyctl：https://fly.io/docs/hands-on/install-flyctl/
  ```bash
  # macOS
  brew install flyctl

  # Linux
  curl -L https://fly.io/install.sh | sh

  # Windows (PowerShell)
  pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
  ```

### 步骤

```bash
# 1. 登录
flyctl auth login

# 2. 进入部署目录
cd packages/server/deploy

# 3. 创建应用（使用已有的 fly.toml）
flyctl launch --no-deploy --dockerfile Dockerfile --name doze-relay

# 4. 部署
flyctl deploy

# 5. 查看应用信息
flyctl info

# 6. 打开公网访问（如果还没有）
flyctl apps open
```

### 或使用一键脚本

```bash
cd packages/server/deploy
./deploy-relay.sh fly
```

### 选择区域

部署时选择离你最近的区域：

| 区域代码 | 位置 | 延迟（中国） |
|---------|------|------------|
| `nrt` | 东京 | ~50ms |
| `hkg` | 香港 | ~40ms |
| `sin` | 新加坡 | ~60ms |
| `sfo` | 旧金山 | ~150ms |

在 `fly.toml` 中修改 `primary_region` 即可。

---

## 方案三：Render 部署

Render 提供免费的 Web Service，支持 WebSocket。免费套餐每月 750 小时，但 15 分钟无请求会休眠。

### 步骤

#### 方式 A：通过 Blueprint 部署

1. **推送代码到 GitHub**
   - 确保仓库中有 `packages/server/deploy/render.yaml`

2. **创建 Blueprint**
   - 访问 https://dashboard.render.com/blueprints
   - 选择你的 GitHub 仓库
   - Render 会自动识别 `render.yaml` 配置
   - 点击 **Apply**

3. **等待部署完成**
   - 获得地址：`https://doze-relay.onrender.com`

#### 方式 B：手动创建

1. 访问 https://dashboard.render.com/create
2. 选择 **Web Service**
3. 连接 GitHub 仓库
4. 填写配置：
   - **Name**: `doze-relay`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node relay.js`
   - **Health Check Path**: `/health`
5. 选择 **Free** 套餐
6. 点击 **Create Web Service**

### 注意事项

- ⚠️ 免费套餐 15 分钟无请求会**自动休眠**
- 首次请求有 **30-60 秒冷启动延迟**
- WebSocket 连接在休眠时会断开，doze-bridge 会自动重连
- 如需不休眠，升级到 Starter 套餐（$7/月）

---

## 方案四：Docker 自建部署

如果你有自有服务器（VPS / 云主机），可以使用 Docker 部署。

### 步骤

```bash
# 1. 进入部署目录
cd packages/server/deploy

# 2. 构建镜像
docker build -t doze-relay .

# 3. 运行容器
docker run -d \
  --name doze-relay \
  -p 4000:4000 \
  --restart unless-stopped \
  -e DOZE_ACCESS_KEY=your-access-key-123 \
  doze-relay

# 4. 验证
curl http://localhost:4000/health
```

### 或使用 Docker Compose

创建 `docker-compose.yml`：

```yaml
version: '3'
services:
  doze-relay:
    build: .
    ports:
      - "4000:4000"
    environment:
      - DOZE_ACCESS_KEY=your-access-key-123
    restart: unless-stopped
```

```bash
docker-compose up -d
```

### Nginx 反向代理（推荐）

如果需要 HTTPS，使用 Nginx 反向代理 + Let's Encrypt：

```nginx
server {
    listen 80;
    server_name relay.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
# 使用 certbot 获取免费 SSL 证书
sudo certbot --nginx -d relay.yourdomain.com
```

---

## 方案五：Vercel（不适用）

### 为什么 Vercel 不能用？

Doze Relay 依赖 **WebSocket 服务器** 和 **长连接 SSE**，而 Vercel 是 Serverless 平台：

- ❌ 不支持 WebSocket 服务器（函数执行完即销毁）
- ❌ 无法维护 Bridge daemon 的持久 WebSocket 连接
- ❌ 没有全局内存状态（每次请求可能分配到不同实例）
- ⚠️ SSE 有 25 秒超时限制

详见 `VERCEL.md`。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4000` | 监听端口（Railway/Render 自动注入） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DOZE_ACCESS_KEY` | (无) | **访问密钥**，保护 Web UI 和所有 `/api/*` 端点。生产环境必须设置。 |

### 各平台设置方式

| 平台 | 方式 |
|------|------|
| **Railway** | Dashboard → Variables |
| **Fly.io** | `flyctl secrets set DOZE_ACCESS_KEY=your-access-key` |
| **Render** | Dashboard → Environment |
| **Docker** | `-e DOZE_ACCESS_KEY=your-access-key` |

---

## 部署后验证

部署完成后，验证 Relay 是否正常工作：

```bash
# 1. 健康检查
curl https://your-relay-url.com/health

# 期望输出:
# {"status":"ok","relay":true,"devices":0,"pairCodes":0,"rooms":0,"timestamp":...}

# 2. 打开 Web UI
# 浏览器访问 https://your-relay-url.com/
# 输入 Access Key 登录，即可使用聊天界面和管理功能

# 3. 生成配对命令
# 方法 A: 在 Web UI 中点击「配对」按钮
# 方法 B: 通过 API

curl -X POST https://your-relay-url.com/api/pair/init \
  -H "Authorization: Bearer YOUR_ACCESS_KEY"

# 期望输出:
# {"ok":true,"pair_code":"xxxx-xxxxxx","pat_token":"sat_xxx","command":"npx -y doze-bridge ..."}
```

---

## 使用流程

### 完整使用流程（3 步）

```
┌─────────────────────────────────────────────────────────────┐
│  第 1 步: 部署 Relay（一次性）                                │
│  → 获得公网地址: https://doze-relay.up.railway.app           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  第 2 步: 生成配对命令并执行                                   │
│  → POST /api/pair/init 获取配对命令                           │
│  → 在本地机器执行: npx -y doze-bridge --pat-token=...        │
│  → Bridge daemon 自动: 握手 → WS 连接 → Agent 探测 → OS 自启  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  第 3 步: 客户端平台调用 Agent                                 │
│  → POST /api/agents/:agentId/prompt (SSE 流式对话)            │
│  → GET  /api/agents/:agentId/files (文件树)                   │
│  → GET  /api/agents/:agentId/skills (技能列表)                │
└─────────────────────────────────────────────────────────────┘
```

### 第 1 步：部署 Relay（已完成）

见上方各平台部署方案。

### 第 2 步：生成配对命令并执行

```bash
# 1. 客户端平台调用 Relay API 生成配对命令
curl -X POST https://doze-relay.up.railway.app/api/pair/init \
  -H "Authorization: Bearer YOUR_ACCESS_KEY"

# 返回:
# {
#   "ok": true,
#   "pair_code": "a1b2-c3d4e5",
#   "pat_token": "sat_xxx...",
#   "command": "npx -y doze-bridge --pat-token=sat_xxx --pair-code=a1b2-c3d4e5 --relay-url=https://doze-relay.up.railway.app",
#   "expires_in": 600
# }

# 2. 用户在本地机器（有 Claude Code / OpenClaw / Codex 的机器）执行配对命令
npx -y doze-bridge --pat-token=sat_xxx --pair-code=a1b2-c3d4e5 --relay-url=https://doze-relay.up.railway.app

# 3. Bridge daemon 自动完成:
#    HTTP 握手 → WebSocket 连接 → Agent 探测 → OS 自启
```

### 第 3 步：客户端平台调用 Agent

```bash
# 列出已连接的 Agent
curl -H "Authorization: Bearer YOUR_ACCESS_KEY" \
  https://doze-relay.up.railway.app/api/agents

# 发送对话 (SSE 流式)
curl -N -X POST https://doze-relay.up.railway.app/api/agents/agent_xxx/prompt \
  -H "Authorization: Bearer YOUR_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'

# 创建新 Agent
curl -X POST https://doze-relay.up.railway.app/api/agents \
  -H "Content-Type: application/json" \
  -d '{"framework":"claude-code","agent_id":"my-agent"}'

# 获取文件树
curl https://doze-relay.up.railway.app/api/agents/agent_xxx/files

# 获取技能列表
curl https://doze-relay.up.railway.app/api/agents/agent_xxx/skills
```

---

## 常见问题

### Q: Relay 部署后无法访问？

```bash
# 检查健康
curl https://your-relay-url/health

# 如果返回超时，说明 Relay 未启动成功
# 查看 Railway/Render/Fly.io 的日志
```

### Q: Bridge daemon 连不上 Relay？

```bash
# 1. 确认 Relay 地址正确 (https:// 不是 http://)
# 2. 确认本地机器可以访问互联网
# 3. 查看 Bridge daemon 日志
cat ~/.doze/bridge/bridge.log

# 4. 确认配对码未过期 (10 分钟有效期)
curl -X POST https://your-relay-url/api/pair/init
# 重新获取配对命令并执行
```

### Q: Render 免费套餐休眠怎么办？

- 休眠后 Bridge daemon 会自动重连（指数退避重试）
- 客户端首次请求有 30-60 秒冷启动延迟
- 如需不休眠，升级到 Starter 套餐（$7/月）
- 或使用 UptimeRobot 等服务定时 ping `/health` 保持活跃

### Q: 多个设备能同时连接吗？

可以！每个设备执行不同的配对命令（不同的 `pair_code`），Relay 会为每个设备分配独立的 `deviceId`。

```bash
# 设备 A
npx -y doze-bridge --pat-token=sat_aaa --pair-code=code-a --relay-url=https://relay.app

# 设备 B
npx -y doze-bridge --pat-token=sat_bbb --pair-code=code-b --relay-url=https://relay.app
```

### Q: 安全性如何保证？

1. **设置 Access Key**（`DOZE_ACCESS_KEY` 环境变量）— 所有 API 端点和 Web UI 需要登录
2. **使用 HTTPS/WSS**（Railway/Render/Fly.io 自动提供）
3. **配对码一次性使用**，10 分钟过期
4. **Relay 不存储数据**（只转发消息，重启后无残留）

### Q: SSE 流式对话延迟如何？

```
客户端 → Relay:       ~10-50ms（取决于到云平台的延迟）
Relay → Bridge:       ~10-50ms（WebSocket 已建立，无额外延迟）
Bridge → Agent:       取决于 Agent 处理时间
```

总延迟与直连相比增加约 20-100ms，对流式对话体验影响很小。

### Q: 旧版 doze-server 还能用吗？

旧版 `/ws` + `/r/:room` 兼容模式已移除。请使用新版配对流程：

```bash
# 生成配对命令
curl -X POST https://your-relay-url/api/pair/init \
  -H "Authorization: Bearer YOUR_ACCESS_KEY"

# 在本地执行配对命令
npx -y doze-bridge --pat-token=sat_xxx --pair-code=xxxx \
  --relay-url=https://your-relay-url
```
