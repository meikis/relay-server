# Doze Relay 部署指南

## 目录

- [什么是 Doze Relay](#什么是-doze-relay)
- [平台对比](#平台对比)
- [方案一：Railway 部署（推荐）](#方案一railway-部署推荐)
- [方案二：Render 部署](#方案二render-部署)
- [方案三：Fly.io 部署](#方案三flyio-部署)
- [方案四：Docker 自建部署](#方案四docker-自建部署)
- [方案五：Vercel（不适用）](#方案五vercel不适用)
- [部署后验证](#部署后验证)
- [配置认证 Token（可选）](#配置认证-token可选)
- [部署后使用流程](#部署后使用流程)
- [常见问题](#常见问题)

---

## 什么是 Doze Relay

```
  豆包客户端 ──HTTP──→ Doze Relay (公网) ←──WebSocket── OpenMinis doze-server
                        (本文件)           (出站连接，无需公网IP)
```

Doze Relay 是一个部署在公网的**中继服务器**，解决 OpenMinis 没有公网 IP 的问题：

1. OpenMinis 上的 doze-server 通过 WebSocket **主动连接** Relay（出站连接，无需公网 IP）
2. 豆包客户端发 HTTP 请求到 Relay 的公网地址
3. Relay 通过 WebSocket 把请求转发给 doze-server
4. doze-server 处理后把响应通过 WebSocket 发回 Relay
5. Relay 把响应返回给客户端

**核心原理**：WebSocket 反向连接。只要 OpenMinis 能访问互联网，就能建立连接。

---

## 平台对比

| 平台 | 免费额度 | WebSocket | SSE 流式 | 冷启动 | 部署难度 | 推荐度 |
|------|---------|-----------|---------|--------|---------|--------|
| **Railway** | $5/月额度（约 500h） | ✅ | ✅ | 无 | ⭐ 最简单 | ⭐⭐⭐⭐⭐ |
| **Render** | 750h/月 | ✅ | ✅ | 15 分钟休眠后 30-60s | ⭐⭐ 简单 | ⭐⭐⭐⭐ |
| **Fly.io** | 3 VM + 3GB 流量 | ✅ | ✅ | 按需启停，几秒 | ⭐⭐⭐ 中等 | ⭐⭐⭐⭐ |
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
   - 在 Variables 页签中添加（可选）：
     ```
     DOZE_RELAY_TOKEN=your-secret-token   # 可选，设置认证 Token
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

- 管理面板：`https://doze-relay-production.up.railway.app/`
- 健康检查：`https://doze-relay-production.up.railway.app/health`
- WebSocket 地址：`wss://doze-relay-production.up.railway.app/ws`

---

## 方案二：Render 部署

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
- WebSocket 连接在休眠时会断开，doze-server 会自动重连
- 如需不休眠，升级到 Starter 套餐（$7/月）

### 部署后

- 管理面板：`https://doze-relay.onrender.com/`
- 健康检查：`https://doze-relay.onrender.com/health`
- WebSocket 地址：`wss://doze-relay.onrender.com/ws`

---

## 方案三：Fly.io 部署

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

### 部署后

- 管理面板：`https://doze-relay.fly.dev/`
- 健康检查：`https://doze-relay.fly.dev/health`
- WebSocket 地址：`wss://doze-relay.fly.dev/ws`

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
  -e DOZE_RELAY_TOKEN=your-secret-token \
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
      - DOZE_RELAY_TOKEN=your-secret-token
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
- ❌ 无法维护 doze-server 的持久 WebSocket 连接
- ❌ 没有全局内存状态（每次请求可能分配到不同实例）
- ⚠️ SSE 有 25 秒超时限制

详见 `VERCEL.md`。

### 替代方案

如果你习惯使用 Vercel，可以：
1. 在 Railway / Fly.io 部署 Relay（5 分钟搞定）
2. 其他部分继续使用 Vercel

---

## 部署后验证

部署完成后，验证 Relay 是否正常工作：

```bash
# 1. 健康检查
curl https://your-relay-url.com/health

# 期望输出:
# {"status":"ok","relay":true,"rooms":0,"connections":[],"timestamp":...}

# 2. 打开管理面板
# 浏览器访问 https://your-relay-url.com/
# 应看到 Doze Relay 管理页面，显示"暂无 doze-server 连接"

# 3. 测试 doze-server 连接（本地模拟）
node packages/server/standalone.js --relay wss://your-relay-url.com --room testroom

# 4. 再次检查健康
curl https://your-relay-url.com/health
# 期望输出:
# {"status":"ok","relay":true,"rooms":1,"connections":["testroom"],...}
```

---

## 配置认证 Token（可选）

为了防止未授权访问，可以设置认证 Token。

### 在 Relay 端设置

**Railway**：在 Variables 中添加 `DOZE_RELAY_TOKEN=your-secret`
**Render**：在 Environment 中添加 `DOZE_RELAY_TOKEN=your-secret`
**Fly.io**：`flyctl secrets set DOZE_RELAY_TOKEN=your-secret`
**Docker**：`-e DOZE_RELAY_TOKEN=your-secret`

### 在 doze-server 端传递

```bash
node doze-server.js \
  --relay wss://your-relay-url.com \
  --room myroom \
  --relay-token your-secret \
  --model-api http://localhost:8080/v1
```

### 在客户端传递

```bash
export DOZE_SERVER_TOKEN=your-secret
node client.js --relay=https://your-relay-url.com/r/myroom
```

---

## 部署后使用流程

### 完整使用流程（3 步）

```
┌─────────────────────────────────────────────────────────────┐
│  第 1 步: 部署 Relay（一次性，已完成）                        │
│  → 获得公网地址: https://doze-relay.up.railway.app           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  第 2 步: OpenMinis 启动 doze-server（每次使用）              │
│  → 在 OpenMinis 对话中发送:                                   │
│    "请安装 Doze Server，连接 Relay:                          │
│     wss://doze-relay.up.railway.app, room: myroom,          │
│     model-api: http://localhost:8080/v1,                     │
│     model-key: sk-xxx, model-name: gpt-4o"                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  第 3 步: 豆包客户端连接                                      │
│  → node client.js --relay=https://doze-relay.up.railway.app/r/myroom │
│  → 自动检测 → 连接 → 对话                                    │
└─────────────────────────────────────────────────────────────┘
```

### 第 1 步：部署 Relay（已完成）

见上方各平台部署方案。

### 第 2 步：OpenMinis 启动 doze-server

在 OpenMinis 对话中发送：

```
请安装 Doze Server，使用 Relay 模式：
- Relay 地址: wss://doze-relay.up.railway.app
- Room: myroom
- 模型 API: http://localhost:8080/v1
- API Key: sk-your-key
- 模型名: gpt-4o
```

或者直接在 OpenMinis Shell 中运行：

```bash
# 使用安装脚本
DOZE_RELAY=wss://doze-relay.up.railway.app \
DOZE_ROOM=myroom \
DOZE_MODEL_API=http://localhost:8080/v1 \
DOZE_MODEL_KEY=sk-your-key \
DOZE_MODEL_NAME=gpt-4o \
sh /var/minis/workspace/install-doze.sh

# 或手动启动
nohup node /var/minis/workspace/doze-server.js \
  --relay wss://doze-relay.up.railway.app \
  --room myroom \
  --model-api http://localhost:8080/v1 \
  --model-key sk-your-key \
  --model-name gpt-4o \
  > /var/minis/workspace/doze-server.log 2>&1 &
```

### 第 3 步：豆包客户端连接

```bash
# 进入客户端目录
cd examples/doubao-client

# 安装依赖（首次）
npm install

# 连接 Relay
node src/index.js --relay=https://doze-relay.up.railway.app/r/myroom
```

客户端会自动：
1. 检测 Relay 状态
2. 确认 doze-server 已连接
3. 创建 Bot
4. 开始流式对话

---

## 常见问题

### Q: Relay 部署后无法访问？

```bash
# 检查健康
curl https://your-relay-url/health

# 如果返回 502，说明 doze-server 未连接
# 如果返回超时，说明 Relay 未启动成功
# 查看 Railway/Render/Fly.io 的日志
```

### Q: doze-server 连不上 Relay？

```bash
# 1. 确认 Relay 地址正确（wss:// 不是 ws://）
# 2. 确认 OpenMinis 可以访问互联网
# 3. 查看 doze-server 日志
cat /var/minis/workspace/doze-server.log

# 4. 手动测试连接
node -e "const ws = new WebSocket('wss://your-relay-url/ws?room=test'); ws.onopen = () => { console.log('connected!'); ws.close(); }; ws.onerror = (e) => console.error('error:', e.message);"
```

### Q: Render 免费套餐休眠怎么办？

- 休眠后 doze-server 会自动重连（3 秒重试）
- 客户端首次请求有 30-60 秒冷启动延迟
- 如需不休眠，升级到 Starter 套餐（$7/月）
- 或使用 UptimeRobot 等服务定时 ping `/health` 保持活跃

### Q: 多个 OpenMinis 设备能同时连接吗？

可以！每个设备使用不同的 `--room` 名称：

```bash
# 设备 A
node doze-server.js --relay wss://relay.app --room device-a --model-api ...

# 设备 B
node doze-server.js --relay wss://relay.app --room device-b --model-api ...
```

客户端分别连接：
```bash
node client.js --relay=https://relay.app/r/device-a
node client.js --relay=https://relay.app/r/device-b
```

### Q: 安全性如何保证？

1. **设置认证 Token**（见上方配置）
2. **使用 HTTPS/WSS**（Railway/Render/Fly.io 自动提供）
3. **使用复杂的 room 名称**（避免被猜到）
4. **Relay 不存储数据**（只转发请求，重启后无残留）

### Q: SSE 流式对话延迟如何？

```
客户端 → Relay:    ~10-50ms（取决于到云平台的延迟）
Relay → doze-server: ~10-50ms（WebSocket 已建立，无额外延迟）
doze-server → 模型API: 取决于模型 API 延迟
```

总延迟与直连相比增加约 20-100ms，对流式对话体验影响很小。
