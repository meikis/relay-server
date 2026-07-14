#!/usr/bin/env node
/**
 * Doze Relay — 云中继服务器 (重构版)
 *
 * 模拟 Coze 云的握手 API + Frontier WebSocket 协议。
 * 作为客户端平台和 Bridge daemon 之间的消息路由中枢。
 *
 * 架构:
 *
 *   客户端平台 ──HTTP──→ Doze Relay (公网) ←──WebSocket──→ doze-bridge daemon
 *   (生成配对命令)       (握手 + 消息路由)                 (spawn Agent 子进程)
 *
 * 核心端点:
 *   HTTP:
 *     POST /api/pair/init           → 生成配对码 + 命令
 *     POST /api/pair                → Bridge daemon 配对握手
 *     GET  /api/agents              → 列出已连接 Agent
 *     POST /api/agents              → 创建 Agent (通过 Bridge daemon spawn)
 *     POST /api/agents/:agentId/prompt → 发送对话 (SSE)
 *     POST /api/agents/:agentId/cancel → 取消对话
 *     DELETE /api/agents/:agentId   → 断开 Agent
 *     GET  /api/agents/:agentId/files → 文件树
 *     GET  /api/agents/:agentId/skills → 技能列表
 *     POST /api/agents/:agentId/skills → 安装技能
 *     GET  /health                  → 健康检查
 *
 *   WebSocket:
 *     /frontier                     → Bridge daemon 长连接 (Frontier 协议)
 *     /ws                           → 旧版 Bridge 反向连接 (向后兼容)
 *
 * 部署:
 *   Railway / Render / Fly.io: 设置 PORT 环境变量
 *   本机测试: node relay.js --port 4000
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';

// ── 配置 ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '4000');
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.DOZE_RELAY_TOKEN || '';

// ── 存储 ────────────────────────────────────────────────────

/**
 * 配对码存储: pairCode → { patToken, agentId?, createdAt, expiresAt }
 */
const pairCodes = new Map();

/**
 * 已配对的 Bridge daemon 连接: deviceId → { ws, patToken, agentId, connectedAt, pendingRequests }
 */
const devices = new Map();

/**
 * 旧版 room 连接 (向后兼容): roomKey → { ws, pendingRequests }
 */
const rooms = new Map();

// ── 辅助函数 ────────────────────────────────────────────────

function generatePairCode() {
  // 格式: xxxx-xxxxxx (对齐 coze-bridge)
  const part1 = randomBytes(2).toString('hex');
  const part2 = randomBytes(3).toString('hex');
  return `${part1}-${part2}`;
}

function generateDeviceId() {
  return 'device_' + randomBytes(12).toString('hex');
}

function generatePatToken() {
  return 'sat_' + randomBytes(20).toString('hex');
}

function maskToken(token) {
  if (!token || token.length < 10) return '***';
  return token.slice(0, 6) + '***' + token.slice(-4);
}

/**
 * 通过 WebSocket 向 Bridge daemon 发送 ACP 请求并等待响应
 */
function sendToDevice(deviceId, message, timeoutMs = 120000) {
  const device = devices.get(deviceId);
  if (!device || device.ws.readyState !== 1) {
    return Promise.reject(new Error(`Device ${deviceId} not connected`));
  }

  const requestId = message.id || 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  message.id = requestId;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      device.pendingRequests.delete(requestId);
      reject(new Error('Device response timeout'));
    }, timeoutMs);

    device.pendingRequests.set(requestId, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); },
      isStream: false,
    });

    device.ws.send(JSON.stringify(message));
  });
}

/**
 * 通过 WebSocket 向 Bridge daemon 发送 ACP 请求，流式接收响应
 */
function sendToDeviceStream(deviceId, message, onEvent, timeoutMs = 120000) {
  const device = devices.get(deviceId);
  if (!device || device.ws.readyState !== 1) {
    return Promise.reject(new Error(`Device ${deviceId} not connected`));
  }

  const requestId = message.id || 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  message.id = requestId;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      device.pendingRequests.delete(requestId);
      reject(new Error('Device stream timeout'));
    }, timeoutMs);

    device.pendingRequests.set(requestId, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); },
      isStream: true,
      onEvent,
    });

    device.ws.send(JSON.stringify(message));
  });
}

