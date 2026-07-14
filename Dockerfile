# Dockerfile — Doze Relay
# 用于 Fly.io / Railway / Render / 任何容器平台

FROM node:20-alpine AS base

# 设置工作目录
WORKDIR /app

# 复制 package.json 并安装依赖
COPY package.json ./
RUN npm install --production

# 复制 Relay 源码
COPY relay.js ./

# 设置环境变量
ENV NODE_ENV=production
ENV HOST=0.0.0.0
# PORT 由平台自动注入 (Railway/Render/Fly.io)
# 本地运行时默认 4000
ENV PORT=4000

# 暴露端口
EXPOSE 4000

# 健康检查 (使用 wget，alpine 自带)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT:-4000}/health || exit 1

# 启动
CMD ["node", "relay.js"]
