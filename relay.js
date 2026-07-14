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
 *
 * 授权:
 *   DOZE_ACCESS_KEY 环境变量 — 访问密钥，所有 /api/* 端点需要 Bearer 认证
 *   未设置时为开放模式（仅本地测试用）
 *
 * 部署:
 *   Railway / Render / Fly.io: 设置 PORT + DOZE_ACCESS_KEY 环境变量
 *   本机测试: node relay.js --port 4000
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';

// ── 配置 ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '4000');
const HOST = process.env.HOST || '0.0.0.0';
const ACCESS_KEY = process.env.DOZE_ACCESS_KEY || ''; // Web UI + API 访问密钥

// ── 授权检查 ────────────────────────────────────────────────

/**
 * 检查请求是否携带有效的 Access Key
 * 优先级: Authorization: Bearer xxx > query ?key=xxx
 */
function checkAccessKey(req, url) {
  if (!ACCESS_KEY) return true; // 未设置密钥则开放
  const authHeader = req.headers.authorization;
  if (authHeader === 'Bearer ' + ACCESS_KEY) return true;
  const queryKey = url.searchParams.get('key');
  if (queryKey === ACCESS_KEY) return true;
  return false;
}

/**
 * 不需要 Access Key 的路径白名单
 * - /health: 健康检查
 * - /api/pair: Bridge daemon 握手 (使用 pat-token 认证)
 * - /frontier: WebSocket 连接 (使用 token 认证)
 * - 静态资源
 */
function isPublicPath(path) {
  return path === '/health'
    || path === '/api/pair'
    || path === '/api/auth/verify';
}

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
 * 会话管理: conversationId → { id, agentId, deviceId, createdAt, messages[] }
 * 每个会话对应远端 OpenMinis/OpenClaw 的一个对话上下文
 */
const conversations = new Map();

/**
 * 请求日志: requestId → { conversationId, agentId, method, params, status, response, timestamp }
 */