// ── HTTP 服务器 ─────────────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Doze-Room');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // 读取 body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyStr = Buffer.concat(chunks).toString('utf-8');
  let body = {};
  try { body = bodyStr ? JSON.parse(bodyStr) : {}; } catch {}

  // ── 健康检查 ──
  if (path === '/health') {
    return sendJSON(res, 200, {
      status: 'ok',
      relay: true,
      devices: devices.size,
      pairCodes: pairCodes.size,
      rooms: rooms.size,
      timestamp: Date.now(),
    });
  }

  // ── 管理页面 ──
  if (path === '/' || path === '/relay') {
    return sendHTML(res, 200, renderAdminPage(req.headers.host));
  }

  // ── 配对码生成 (客户端平台调用) ──
  if (path === '/api/pair/init' && method === 'POST') {
    // 可选认证
    if (AUTH_TOKEN && req.headers.authorization !== 'Bearer ' + AUTH_TOKEN) {
      return sendJSON(res, 401, { ok: false, error: 'Unauthorized' });
    }

    const pairCode = generatePairCode();
    const patToken = body.pat_token || generatePatToken();
    const agentId = body.agent_id || '';

    pairCodes.set(pairCode, {
      patToken,
      agentId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 分钟有效
    });

    // 生成配对命令
    const host = `http://${req.headers.host}`;
    const command = `npx -y doze-bridge --pat-token=${patToken} --pair-code=${pairCode} --relay-url=${host}`;

    return sendJSON(res, 200, {
      ok: true,
      pair_code: pairCode,
      pat_token: patToken,
      agent_id: agentId,
      command,
      expires_in: 600,
    });
  }

  // ── Bridge daemon 配对握手 ──
  if (path === '/api/pair' && method === 'POST') {
    const { privatecode, pairing_code, agent_id } = body;

    if (!privatecode || !pairing_code) {
      return sendJSON(res, 400, { ok: false, error: 'Missing privatecode or pairing_code' });
    }

    const pairData = pairCodes.get(pairing_code);
    if (!pairData) {
      return sendJSON(res, 404, { ok: false, error: 'Pairing code not found or expired' });
    }

    if (Date.now() > pairData.expiresAt) {
      pairCodes.delete(pairing_code);
      return sendJSON(res, 410, { ok: false, error: 'Pairing code expired' });
    }

    // 验证 PAT token
    if (privatecode !== pairData.patToken) {
      return sendJSON(res, 403, { ok: false, error: 'PAT token mismatch' });
    }

    // 生成 deviceId
    const deviceId = generateDeviceId();

    // 构造 Frontier WS URL
    const wsProtocol = req.headers['x-forwarded-proto'] === 'https' || req.connection?.encrypted ? 'wss' : 'ws';
    const frontierUrl = `${wsProtocol}://${req.headers.host}/frontier?device=${deviceId}&token=${privatecode}`;

    // 消费配对码
    pairCodes.delete(pairing_code);

    return sendJSON(res, 200, {
      ok: true,
      deviceId,
      frontier_url: frontierUrl,
      agent_id: agent_id || pairData.agentId || '',
    });
  }

  // ── 列出已连接的设备/Agent ──
  if (path === '/api/agents' && method === 'GET') {
    const agents = [];
    for (const [deviceId, device] of devices) {
      agents.push({
        deviceId,
        agentId: device.agentId || '',
        patToken: maskToken(device.patToken),
        connectedAt: device.connectedAt,
        uptime: Date.now() - device.connectedAt,
        pending: device.pendingRequests.size,
      });
    }
    return sendJSON(res, 200, { ok: true, agents, total: agents.length });
  }

  // ── 创建 Agent (通过 Bridge daemon spawn) ──
  if (path === '/api/agents' && method === 'POST') {
    const { framework, agent_id, system_prompt, coze_identity } = body;

    // 找到第一个已连接的 device
    let deviceId = null;
    let device = null;
    for (const [id, dev] of devices) {
      if (dev.ws?.readyState === 1) { deviceId = id; device = dev; break; }
    }
    if (!deviceId) {
      return sendJSON(res, 502, { ok: false, error: 'No bridge daemon connected' });
    }

    try {
      const result = await sendToDevice(deviceId, {
        method: '_agent/create',
        params: {
          agentId: agent_id || ('agent_' + Date.now().toString(36)),
          framework: framework || 'claude-code',
          systemPrompt: system_prompt || '',
          cozeIdentity: coze_identity || {},
        },
      });
      // 更新 device 的 agentId
      if (result?.agentId) device.agentId = result.agentId;
      return sendJSON(res, 200, result);
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: err.message });
    }
  }

  // ── Agent 对话 (SSE 流式) ──
  if (path.match(/^\/api\/agents\/([^/]+)\/prompt$/) && method === 'POST') {
    const agentId = path.split('/')[3];

    // 找到对应的 device
    let deviceId = null;
    for (const [id, dev] of devices) {
      if (dev.agentId === agentId || id === agentId) {
        deviceId = id;
        break;
      }
    }

    if (!deviceId) {
      return sendJSON(res, 404, { ok: false, error: `Agent ${agentId} not connected` });
    }

    const device = devices.get(deviceId);
    if (!device || device.ws.readyState !== 1) {
      return sendJSON(res, 502, { ok: false, error: `Agent ${agentId} disconnected` });
    }

    // 构造 ACP session/prompt 请求
    const acpRequest = {
      method: 'session/prompt',
      params: {
        agentId,
        messages: body.messages || [],
        stream: true,
        ...body.conversation_id ? { conversationId: body.conversation_id } : {},
      },
    };

    // SSE 响应
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const messageId = 'msg_' + Date.now().toString(36);

    // 发送初始事件
    res.write(`data: ${JSON.stringify({ event: 'conversation.chat.created', chat_id: messageId, status: 'in_progress' })}\n\n`);

    try {
      await sendToDeviceStream(deviceId, acpRequest, (event) => {
        if (event.method === 'session/update' && event.params?.delta) {
          res.write(`data: ${JSON.stringify({ event: 'conversation.message.delta', delta: event.params.delta, chat_id: messageId })}\n\n`);
        } else if (event.method === 'session/update' && event.params?.text) {
          res.write(`data: ${JSON.stringify({ event: 'conversation.message.delta', delta: event.params.text, chat_id: messageId })}\n\n`);
        }
      });

      res.write(`data: ${JSON.stringify({ event: 'conversation.message.completed', chat_id: messageId })}\n\n`);
      res.write(`data: ${JSON.stringify({ event: 'conversation.chat.completed', chat_id: messageId, status: 'completed' })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ event: 'error', error: err.message, chat_id: messageId })}\n\n`);
    }

    res.end();
    return;
  }

  // ── 取消对话 ──
  if (path.match(/^\/api\/agents\/([^/]+)\/cancel$/) && method === 'POST') {
    const agentId = path.split('/')[3];
    let deviceId = null;
    for (const [id, dev] of devices) {
      if (dev.agentId === agentId || id === agentId) { deviceId = id; break; }
    }
    if (!deviceId) return sendJSON(res, 404, { ok: false, error: 'Agent not found' });

    try {
      const result = await sendToDevice(deviceId, {
        method: 'session/cancel',
        params: { agentId, sessionId: body.session_id },
      });
      return sendJSON(res, 200, result);
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: err.message });
    }
  }

  // ── 断开 Agent ──
  if (path.match(/^\/api\/agents\/([^/]+)$/) && method === 'DELETE') {
    const agentId = path.split('/')[3];
    let deviceId = null;
    for (const [id, dev] of devices) {
      if (dev.agentId === agentId || id === agentId) { deviceId = id; break; }
    }
    if (!deviceId) return sendJSON(res, 404, { ok: false, error: 'Agent not found' });

    try {
      await sendToDevice(deviceId, {
        method: '_agent/disconnect',
        params: { agentId },
      });
      // 关闭 WS 连接
      const device = devices.get(deviceId);
      if (device) device.ws.close();
      return sendJSON(res, 200, { ok: true });
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: err.message });
    }
  }

  // ── 文件树 ──
  if (path.match(/^\/api\/agents\/([^/]+)\/files$/) && method === 'GET') {
    const agentId = path.split('/')[3];
    let deviceId = null;
    for (const [id, dev] of devices) {
      if (dev.agentId === agentId || id === agentId) { deviceId = id; break; }
    }
    if (!deviceId) return sendJSON(res, 404, { ok: false, error: 'Agent not found' });

    try {
      const result = await sendToDevice(deviceId, {
        method: '_agent/getFileTree',
        params: { agentId },
      });
      return sendJSON(res, 200, result);
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: err.message });
    }
  }

  // ── 技能列表 ──
  if (path.match(/^\/api\/agents\/([^/]+)\/skills$/) && method === 'GET') {
    const agentId = path.split('/')[3];
    let deviceId = null;
    for (const [id, dev] of devices) {
      if (dev.agentId === agentId || id === agentId) { deviceId = id; break; }
    }
    if (!deviceId) return sendJSON(res, 404, { ok: false, error: 'Agent not found' });

    try {
      const result = await sendToDevice(deviceId, {
        method: '_agent/listSkills',
        params: { agentId },
      });
      return sendJSON(res, 200, result);
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: err.message });
    }
  }

  // ── 安装技能 ──
  if (path.match(/^\/api\/agents\/([^/]+)\/skills$/) && method === 'POST') {
    const agentId = path.split('/')[3];
    let deviceId = null;
    for (const [id, dev] of devices) {
      if (dev.agentId === agentId || id === agentId) { deviceId = id; break; }
    }
    if (!deviceId) return sendJSON(res, 404, { ok: false, error: 'Agent not found' });

    try {
      const result = await sendToDevice(deviceId, {
        method: '_agent/addSkills',
        params: { agentId, skills: body.skills || [] },
      });
      return sendJSON(res, 200, result);
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: err.message });
    }
  }

  // ── 旧版兼容: 转发到 room ──
  let roomKey = req.headers['x-doze-room'];
  if (!roomKey) {
    const match = path.match(/^\/r\/([^/]+)(\/.*)?$/);
    if (match) {
      roomKey = match[1];
      const subPath = match[2] || '/';
      // 转发到旧版 room
      const room = rooms.get(roomKey);
      if (!room || room.ws.readyState !== 1) {
        return sendJSON(res, 502, {
          code: 502,
          msg: `DozeServer "${roomKey}" 未连接到 Relay`,
          hint: '请确认 doze-server/bridge 已启动并连接到本 Relay',
        });
      }

      const requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const isStream = subPath.includes('/chat/stream');

      const relayMsg = {
        type: 'request',
        id: requestId,
        method,
        url: subPath,
        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')),
        body: bodyStr || null,
      };

      room.pendingRequests.set(requestId, { res, startTime: Date.now(), isStream });

      const timeout = setTimeout(() => {
        if (room.pendingRequests.has(requestId)) {
          room.pendingRequests.delete(requestId);
          if (!res.headersSent) {
            sendJSON(res, 504, { code: 504, msg: 'Gateway Timeout' });
          } else {
            res.end();
          }
        }
      }, isStream ? 120000 : 30000);

      room.pendingRequests.get(requestId).timeout = timeout;
      room.ws.send(JSON.stringify(relayMsg));
      return;
    }
  }

  sendJSON(res, 404, { ok: false, error: 'Not found: ' + path });
});

