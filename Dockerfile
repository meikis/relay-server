# Dockerfile — Doze Relay
# 用于 Fly.io / 任何容器平台（Railway / Render / 自建）

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
ENV PORT=4000
ENV HOST=0.0.0.0

# 暴露端口
EXPOSE 4000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:4000/health || exit 1

# 启动
CMD ["node", "relay.js"]