const requestLog = new Map();

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
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

  // ── Access Key 授权检查 ──
  if (path.startsWith('/api/') && !isPublicPath(path)) {
    if (!checkAccessKey(req, url)) {
      return sendJSON(res, 401, { ok: false, error: 'Unauthorized: invalid or missing access key' });
    }
  }

  // ── 健康检查 ──
  if (path === '/health') {
    return sendJSON(res, 200, {
      status: 'ok',
      relay: true,
      devices: devices.size,
      pairCodes: pairCodes.size,
      timestamp: Date.now(),
    });
  }

  // ── 管理页面 (Web UI) ──
  if (path === '/' || path === '/relay' || path === '/app') {
    const httpProtocol = req.headers['x-forwarded-proto'] === 'https' || req.connection?.encrypted ? 'https' : 'http';
    return sendHTML(res, 200, renderWebUI(`${httpProtocol}://${req.headers.host}`));
  }

  // ── Access Key 验证 ──
  if (path === '/api/auth/verify' && method === 'POST') {
    const key = body.access_key || req.headers.authorization?.replace('Bearer ', '');
    if (!ACCESS_KEY) {
      return sendJSON(res, 200, { ok: true, open: true, message: 'Access key not configured (open mode)' });
    }
    if (key === ACCESS_KEY) {
      return sendJSON(res, 200, { ok: true, open: false });
    }
    return sendJSON(res, 401, { ok: false, error: 'Invalid access key' });
  }

  // ── 配对码生成 (客户端平台调用) ──
  if (path === '/api/pair/init' && method === 'POST') {
    // Access Key 已在上方统一检查

    const pairCode = generatePairCode();
    const patToken = body.pat_token || generatePatToken();
    const agentId = body.agent_id || '';

    pairCodes.set(pairCode, {
      patToken,
      agentId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 分钟有效
    });

    // 生成配对命令 (自动检测 HTTP/HTTPS)
    const httpProtocol = req.headers['x-forwarded-proto'] === 'https' || req.connection?.encrypted ? 'https' : 'http';
    const host = `${httpProtocol}://${req.headers.host}`;
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

  // ── 会话管理 ──
  if (path === '/api/conversations' && method === 'GET') {
    const agentId = url.searchParams.get('agent_id');
    const list = [];
    for (const [id, conv] of conversations) {
      if (agentId && conv.agentId !== agentId && conv.deviceId !== agentId) continue;
      list.push({
        id: conv.id,
        agentId: conv.agentId,
        deviceId: conv.deviceId,
        messageCount: conv.messages?.length || 0,
        createdAt: conv.createdAt,
      });
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    return sendJSON(res, 200, { ok: true, conversations: list });
  }

  if (path.match(/^\/api\/conversations$/) && method === 'POST') {
    const { agent_id } = body;
    let deviceId = null;
    for (const [id, dev] of devices) {
      if (dev.agentId === agent_id || id === agent_id) { deviceId = id; break; }
    }
    if (!deviceId) return sendJSON(res, 404, { ok: false, error: `Agent ${agent_id} not connected` });

    const convId = 'conv_' + Date.now().toString(36);
    conversations.set(convId, {
      id: convId,
      agentId: agent_id,
      deviceId,
      createdAt: Date.now(),
      messages: [],
    });
    return sendJSON(res, 200, { ok: true, conversation_id: convId });
  }

  // ── 请求日志 ──
  if (path === '/api/requests' && method === 'GET') {
    const convId = url.searchParams.get('conversation_id');
    const list = [];
    for (const [id, log] of requestLog) {
      if (convId && log.conversationId !== convId) continue;
      list.push({
        id,
        conversationId: log.conversationId,
        agentId: log.agentId,
        method: log.method,
        params: log.params,
        status: log.status,
        response: log.response ? log.response.substring(0, 200) : null,
        timestamp: log.timestamp,
      });
    }
    list.sort((a, b) => b.timestamp - a.timestamp);
    return sendJSON(res, 200, { ok: true, requests: list });
  }

  // ── 会话详情 ──
  if (path.match(/^\/api\/conversations\/([^/]+)$/) && method === 'GET') {
    const convId = path.split('/')[3];
    const conv = conversations.get(convId);
    if (!conv) return sendJSON(res, 404, { ok: false, error: 'Conversation not found' });
    return sendJSON(res, 200, { ok: true, conversation: conv });
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
    const conversationId = body.conversation_id || null;

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

    // 如果指定了 conversation_id，确保会话存在；否则自动创建
    let convId = conversationId;
    if (!convId) {
      convId = 'conv_' + Date.now().toString(36);
      conversations.set(convId, {
        id: convId,
        agentId,
        deviceId,
        createdAt: Date.now(),
        messages: [],
      });
    } else if (!conversations.has(convId)) {
      conversations.set(convId, {
        id: convId,
        agentId,
        deviceId,
        createdAt: Date.now(),
        messages: [],
      });
    }
    // 记录用户消息到会话
    const conv = conversations.get(convId);
    if (conv && body.messages?.length > 0) {
      body.messages.forEach(m => {
        conv.messages.push({ role: m.role, content: m.content, timestamp: Date.now() });
      });
    }

    // 构造 ACP session/prompt 请求
    const acpRequest = {
      method: 'session/prompt',
      params: {
        agentId,
        messages: body.messages || [],
        stream: true,
        ...(convId ? { conversationId: convId } : {}),
      },
    };

    // 记录请求日志
    const reqLogId = 'req_' + Date.now().toString(36);
    requestLog.set(reqLogId, {
      id: reqLogId,
      conversationId: convId,
      agentId,
      method: 'session/prompt',
      params: { messageCount: body.messages?.length || 0 },
      status: 'pending',
      response: null,
      timestamp: Date.now(),
    });

    // SSE 响应
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const messageId = 'msg_' + Date.now().toString(36);

    // 发送初始事件（包含会话 ID）
    res.write(`data: ${JSON.stringify({ event: 'conversation.chat.created', chat_id: messageId, conversation_id: convId, status: 'in_progress' })}\n\n`);

    let fullResponse = '';
    try {
      await sendToDeviceStream(deviceId, acpRequest, (event) => {
        if (event.method === 'session/update' && event.params?.delta) {
          fullResponse += event.params.delta;
          res.write(`data: ${JSON.stringify({ event: 'conversation.message.delta', delta: event.params.delta, chat_id: messageId })}\n\n`);
        } else if (event.method === 'session/update' && event.params?.text) {
          fullResponse += event.params.text;
          res.write(`data: ${JSON.stringify({ event: 'conversation.message.delta', delta: event.params.text, chat_id: messageId })}\n\n`);
        }
      });

      // 记录助手回复到会话
      if (conv && fullResponse) {
        conv.messages.push({ role: 'assistant', content: fullResponse, timestamp: Date.now() });
      }

      // 更新请求日志
      const log = requestLog.get(reqLogId);
      if (log) { log.status = 'completed'; log.response = fullResponse; }

      res.write(`data: ${JSON.stringify({ event: 'conversation.message.completed', chat_id: messageId })}\n\n`);
      res.write(`data: ${JSON.stringify({ event: 'conversation.chat.completed', chat_id: messageId, conversation_id: convId, status: 'completed' })}\n\n`);
    } catch (err) {
      // 更新请求日志为失败
      const log = requestLog.get(reqLogId);
      if (log) { log.status = 'error'; log.response = err.message; }

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

  sendJSON(res, 404, { ok: false, error: 'Not found: ' + path });
});

// ── WebSocket 服务器: Frontier (Bridge daemon 长连接) ────────

const frontierWss = new WebSocketServer({ 
  server: httpServer, 
  path: '/frontier',
  perMessageDeflate: false,  // 显式禁用压缩，避免 RSV1 位错误
});

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

function renderWebUI(host) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Doze Relay</title>
<style>
:root{
  --bg:#0f0f1a;--bg2:#1a1a2e;--bg3:#16213e;--surface:#1e1e36;--surface2:#252542;
  --border:#2a2a4a;--text:#e0e0f0;--text2:#8888aa;--text3:#555577;
  --primary:#6c5ce7;--primary2:#a29bfe;--accent:#00d2ff;--green:#00b894;
  --red:#e74c3c;--orange:#fdcb6e;--radius:12px;--radius-sm:8px;
  --shadow:0 4px 24px rgba(0,0,0,.3);--transition:.2s ease;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden}
button{cursor:pointer;border:none;outline:none;font-family:inherit;transition:var(--transition)}
input,textarea{font-family:inherit;outline:none}

/* ── Login ── */
#login{display:flex;align-items:center;justify-content:center;height:100vh;background:linear-gradient(135deg,#0f0f1a 0%,#1a1a2e 50%,#16213e 100%)}
.login-box{background:var(--surface);padding:48px 40px;border-radius:20px;width:400px;box-shadow:var(--shadow);text-align:center}
.login-box h1{font-size:28px;margin-bottom:8px;background:linear-gradient(135deg,var(--primary2),var(--accent));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.login-box p{color:var(--text2);font-size:14px;margin-bottom:32px}
.login-box input{width:100%;padding:14px 16px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:15px;margin-bottom:16px}
.login-box input:focus{border-color:var(--primary)}
.login-box button{width:100%;padding:14px;background:linear-gradient(135deg,var(--primary),var(--primary2));color:#fff;border-radius:var(--radius-sm);font-size:16px;font-weight:600}
.login-box button:hover{opacity:.9;transform:translateY(-1px)}
.login-error{color:var(--red);font-size:13px;margin-top:12px;min-height:18px}
.login-hint{color:var(--text3);font-size:12px;margin-top:20px}

/* ── App Layout ── */
#app{display:none;height:100vh;flex-direction:column}
.app-header{display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:56px;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0}
.app-header .logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px}
.app-header .logo .dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green)}
.app-header .actions{display:flex;gap:8px}
.app-header button{padding:8px 16px;border-radius:var(--radius-sm);font-size:13px;font-weight:500}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:hover{background:var(--primary2)}
.btn-ghost{background:transparent;color:var(--text2);border:1px solid var(--border)}
.btn-ghost:hover{border-color:var(--primary);color:var(--text)}

.app-body{display:flex;flex:1;overflow:hidden}

/* ── Conversation Panel ── */
.conv-panel{width:240px;background:var(--bg2);border-right:1px solid var(--border);display:none;flex-direction:column;flex-shrink:0}
.conv-panel.open{display:flex}
.conv-header{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0}
.conv-header h3{font-size:13px;color:var(--text2)}
.conv-header .actions{display:flex;gap:4px}
.conv-list{flex:1;overflow-y:auto;padding:8px}
.conv-item{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:var(--radius-sm);cursor:pointer;margin-bottom:2px;font-size:13px;transition:var(--transition)}
.conv-item:hover{background:var(--surface)}
.conv-item.active{background:var(--surface2);border-left:3px solid var(--primary)}
.conv-item .conv-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.conv-item .conv-time{font-size:11px;color:var(--text3);flex-shrink:0}
.conv-empty{text-align:center;padding:40px 16px;color:var(--text3);font-size:13px}

/* ── Request Log Panel ── */
.log-panel{width:320px;background:var(--bg2);border-left:1px solid var(--border);display:none;flex-direction:column;flex-shrink:0}
.log-panel.open{display:flex}
.log-header{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.log-header h3{font-size:13px;color:var(--text2)}
.log-body{flex:1;overflow-y:auto;padding:12px}
.log-entry{background:var(--surface);border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:8px;font-size:12px;border:1px solid var(--border)}
.log-entry .log-method{color:var(--accent);font-family:monospace;font-size:11px;margin-bottom:4px}
.log-entry .log-status{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600}
.log-status.completed{background:rgba(34,197,94,.15);color:#22c55e}
.log-status.error{background:rgba(239,68,68,.15);color:#ef4444}
.log-status.pending{background:rgba(234,179,8,.15);color:#eab308}
.log-entry .log-response{margin-top:6px;color:var(--text2);white-space:pre-wrap;word-break:break-word;max-height:80px;overflow-y:auto;font-size:11px}
.log-entry .log-time{color:var(--text3);font-size:11px;margin-top:4px}

/* ── Sidebar ── */
.sidebar{width:280px;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.sidebar-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.sidebar-header h3{font-size:14px;color:var(--text2);text-transform:uppercase;letter-spacing:1px}
.sidebar-header .count{background:var(--surface2);padding:2px 10px;border-radius:20px;font-size:12px;color:var(--text2)}
.agent-list{flex:1;overflow-y:auto;padding:8px}
.agent-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:var(--radius-sm);cursor:pointer;transition:var(--transition);margin-bottom:4px}
.agent-item:hover{background:var(--surface)}
.agent-item.active{background:var(--surface2);border-left:3px solid var(--primary)}
.agent-item .avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--accent));display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;flex-shrink:0}
.agent-item .info{flex:1;min-width:0}
.agent-item .name{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-item .status{font-size:12px;color:var(--text3);margin-top:2px}
.agent-item .status.online{color:var(--green)}
.sidebar-footer{padding:12px 16px;border-top:1px solid var(--border)}
.sidebar-footer button{width:100%;padding:10px;border-radius:var(--radius-sm);font-size:13px;font-weight:500}

/* ── Chat Area ── */
.chat-area{flex:1;display:flex;flex-direction:column;min-width:0}
.chat-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text3)}
.chat-empty .icon{font-size:64px;margin-bottom:16px;opacity:.3}
.chat-empty h2{font-size:18px;margin-bottom:8px;color:var(--text2)}
.chat-empty p{font-size:14px}
.chat-header{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid var(--border);background:var(--bg2)}
.chat-header .agent-name{font-size:15px;font-weight:600}
.chat-header .agent-meta{font-size:12px;color:var(--text3)}
.chat-messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px}
.msg{display:flex;gap:12px;max-width:80%}
.msg.user{align-self:flex-end;flex-direction:row-reverse}
.msg .avatar{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;flex-shrink:0}
.msg.user .avatar{background:var(--accent)}
.msg.ai .avatar{background:linear-gradient(135deg,var(--primary),var(--primary2))}
.msg .bubble{padding:12px 16px;border-radius:var(--radius);font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.msg.user .bubble{background:var(--primary);color:#fff;border-top-right-radius:4px}
.msg.ai .bubble{background:var(--surface);border:1px solid var(--border);border-top-left-radius:4px}
.msg.ai .bubble .cursor{display:inline-block;width:2px;height:16px;background:var(--accent);animation:blink 1s infinite;vertical-align:text-bottom}
@keyframes blink{0%,50%{opacity:1}51%,100%{opacity:0}}
.chat-input{padding:16px 20px;border-top:1px solid var(--border);background:var(--bg2)}
.chat-input form{display:flex;gap:12px;align-items:flex-end}
.chat-input textarea{flex:1;padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:14px;resize:none;max-height:120px;line-height:1.5}
.chat-input textarea:focus{border-color:var(--primary)}
.chat-input button{padding:12px 20px;background:var(--primary);color:#fff;border-radius:var(--radius-sm);font-size:14px;font-weight:600;flex-shrink:0}
.chat-input button:hover{background:var(--primary2)}
.chat-input button:disabled{opacity:.5;cursor:not-allowed}

/* ── Details Panel ── */
.details-panel{width:300px;background:var(--bg2);border-left:1px solid var(--border);display:none;flex-direction:column;flex-shrink:0}
.details-panel.open{display:flex}
.details-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.details-header h3{font-size:14px;color:var(--text2)}
.details-header .close{background:none;color:var(--text3);font-size:20px;padding:0 4px}
.details-body{flex:1;overflow-y:auto;padding:16px}
.details-section{margin-bottom:24px}
.details-section h4{font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.detail-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px}
.detail-row .key{color:var(--text2)}
.detail-row .val{color:var(--text);font-family:monospace;font-size:12px}
.file-tree-item{padding:6px 8px;font-size:13px;color:var(--text2);cursor:pointer;border-radius:4px}
.file-tree-item:hover{background:var(--surface)}
.file-tree-item .icon{margin-right:6px}
.skill-badge{display:inline-block;padding:4px 12px;background:var(--surface2);border-radius:20px;font-size:12px;color:var(--text2);margin:0 4px 4px 0}

/* ── Modal ── */
.modal-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:var(--surface);border-radius:var(--radius);width:520px;max-width:90vw;box-shadow:var(--shadow);overflow:hidden}
.modal-header{padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.modal-header h3{font-size:18px}
.modal-header .close{background:none;color:var(--text3);font-size:22px}
.modal-body{padding:24px}
.modal-body .field{margin-bottom:16px}
.modal-body label{display:block;font-size:13px;color:var(--text2);margin-bottom:6px}
.modal-body input,.modal-body select,.modal-body textarea{width:100%;padding:10px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:14px}
.modal-body textarea{resize:vertical;min-height:80px}
.cmd-box{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;font-family:'SF Mono',Consolas,monospace;font-size:13px;color:var(--green);overflow-x:auto;white-space:pre-wrap;word-break:break-all;position:relative}
.cmd-box .copy{position:absolute;top:8px;right:8px;padding:4px 10px;background:var(--surface2);border-radius:4px;font-size:12px;color:var(--text2)}
.cmd-box .copy:hover{color:var(--text)}
.modal-footer{padding:16px 24px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px}
.modal-footer button{padding:10px 20px;border-radius:var(--radius-sm);font-size:14px;font-weight:500}

/* ── Scrollbar ── */
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--text3)}

/* ── Responsive ── */
@media(max-width:768px){
  .sidebar{width:60px}
  .sidebar-header h3,.sidebar-footer button span,.agent-item .info{display:none}
  .details-panel{display:none!important}
  .modal{width:95vw}
}
</style>
</head>
<body>

<!-- Login Screen -->
<div id="login">
  <div class="login-box">
    <h1>Doze Relay</h1>
    <p>输入访问密钥以继续</p>
    <input type="password" id="accessKeyInput" placeholder="Access Key" autofocus>
    <button id="loginBtn" onclick="doLogin()">登 录</button>
    <div class="login-error" id="loginError"></div>
    <div class="login-hint">提示: 密钥由管理员通过 DOZE_ACCESS_KEY 环境变量设置</div>
  </div>
</div>

<!-- Main App -->
<div id="app">
  <div class="app-header">
    <div class="logo"><span class="dot"></span> Doze Relay</div>
    <div class="actions">
      <button class="btn-ghost" onclick="openPairModal()">配对</button>
      <button class="btn-ghost" onclick="logout()">退出</button>
    </div>
  </div>
  <div class="app-body">
    <!-- Sidebar: Agents -->
    <div class="sidebar">
      <div class="sidebar-header">
        <h3>Agents</h3>
        <span class="count" id="agentCount">0</span>
      </div>
      <div class="agent-list" id="agentList"></div>
      <div class="sidebar-footer">
        <button class="btn-ghost" onclick="openPairModal()" style="border-style:dashed">+ 配对新设备</button>
      </div>
    </div>
    <!-- Conversation Panel -->
    <div class="conv-panel" id="convPanel">
      <div class="conv-header">
        <h3>会话列表</h3>
        <div class="actions">
          <button class="btn-ghost" onclick="createConversation()" title="新建会话" style="padding:4px 8px;font-size:18px;line-height:1">+</button>
          <button class="btn-ghost" onclick="toggleConvPanel()" title="关闭" style="padding:4px 8px;font-size:16px">×</button>
        </div>
      </div>
      <div class="conv-list" id="convList">
        <div class="conv-empty">选择 Agent 后显示会话</div>
      </div>
    </div>
    <!-- Chat Area -->
    <div class="chat-area">
      <div id="chatEmpty" class="chat-empty">
        <div class="icon">💬</div>
        <h2>选择一个 Agent 开始对话</h2>
        <p>或点击「配对」连接新设备</p>
      </div>
      <div id="chatView" style="display:none;flex:1;flex-direction:column;overflow:hidden">
        <div class="chat-header">
          <div>
            <div class="agent-name" id="chatAgentName"></div>
            <div class="agent-meta" id="chatAgentMeta"></div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn-ghost" onclick="toggleConvPanel()" id="convToggleBtn">会话</button>
            <button class="btn-ghost" onclick="toggleLogPanel()" id="logToggleBtn">日志</button>
            <button class="btn-ghost" onclick="toggleDetails()">详情</button>
          </div>
        </div>
        <div class="chat-messages" id="chatMessages"></div>
        <div class="chat-input">
          <form onsubmit="sendMessage(event)">
            <textarea id="msgInput" placeholder="输入消息... (Enter 发送, Shift+Enter 换行)" rows="1" onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
            <button type="submit" id="sendBtn">发送</button>
          </form>
        </div>
      </div>
    </div>
    <!-- Request Log Panel -->
    <div class="log-panel" id="logPanel">
      <div class="log-header">
        <h3>请求日志</h3>
        <button class="btn-ghost" onclick="toggleLogPanel()" style="padding:4px 8px;font-size:16px">×</button>
      </div>
      <div class="log-body" id="logBody">
        <div style="text-align:center;padding:40px;color:var(--text3);font-size:13px">发送消息后显示日志</div>
      </div>
    </div>
    <!-- Details Panel -->
    <div class="details-panel" id="detailsPanel">
      <div class="details-header">
        <h3>Agent 详情</h3>
        <button class="close" onclick="toggleDetails()">&times;</button>
      </div>
      <div class="details-body" id="detailsBody"></div>
    </div>
  </div>
</div>

<!-- Pair Modal -->
<div class="modal-overlay" id="pairModal">
  <div class="modal">
    <div class="modal-header">
      <h3>配对新设备</h3>
      <button class="close" onclick="closePairModal()">&times;</button>
    </div>
    <div class="modal-body" id="pairModalBody">
      <div class="field">
        <label>Agent ID (可选)</label>
        <input type="text" id="pairAgentId" placeholder="留空自动生成">
      </div>
      <button class="btn-primary" onclick="generatePairCode()" style="width:100%;padding:12px;border-radius:8px;font-size:14px;font-weight:600">生成配对命令</button>
      <div id="pairResult" style="display:none;margin-top:20px">
        <div class="field">
          <label>在本地机器执行以下命令</label>
          <div class="cmd-box" id="pairCommand"></div>
        </div>
        <div class="field">
          <label>配对码 (10 分钟有效)</label>
          <div style="font-family:monospace;font-size:16px;color:var(--accent);padding:8px 0" id="pairCodeDisplay"></div>
        </div>
        <div style="color:var(--text3);font-size:13px">等待 Bridge daemon 连接...</div>
        <div id="pairWaiting" style="text-align:center;padding:20px;color:var(--text2);font-size:14px"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" onclick="closePairModal()">关闭</button>
    </div>
  </div>
</div>

<script>
let ACCESS_KEY = localStorage.getItem('doze_access_key') || '';
let currentAgent = null;
let currentConversation = null;  // 当前选中的会话 ID
let agents = [];
let conversations = [];          // 当前 Agent 的会话列表
let pairPollTimer = null;

// ── API Helper ──
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (ACCESS_KEY) headers['Authorization'] = 'Bearer ' + ACCESS_KEY;
  const resp = await fetch(path, { ...opts, headers });
  if (resp.status === 401) { logout(); throw new Error('Unauthorized'); }
  return resp;
}

