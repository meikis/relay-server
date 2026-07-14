# Vercel 适用性分析

## 结论：❌ Vercel 不适合部署 Doze Relay

### 原因

Doze Relay 的核心功能依赖以下两个特性，而 Vercel 都不支持：

| 特性 | Relay 需求 | Vercel 支持 | 说明 |
|------|-----------|-----------|------|
| **WebSocket 服务器** | 需要 doze-server 主动建立 WebSocket 长连接 | ❌ 不支持 | Vercel 是 Serverless，函数执行完即销毁，无法维持 WebSocket 服务器 |
| **SSE 流式响应** | 需要保持 HTTP 连接数十秒持续推送数据 | ⚠️ 有限支持 | Vercel Edge Functions 支持 SSE 但有 25s 超时限制，且无法与 WebSocket 联动 |
| **长连接持久化** | doze-server 的 WebSocket 连接需要一直保持 | ❌ 不支持 | Serverless 函数是临时的，没有持久内存 |
| **全局状态** | 需要在内存中存储已连接的 doze-server | ❌ 不支持 | 每次请求可能分配到不同的函数实例 |

### Vercel 的替代方案

如果你只有 Vercel 账号，可以考虑以下方案：

1. **Vercel + 外部 WebSocket 服务**
   - 在 Vercel 部署一个 HTTP 网关
   - 使用 Pusher / Ably / Socket.io Cloud 作为 WebSocket 层
   - 复杂度较高，不推荐

2. **Cloudflare Workers + Durable Objects** (推荐的高级方案)
   - Cloudflare Workers 支持 WebSocket
   - Durable Objects 可以维护持久状态
   - 免费套餐每天 100,000 请求
   - 需要改写 Relay 代码适配 Workers API

3. **直接使用 Railway / Render / Fly.io** (最简单推荐)
   - 这些平台都支持长运行进程和 WebSocket
   - 免费套餐足够使用
   - 部署方式见 DEPLOY.md

## 推荐的免费平台对比

| 平台 | 免费额度 | WebSocket | SSE | 部署难度 | 推荐度 |
|------|---------|-----------|-----|---------|--------|
| **Railway** | $5/月额度 | ✅ | ✅ | ⭐ 最简单 | ⭐⭐⭐⭐⭐ |
| **Render** | 750h/月 | ✅ | ✅ | ⭐⭐ 简单 | ⭐⭐⭐⭐ |
| **Fly.io** | 3 VM + 3GB | ✅ | ✅ | ⭐⭐⭐ 中等 | ⭐⭐⭐⭐ |
| **Vercel** | 100GB 带宽 | ❌ | ⚠️ 有限 | — | ❌ 不适用 |
| **Cloudflare Workers** | 100k 请求/天 | ✅ (DO) | ✅ | ⭐⭐⭐⭐ 需改写 | ⭐⭐⭐ |
