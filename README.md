# Doze Relay

Cloud relay server for Doze System — solves the "no public IP" problem.

## Architecture

```
  Client ──HTTP──→ Doze Relay (public) ←──WebSocket── OpenMinis doze-server
                     (this file)          (outbound, no public IP needed)
```

## Deploy

### Railway (recommended)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

```bash
npm i -g @railway/cli
railway login
railway init --name doze-relay
railway up
railway domain
```

### Fly.io

```bash
flyctl auth login
flyctl launch --no-deploy --dockerfile Dockerfile --name doze-relay
flyctl deploy
```

### Render

1. Push this repo to GitHub
2. Go to https://dashboard.render.com/blueprints
3. Select this repo — Render auto-detects `render.yaml`

### Docker

```bash
docker build -t doze-relay .
docker run -d -p 4000:4000 --restart unless-stopped doze-relay
```

## Usage

After deployment, you get a public URL like `https://doze-relay.up.railway.app`.

Start doze-server on OpenMinis:
```bash
node doze-server.js --relay wss://doze-relay.up.railway.app --room myroom
```

Client connects:
```bash
node client.js --relay=https://doze-relay.up.railway.app/r/myroom
```