// ── Login ──
async function doLogin() {
  const key = document.getElementById('accessKeyInput').value.trim();
  if (!key) { document.getElementById('loginError').textContent = '请输入 Access Key'; return; }
  try {
    const resp = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_key: key }),
    });
    const data = await resp.json();
    if (data.ok) {
      ACCESS_KEY = key;
      localStorage.setItem('doze_access_key', key);
      showApp();
    } else {
      document.getElementById('loginError').textContent = data.error || '验证失败';
    }
  } catch (e) {
    document.getElementById('loginError').textContent = '连接失败: ' + e.message;
  }
}

function logout() {
  ACCESS_KEY = '';
  localStorage.removeItem('doze_access_key');
  location.reload();
}

async function showApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  await refreshAgents();
  // Auto-refresh
  setInterval(refreshAgents, 5000);
}

// ── Agents ──
async function refreshAgents() {
  try {
    const resp = await api('/api/agents');
    const data = await resp.json();
    agents = data.agents || [];
    renderAgentList();
  } catch (e) { console.error('refreshAgents:', e); }
}

function renderAgentList() {
  const list = document.getElementById('agentList');
  document.getElementById('agentCount').textContent = agents.length;

  if (agents.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--text3);font-size:13px">暂无连接的 Agent<br><br>点击下方按钮配对新设备</div>';
    return;
  }

  list.innerHTML = agents.map(a => {
    const name = a.agentId || a.deviceId.substring(0, 12);
    const active = currentAgent && (currentAgent.agentId === a.agentId || currentAgent.deviceId === a.deviceId);
    const uptime = Math.round((a.uptime || 0) / 1000);
    const avatar = name.substring(0, 2).toUpperCase();
    return '<div class="agent-item' + (active ? ' active' : '') + '" onclick="selectAgent(\\'' + a.agentId + '\\',\\'' + a.deviceId + '\\')">' +
      '<div class="avatar">' + avatar + '</div>' +
      '<div class="info"><div class="name">' + name + '</div>' +
      '<div class="status online">● 在线 · ' + uptime + 's</div></div></div>';
  }).join('');
}

