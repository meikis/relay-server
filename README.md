# Doze Relay v2

Cloud relay server — simulates Coze cloud with pairing handshake + Frontier WebSocket protocol.

## Architecture

```
  Client Platform ──HTTP──→ Doze Relay (public) ←──WebSocket──→ doze-bridge daemon
  (generates pair cmd)       (handshake + routing)              (spawns Agent processes)
```

## API Endpoints

### Pairing

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/pair/init` | Generate pair code + command |
| `POST` | `/api/pair` | Bridge daemon handshake |

### Agent Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents` | List connected agents |
| `POST` | `/api/agents` | Create agent (via Bridge daemon) |
| `DELETE` | `/api/agents/:agentId` | Disconnect agent |
| `GET` | `/api/agents/:agentId/files` | File tree |
| `GET` | `/api/agents/:agentId/skills` | List skills |
| `POST` | `/api/agents/:agentId/skills` | Install skills |

### Chat

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/agents/:agentId/prompt` | Send prompt (SSE streaming) |
| `POST` | `/api/agents/:agentId/cancel` | Cancel prompt |

### WebSocket

| Path | Description |
|------|-------------|
| `/frontier` | Bridge daemon long connection (Frontier protocol) |

### Utility

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/` | Web UI (login + chat + management) |
| `POST` | `/api/auth/verify` | Verify access key |

## Deploy

### Railway (recommended)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

#### Option A: Web UI

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Set **Root Directory** to `packages/server/deploy`
4. Railway auto-installs deps and runs `node relay.js`
5. Go to Settings → Networking → Generate Domain

#### Option B: CLI

```bash
npm i -g @railway/cli
railway login
cd packages/server/deploy
railway init --name doze-relay
railway up
railway domain
```

#### Option C: One-liner

```bash
cd packages/server/deploy
./deploy-relay.sh railway
```

### Fly.io

```bash
flyctl auth login
cd packages/server/deploy
flyctl launch --no-deploy --dockerfile Dockerfile --name doze-relay
flyctl deploy
```

### Render

1. Push to GitHub
2. Go to https://dashboard.render.com/blueprints
3. Select this repo — Render auto-detects `render.yaml`

### Docker

```bash
cd packages/server/deploy
docker build -t doze-relay .
docker run -d -p 4000:4000 --restart unless-stopped doze-relay
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Listen port (auto-injected by Railway/Render) |
| `HOST` | `0.0.0.0` | Listen address |
| `DOZE_ACCESS_KEY` | (none) | **Access key** — protects Web UI + all `/api/*` endpoints. Required for production. |

## Usage Flow

After deployment, you get a public URL like `https://doze-relay.up.railway.app`.

### Step 1: Generate pair command

```bash
curl -X POST https://doze-relay.up.railway.app/api/pair/init \
  -H "Authorization: Bearer YOUR_ACCESS_KEY"
```

Or open the Web UI at `https://doze-relay.up.railway.app/` and log in with your access key.
```json
{
  "ok": true,
  "pair_code": "a1b2-c3d4e5",
  "pat_token": "sat_xxx...",
  "command": "npx -y doze-bridge --pat-token=sat_xxx --pair-code=a1b2-c3d4e5 --relay-url=https://doze-relay.up.railway.app"
}
```

### Step 2: Run on local machine

Execute the `command` from step 1 on the machine that has Claude Code / OpenClaw / Codex installed:

```bash
npx -y doze-bridge --pat-token=sat_xxx --pair-code=a1b2-c3d4e5 --relay-url=https://doze-relay.up.railway.app
```

### Step 3: Use the agent

```bash
# List agents
curl -H "Authorization: Bearer YOUR_ACCESS_KEY" \
  https://doze-relay.up.railway.app/api/agents

# Send a prompt (SSE streaming)
curl -N -X POST https://doze-relay.up.railway.app/api/agents/agent_xxx/prompt \
  -H "Authorization: Bearer YOUR_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'
```

Or use the Web UI chat interface at `https://doze-relay.up.railway.app/`