// ── WebSocket 服务器: Frontier (Bridge daemon 长连接) ────────

const frontierWss = new WebSocketServer({ server: httpServer, path: '/frontier' });

frontierWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const deviceId = url.searchParams.get('device');
  const token = url.searchParams.get('token');

  if (!deviceId || !token) {
    ws.close(4001, 'Missing device or token');
    return;
  }

  // 查找已配对的设备
  let deviceInfo = null;
  for (const [id, dev] of devices) {
    if (id === deviceId && dev.patToken === token) {
      deviceInfo = dev;
      break;
    }
  }

  // 如果设备还没注册（可能是配对后立即连接），允许注册
  if (!deviceInfo) {
    // 从 pairCodes 查找（应对配对后直接连接的情况）
    deviceInfo = { patToken: token, agentId: '', connectedAt: 0, pendingRequests: new Map() };
  }

  // 注册设备
  deviceInfo.ws = ws;
  deviceInfo.connectedAt = Date.now();
  deviceInfo.pendingRequests = deviceInfo.pendingRequests || new Map();
  devices.set(deviceId, deviceInfo);

  console.log(`[Frontier] Bridge daemon 连接: device=${deviceId} (共 ${devices.size} 个设备)`);

  // 发送确认
  ws.send(JSON.stringify({
    type: 'connected',
    deviceId,
    message: '已连接到 Relay Frontier',
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ACP 响应 (有 id)
    if (msg.id) {
      const pending = deviceInfo.pendingRequests?.get(msg.id);
      if (!pending) return;

      // 流式事件
      if (msg.method && msg.params) {
        if (pending.isStream && pending.onEvent) {
          pending.onEvent(msg);
        }
        return; // 流式事件不结束请求
      }

      // 最终响应
      if (msg.result !== undefined) {
        deviceInfo.pendingRequests.delete(msg.id);
        pending.resolve(msg.result);
      } else if (msg.error) {
        deviceInfo.pendingRequests.delete(msg.id);
        pending.reject(new Error(msg.error.message || 'ACP error'));
      }
      return;
    }

    // ACP 通知 (无 id) — Bridge 主动发送的事件
    if (msg.method && !msg.id) {
      // 例如 _agent/health 心跳
      if (msg.method === '_agent/health') {
        // 更新设备信息
        if (msg.params?.agents) {
          deviceInfo.agentHealth = msg.params.agents;
        }
        return;
      }

      // 其他通知可以转发给感兴趣的客户端
      console.log(`[Frontier] Notification from ${deviceId}: ${msg.method}`);
    }
  });

  ws.on('close', () => {
    // 拒绝所有待处理请求
    if (deviceInfo.pendingRequests) {
      for (const [, pending] of deviceInfo.pendingRequests) {
        pending.reject(new Error('Device disconnected'));
      }
    }
    devices.delete(deviceId);
    console.log(`[Frontier] Bridge daemon 断开: device=${deviceId} (剩余 ${devices.size} 个设备)`);
  });

  ws.on('error', (err) => {
    console.error(`[Frontier] WebSocket 错误: ${err.message}`);
  });
});