function selectAgent(agentId, deviceId) {
  currentAgent = { agentId, deviceId };
  currentConversation = null;  // 切换 Agent 时重置会话
  const agent = agents.find(a => a.agentId === agentId || a.deviceId === deviceId);
  const name = agentId || deviceId.substring(0, 12);
  document.getElementById('chatEmpty').style.display = 'none';
  document.getElementById('chatView').style.display = 'flex';
  document.getElementById('chatAgentName').textContent = name;
  document.getElementById('chatAgentMeta').textContent = agent ? 'Device: ' + agent.deviceId.substring(0, 16) + '... · ' + (agent.pending || 0) + ' pending' : '';
  document.getElementById('chatMessages').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3);font-size:13px">选择或新建一个会话开始对话</div>';
  renderAgentList();
  // 加载该 Agent 的会话列表
  loadConversations();
}

// ── Chat ──
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.querySelector('.chat-input form').requestSubmit();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

async function sendMessage(e) {
  e.preventDefault();
  const input = document.getElementById('msgInput');
  const msg = input.value.trim();
  if (!msg || !currentAgent) return;

  input.value = '';
  input.style.height = 'auto';

  const agentId = currentAgent.agentId || currentAgent.deviceId;
  const messagesDiv = document.getElementById('chatMessages');

  // User message
  messagesDiv.innerHTML += '<div class="msg user"><div class="avatar">U</div><div class="bubble">' + escapeHtml(msg) + '</div></div>';
  // AI placeholder
  messagesDiv.innerHTML += '<div class="msg ai" id="aiPlaceholder"><div class="avatar">AI</div><div class="bubble"><span class="cursor"></span></div></div>';
  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  document.getElementById('sendBtn').disabled = true;

  try {
    // 构造请求体，包含当前会话 ID（如果有）
    const bodyData = { messages: [{ role: 'user', content: msg }] };
    if (currentConversation) {
      bodyData.conversation_id = currentConversation;
    }

    const resp = await api('/api/agents/' + encodeURIComponent(agentId) + '/prompt', {
      method: 'POST',
      body: JSON.stringify(bodyData),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('HTTP ' + resp.status + ': ' + errText);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let aiText = '';
    let receivedConvId = null;  // 服务端返回的会话 ID
    const placeholder = document.getElementById('aiPlaceholder');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));
            if (event.event === 'conversation.chat.created' && event.conversation_id) {
              receivedConvId = event.conversation_id;
              // 如果是新建的会话，更新本地状态
              if (!currentConversation) {
                currentConversation = receivedConvId;
                loadConversations();  // 刷新会话列表
              }
            }
            if (event.event === 'conversation.message.delta' && event.delta) {
              aiText += event.delta;
              placeholder.querySelector('.bubble').innerHTML = escapeHtml(aiText) + '<span class="cursor"></span>';
              messagesDiv.scrollTop = messagesDiv.scrollHeight;
            } else if (event.event === 'conversation.chat.completed') {
              placeholder.querySelector('.bubble').innerHTML = escapeHtml(aiText);
              placeholder.removeAttribute('id');
            } else if (event.event === 'error') {
              placeholder.querySelector('.bubble').innerHTML = '<span style="color:var(--red)">Error: ' + escapeHtml(event.error) + '</span>';
              placeholder.removeAttribute('id');
            }
          } catch (e) {}
        }
      }
    }
    // Final cleanup
    if (placeholder) {
      placeholder.querySelector('.bubble').innerHTML = escapeHtml(aiText) || '(empty response)';
      placeholder.removeAttribute('id');
    }

    // 刷新请求日志
    loadRequestLog();
  } catch (err) {
    const placeholder = document.getElementById('aiPlaceholder');
    if (placeholder) placeholder.querySelector('.bubble').innerHTML = '<span style="color:var(--red)">Failed: ' + escapeHtml(err.message) + '</span>';
  } finally {
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('msgInput').focus();
  }
}

