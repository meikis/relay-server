#!/usr/bin/env node
/**
 * Doze Relay — 云中继服务器
 *
 * 解决没有公网 IP 的问题。
 * 部署在免费云平台（Railway / Render / Fly.io），提供公网入口。
 *
 * 架构:
 *
 *   豆包客户端 ──HTTP──→ Doze Relay (公网) ←──WebSocket── OpenMinis doze-server
 *                        (本文件)           (出站连接，无需公网IP)
 *
 * 原理:
 *  1. doze-server 启动后通过 WebSocket 主动连接 Relay（出站，无需公网 IP）
 *  2. 客户端发 HTTP 请求到 Relay 的公网地址
 *  3. Relay 通过 WebSocket 把请求转发给 doze-server
 *  4. doze-server 处理后把响应通过 WebSocket 发回 Relay
 *  5. Relay 把响应返回给客户端
 *
 * 部署方式:
 *  - Railway:  npm install && node relay.js
 *  - Render:   npm install && node relay.js
 *  - Fly.io:   fly deploy
 *  - 本机测试: node relay.js --port 4000
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

// ── 配置 ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '4000');
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.DOZE_RELAY_TOKEN || '';

// ── 存储已连接的 doze-server ─────────────────────────────────
// roomKey → { ws, pendingRequests: Map<requestId, {res, startTime}> }
const rooms = new Map();

function getRoom(ws) {
  for (const [key, room] of rooms) {
    if (room.ws === ws) return { key, ...room };
  }
  return null;
}

// ── HTTP 服务器（接收客户端请求）────────────────────────────
const httpServer = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Doze-Room');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 认证
  if (AUTH_TOKEN && req.headers.authorization !== 'Bearer ' + AUTH_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 401, msg: 'Unauthorized' }));
    return;
  }

  // ── Relay 管理页面 ──
  if (req.url === '/' || req.url === '/relay') {
    const roomList = Array.from(rooms.entries()).map(([key, r]) => ({
      room: key,
      connected: true,
      uptime: r.connectedAt ? Date.now() - r.connectedAt : 0,
      pending: r.pendingRequests.size,
    }));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(relayPage(roomList, req.headers.host));
    return;
  }

  // ── 健康检查 ──
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      relay: true,
      rooms: rooms.size,
      connections: Array.from(rooms.keys()),
      timestamp: Date.now(),
    }));
    return;
  }

  // ── 转发请求到 doze-server ──
  // 从 header 或 URL 路径中提取 room key
  let roomKey = req.headers['x-doze-room'];
  if (!roomKey) {
    // 从路径提取: /r/<room>/v1/bots → room, /v1/bots → 默认room
    const match = req.url.match(/^\/r\/([^\/]+)(\/.*)?$/);
    if (match) {
      roomKey = match[1];
      req.url = match[2] || '/';
    }
  }
  if (!roomKey) roomKey = 'default';

  const room = rooms.get(roomKey);
  if (!room || room.ws.readyState !== 1) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: 502,
      msg: `DozeServer "${roomKey}" 未连接到 Relay`,
      hint: '请确认 OpenMinis 上的 doze-server 已启动并连接到本 Relay',
      relayUrl: `http://${req.headers.host}`,
      connectCommand: `node doze-server.js --relay ws://${req.headers.host} --room ${roomKey}`,
    }));
    return;
  }

  // 读取请求体
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  // 构造转发请求
  const requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  // 判断是否 SSE 流式请求
  const isStream = req.url.includes('/chat/stream');

  const relayMsg = {
    type: 'request',
    id: requestId,
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => k !== 'host')
    ),
    body: body.length > 0 ? body.toString('utf-8') : null,
  };

  // 存储待处理请求
  room.pendingRequests.set(requestId, { res, startTime: Date.now(), isStream });

  // 设置超时
  const timeout = setTimeout(() => {
    if (room.pendingRequests.has(requestId)) {
      room.pendingRequests.delete(requestId);
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 504, msg: 'Gateway Timeout (doze-server 未响应)' }));
      } else {
        res.end();
      }
    }
  }, isStream ? 120_000 : 30_000);

  room.pendingRequests.get(requestId).timeout = timeout;

  // 通过 WebSocket 发送给 doze-server
  room.ws.send(JSON.stringify(relayMsg));
});

// ── WebSocket 服务器（接收 doze-server 的反向连接）──────────
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomKey = url.searchParams.get('room') || 'default';
  const token = url.searchParams.get('token');

  // 认证
  if (AUTH_TOKEN && token !== AUTH_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  // 注册 room
  rooms.set(roomKey, {
    ws,
    connectedAt: Date.now(),
    pendingRequests: new Map(),
  });

  console.log(`[Relay] DozeServer 连接: room="${roomKey}" (共 ${rooms.size} 个连接)`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'response') {
      const pending = rooms.get(roomKey)?.pendingRequests.get(msg.id);
      if (!pending) return;

      if (!pending.res.headersSent) {
        pending.res.writeHead(msg.status || 200, msg.headers || { 'Content-Type': 'application/json' });
      }

      if (msg.body) {
        // 普通 JSON 响应 — 有 body，直接结束
        clearTimeout(pending.timeout);
        rooms.get(roomKey).pendingRequests.delete(msg.id);
        pending.res.write(msg.body);
        pending.res.end();
      }
      // 没有 body → SSE 流式响应的 header 设置，不结束，等待后续 sse 消息

    } else if (msg.type === 'sse') {
      // SSE 流式数据
      const pending = rooms.get(roomKey)?.pendingRequests.get(msg.id);
      if (!pending) return;

      if (!pending.res.headersSent) {
        pending.res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
      }
      pending.res.write(msg.data);
      if (msg.end) {
        clearTimeout(pending.timeout);
        rooms.get(roomKey).pendingRequests.delete(msg.id);
        pending.res.end();
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(roomKey);
    if (room) {
      // 清理待处理请求
      for (const [id, pending] of room.pendingRequests) {
        clearTimeout(pending.timeout);
        if (!pending.res.headersSent) {
          pending.res.writeHead(502, { 'Content-Type': 'application/json' });
          pending.res.end(JSON.stringify({ code: 502, msg: 'DozeServer 断开连接' }));
        } else {
          pending.res.end();
        }
      }
      rooms.delete(roomKey);
    }
    console.log(`[Relay] DozeServer 断开: room="${roomKey}" (剩余 ${rooms.size} 个连接)`);
  });

  ws.on('error', (err) => {
    console.error(`[Relay] WebSocket 错误: ${err.message}`);
  });

  // 发送确认
  ws.send(JSON.stringify({ type: 'connected', room: roomKey, message: '已连接到 Relay' }));
});

// ── 管理页面 ────────────────────────────────────────────────
function relayPage(roomList, host) {
  const roomsHtml = roomList.length > 0
    ? roomList.map(r => `<tr><td>${r.room}</td><td>✅ 在线</td><td>${Math.round(r.uptime/1000)}s</td><td>${r.pending}</td></tr>`).join('')
    : '<tr><td colspan="4" style="color:#999;text-align:center">暂无 doze-server 连接</td></tr>';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Doze Relay</title>
<style>
body{font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#333}
h1{color:#6C5CE7} table{width:100%;border-collapse:collapse;margin:16px 0}
th,td{padding:8px 12px;border:1px solid #ddd;text-align:left}
th{background:#f5f5f5} .cmd{background:#1a1a2e;color:#0f0;padding:12px;border-radius:6px;
font-family:monospace;font-size:13px;overflow-x:auto;white-space:pre}
.note{background:#fff3cd;padding:12px;border-radius:6px;margin:12px 0}
</style></head><body>
<h1>🔌 Doze Relay</h1>
<p>中继服务器运行中: <code>http://${host}</code></p>
<div class="note">
  <b>使用方式:</b> 在 OpenMinis 上启动 doze-server 时加上:
  <div class="cmd">node doze-server.js \\
  --relay ws://${host} \\
  --room myroom \\
  --model-api "你的模型API" \\
  --model-key "你的密钥" \\
  --model-name "模型名"</div>
</div>
<p>然后豆包客户端连接:
  <code>node client.js --relay http://${host}/r/myroom</code>
</p>
<h3>已连接的 DozeServer</h3>
<table><tr><th>Room</th><th>状态</th><th>在线时长</th><th>待处理请求</th></tr>
${roomsHtml}</table>
<p style="color:#999;margin-top:20px">Doze Relay · ${new Date().toISOString()}</p>
</body></html>`;
}

// ── 启动 ────────────────────────────────────────────────────
httpServer.listen(PORT, HOST, () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Doze Relay — 云中继服务器               ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  监听:   http://${HOST}:${PORT}`);
  console.log(`  管理页: http://${HOST}:${PORT}/`);
  console.log(`  健康检查: http://${HOST}:${PORT}/health`);
  console.log(`  WebSocket: ws://${HOST}:${PORT}/ws`);
  console.log('');
  console.log('  等待 doze-server 连接...');
  console.log('');
  console.log('  部署到云平台时设置环境变量 PORT 即可。');
});