// ── WebSocket 服务器: 旧版兼容 (/ws) ────────────────────────

const legacyWss = new WebSocketServer({ server: httpServer, path: '/ws' });

legacyWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomKey = url.searchParams.get('room') || 'default';
  const token = url.searchParams.get('token');

  if (AUTH_TOKEN && token !== AUTH_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  rooms.set(roomKey, {
    ws,
    connectedAt: Date.now(),
    pendingRequests: new Map(),
  });

  console.log(`[Legacy] DozeServer 连接: room="${roomKey}" (共 ${rooms.size} 个连接)`);

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
        clearTimeout(pending.timeout);
        rooms.get(roomKey).pendingRequests.delete(msg.id);
        pending.res.write(msg.body);
        pending.res.end();
      }
    } else if (msg.type === 'sse') {
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
      for (const [, pending] of room.pendingRequests) {
        clearTimeout(pending.timeout);
        if (!pending.res.headersSent) {
          sendJSON(pending.res, 502, { code: 502, msg: 'DozeServer 断开连接' });
        } else {
          pending.res.end();
        }
      }
      rooms.delete(roomKey);
    }
    console.log(`[Legacy] DozeServer 断开: room="${roomKey}" (剩余 ${rooms.size} 个连接)`);
  });

  ws.send(JSON.stringify({ type: 'connected', room: roomKey, message: '已连接到 Relay' }));
});