// ── Conversations (会话管理) ──
async function loadConversations() {
  if (!currentAgent) return;
  const agentId = currentAgent.agentId || currentAgent.deviceId;
  try {
    const resp = await api('/api/conversations?agent_id=' + encodeURIComponent(agentId));
    const data = await resp.json();
    conversations = data.conversations || [];
    renderConvList();
  } catch (e) { console.error('loadConversations:', e); }
}

function renderConvList() {
  const list = document.getElementById('convList');
  if (conversations.length === 0) {
    list.innerHTML = '<div class="conv-empty">暂无会话<br><br>点击 + 新建</div>';
    return;
  }

  list.innerHTML = conversations.map(c => {
    const active = currentConversation === c.id;
    const time = new Date(c.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const title = c.id.replace('conv_', '会话 ') + ' (' + c.messageCount + '条)';
    return '<div class="conv-item' + (active ? ' active' : '') + '" onclick="selectConversation(\\'' + c.id + '\\')">' +
      '<div class="conv-title">' + escapeHtml(title) + '</div>' +
      '<div class="conv-time">' + time + '</div></div>';
  }).join('');
}

function selectConversation(convId) {
  currentConversation = convId;
  renderConvList();
  // 加载会话详情（历史消息）
  loadConversationDetail(convId);
}

async function loadConversationDetail(convId) {
  try {
    const resp = await api('/api/conversations/' + encodeURIComponent(convId));
    const data = await resp.json();
    if (!data.ok || !data.conversation) return;

    const conv = data.conversation;
    const messagesDiv = document.getElementById('chatMessages');
    messagesDiv.innerHTML = '';

    // 渲染历史消息
    if (conv.messages && conv.messages.length > 0) {
      conv.messages.forEach(m => {
        if (m.role === 'user') {
          messagesDiv.innerHTML += '<div class="msg user"><div class="avatar">U</div><div class="bubble">' + escapeHtml(m.content) + '</div></div>';
        } else if (m.role === 'assistant') {
          messagesDiv.innerHTML += '<div class="msg ai"><div class="avatar">AI</div><div class="bubble">' + escapeHtml(m.content) + '</div></div>';
        }
      });
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    } else {
      messagesDiv.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3);font-size:13px">新会话，发送第一条消息开始对话</div>';
    }
  } catch (e) {
    console.error('loadConversationDetail:', e);
  }
}

async function createConversation() {
  if (!currentAgent) { alert('请先选择一个 Agent'); return; }
  const agentId = currentAgent.agentId || currentAgent.deviceId;
  try {
    const resp = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Failed');

    currentConversation = data.conversation_id;
    await loadConversations();
    // 清空聊天区域
    document.getElementById('chatMessages').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3);font-size:13px">新会话，发送第一条消息开始对话</div>';
  } catch (e) {
    alert('创建会话失败: ' + e.message);
  }
}

function toggleConvPanel() {
  const panel = document.getElementById('convPanel');
  panel.classList.toggle('open');
}

// ── Request Log (请求日志) ──
async function loadRequestLog() {
  try {
    const convParam = currentConversation ? '?conversation_id=' + encodeURIComponent(currentConversation) : '';
    const resp = await api('/api/requests' + convParam);
    const data = await resp.json();
    renderRequestLog(data.requests || []);
  } catch (e) { console.error('loadRequestLog:', e); }
}

function renderRequestLog(requests) {
  const body = document.getElementById('logBody');
  if (requests.length === 0) {
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3);font-size:13px">暂无请求记录</div>';
    return;
  }

  body.innerHTML = requests.map(r => {
    const statusClass = r.status || 'pending';
    const time = new Date(r.timestamp).toLocaleString('zh-CN');
    let responsePreview = '';
    if (r.response) {
      responsePreview = r.response.length > 200 ? r.response.substring(0, 200) + '...' : r.response;
    }
    return '<div class="log-entry">' +
      '<div><span class="log-method">' + escapeHtml(r.method) + '</span> <span class="log-status ' + statusClass + '">' + statusClass.toUpperCase() + '</span></div>' +
      (responsePreview ? '<div class="log-response">' + escapeHtml(responsePreview) + '</div>' : '') +
      '<div class="log-time">' + time + '</div></div>';
  }).join('');
}