// ── 辅助函数 ────────────────────────────────────────────────

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHTML(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function renderAdminPage(host) {
  const deviceList = Array.from(devices.entries()).map(([id, dev]) => ({
    deviceId: id,
    agentId: dev.agentId || '(未指定)',
    uptime: dev.connectedAt ? Math.round((Date.now() - dev.connectedAt) / 1000) : 0,
    pending: dev.pendingRequests?.size || 0,
  }));

  const roomList = Array.from(rooms.entries()).map(([key, r]) => ({
    room: key,
    uptime: r.connectedAt ? Math.round((Date.now() - r.connectedAt) / 1000) : 0,
    pending: r.pendingRequests.size,
  }));

  const devicesHtml = deviceList.length > 0
    ? deviceList.map(d => `<tr><td>${d.deviceId.substring(0, 16)}...</td><td>${d.agentId}</td><td>${d.uptime}s</td><td>${d.pending}</td></tr>`).join('')
    : '<tr><td colspan="4" style="color:#999;text-align:center">暂无 Bridge daemon 连接</td></tr>';

  const roomsHtml = roomList.length > 0
    ? roomList.map(r => `<tr><td>${r.room}</td><td>${r.uptime}s</td><td>${r.pending}</td></tr>`).join('')
    : '<tr><td colspan="3" style="color:#999;text-align:center">暂无旧版连接</td></tr>';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Doze Relay</title>
<style>
body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#333}
h1{color:#6C5CE7} h2{color:#555;margin-top:28px}
table{width:100%;border-collapse:collapse;margin:16px 0}
th,td{padding:8px 12px;border:1px solid #ddd;text-align:left}
th{background:#f5f5f5}
.cmd{background:#1a1a2e;color:#0f0;padding:12px;border-radius:6px;font-family:monospace;font-size:13px;overflow-x:auto;white-space:pre}
.note{background:#e8f5e9;padding:12px;border-radius:6px;margin:12px 0;border-left:4px solid #4caf50}
</style></head><body>
<h1>Doze Relay</h1>
<p>中继服务器运行中: <code>http://${host}</code></p>

<h2>配对流程 (新架构)</h2>
<div class="note">
  <b>1. 客户端平台生成配对命令:</b>
  <div class="cmd">curl -X POST http://${host}/api/pair/init</div>
  <p>返回 <code>command</code> 字段，显示给用户执行。</p>

  <b>2. 用户在本地机器执行:</b>
  <div class="cmd">npx -y doze-bridge --pat-token=sat_xxx --pair-code=xxxx --relay-url=http://${host}</div>

  <b>3. Bridge daemon 自动:</b>
  HTTP 握手 → WebSocket 连接 → Agent 探测 → OS 自启
</div>

<h2>已连接的 Bridge Daemon (${deviceList.length})</h2>
<table><tr><th>Device ID</th><th>Agent ID</th><th>在线时长</th><th>待处理</th></tr>
${devicesHtml}</table>

<h2>旧版连接 (${roomList.length})</h2>
<table><tr><th>Room</th><th>在线时长</th><th>待处理</th></tr>
${roomsHtml}</table>

<p style="color:#999;margin-top:20px">Doze Relay · ${new Date().toISOString()}</p>
</body></html>`;
}

// ── 启动 ────────────────────────────────────────────────────
httpServer.listen(PORT, HOST, () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Doze Relay — 云中继服务器 (重构版)      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  监听:       http://${HOST}:${PORT}`);
  console.log(`  管理页:     http://${HOST}:${PORT}/`);
  console.log(`  健康检查:   http://${HOST}:${PORT}/health`);
  console.log(`  配对初始化: POST http://${HOST}:${PORT}/api/pair/init`);
  console.log(`  Frontier WS: ws://${HOST}:${PORT}/frontier`);
  console.log(`  Legacy WS:  ws://${HOST}:${PORT}/ws`);
  console.log('');
  console.log('  等待 Bridge daemon 连接...');
});