function toggleLogPanel() {
  const panel = document.getElementById('logPanel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) {
    loadRequestLog();
  }
}

// ── Details ──
function toggleDetails() {
  const panel = document.getElementById('detailsPanel');
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
  } else {
    panel.classList.add('open');
    loadDetails();
  }
}

async function loadDetails() {
  if (!currentAgent) return;
  const body = document.getElementById('detailsBody');
  const agentId = currentAgent.agentId || currentAgent.deviceId;
  const agent = agents.find(a => a.agentId === currentAgent.agentId || a.deviceId === currentAgent.deviceId);
  let html = '<div class="details-section"><h4>基本信息</h4>';
  html += '<div class="detail-row"><span class="key">Agent ID</span><span class="val">' + escapeHtml(agentId) + '</span></div>';
  if (agent) {
    html += '<div class="detail-row"><span class="key">Device</span><span class="val">' + escapeHtml(agent.deviceId.substring(0, 20)) + '...</span></div>';
    html += '<div class="detail-row"><span class="key">在线时长</span><span class="val">' + Math.round((agent.uptime||0)/1000) + 's</span></div>';
    html += '<div class="detail-row"><span class="key">待处理</span><span class="val">' + (agent.pending||0) + '</span></div>';
    html += '<div class="detail-row"><span class="key">连接时间</span><span class="val">' + new Date(agent.connectedAt).toLocaleString() + '</span></div>';
  }
  html += '</div>';

  // Files
  body.innerHTML = html + '<div class="details-section"><h4>文件树</h4><div style="color:var(--text3);font-size:13px">加载中...</div></div>';
  try {
    const resp = await api('/api/agents/' + encodeURIComponent(agentId) + '/files');
    const data = await resp.json();
    let filesHtml = '';
    if (data.files && data.files.length) {
      filesHtml = data.files.map(f => '<div class="file-tree-item"><span class="icon">' + (f.type === 'dir' ? '📁' : '📄') + '</span>' + escapeHtml(f.name) + '</div>').join('');
    } else if (data.tree) {
      filesHtml = '<pre style="font-size:12px;color:var(--text2);white-space:pre-wrap">' + escapeHtml(JSON.stringify(data.tree, null, 2)) + '</pre>';
    } else {
      filesHtml = '<div style="color:var(--text3);font-size:13px">无文件或不支持</div>';
    }
    body.querySelector('.details-section:last-child').innerHTML = '<h4>文件树</h4>' + filesHtml;
  } catch (e) {
    body.querySelector('.details-section:last-child').innerHTML = '<h4>文件树</h4><div style="color:var(--text3);font-size:13px">加载失败</div>';
  }

  // Skills
  html = '<div class="details-section"><h4>技能</h4><div style="color:var(--text3);font-size:13px">加载中...</div></div>';
  body.innerHTML += html;
  try {
    const resp = await api('/api/agents/' + encodeURIComponent(agentId) + '/skills');
    const data = await resp.json();
    let skillsHtml = '';
    if (data.skills && data.skills.length) {
      skillsHtml = data.skills.map(s => '<span class="skill-badge">' + escapeHtml(typeof s === 'string' ? s : (s.name || JSON.stringify(s))) + '</span>').join('');
    } else {
      skillsHtml = '<div style="color:var(--text3);font-size:13px">无技能</div>';
    }
    body.lastElementChild.innerHTML = '<h4>技能</h4>' + skillsHtml;
  } catch (e) {
    if (body.lastElementChild) body.lastElementChild.innerHTML = '<h4>技能</h4><div style="color:var(--text3);font-size:13px">加载失败</div>';
  }
}

// ── Pair Modal ──
function openPairModal() {
  document.getElementById('pairModal').classList.add('open');
  document.getElementById('pairResult').style.display = 'none';
  document.getElementById('pairAgentId').value = '';
}
function closePairModal() {
  document.getElementById('pairModal').classList.remove('open');
  if (pairPollTimer) { clearInterval(pairPollTimer); pairPollTimer = null; }
}

async function generatePairCode() {
  const agentId = document.getElementById('pairAgentId').value.trim();
  try {
    const resp = await api('/api/pair/init', {
      method: 'POST',
      body: JSON.stringify(agentId ? { agent_id: agentId } : {}),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Failed');

    document.getElementById('pairResult').style.display = 'block';
    const cmdBox = document.getElementById('pairCommand');
    cmdBox.innerHTML = escapeHtml(data.command) + '<button class="copy" onclick="copyText(\\'' + data.command.replace(/'/g, "\\\\'") + '\\')">复制</button>';
    document.getElementById('pairCodeDisplay').textContent = data.pair_code;

    // Poll for connection
    let dots = 0;
    const waitEl = document.getElementById('pairWaiting');
    pairPollTimer = setInterval(async () => {
      dots = (dots + 1) % 4;
      waitEl.textContent = '等待连接' + '.'.repeat(dots);
      try {
        const r = await api('/api/agents');
        const d = await r.json();
        if (d.agents && d.agents.length > 0) {
          clearInterval(pairPollTimer);
          pairPollTimer = null;
          waitEl.innerHTML = '<span style="color:var(--green);font-size:18px">✓ Agent 已连接!</span>';
          await refreshAgents();
          setTimeout(closePairModal, 2000);
        }
      } catch (e) {}
    }, 1000);
  } catch (e) {
    alert('生成失败: ' + e.message);
  }
}

// ── Utils ──
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    event.target.textContent = '✓';
    setTimeout(() => event.target.textContent = '复制', 1500);
  });
}

// ── Init ──
document.getElementById('accessKeyInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

// Auto-login if saved key
(async function init() {
  if (ACCESS_KEY) {
    try {
      const resp = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_key: ACCESS_KEY }),
      });
      const data = await resp.json();
      if (data.ok) { showApp(); return; }
    } catch (e) {}
    localStorage.removeItem('doze_access_key');
    ACCESS_KEY = '';
  }
  // Check if open mode
  try {
    const resp = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await resp.json();
    if (data.ok && data.open) {
      ACCESS_KEY = '';
      showApp();
    }
  } catch (e) {}
})();
</script>
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
  console.log('');
  if (ACCESS_KEY) {
    console.log(`  Access Key: 已启用 (Web UI 需登录)`);
  } else {
    console.log(`  Access Key: 未设置 (开放模式)`);
  }
  console.log('');
  console.log('  等待 Bridge daemon 连接...');
});
