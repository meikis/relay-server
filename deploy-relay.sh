#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Doze Relay 一键部署脚本
#
# 用法:
#   ./deploy-relay.sh railway    # 部署到 Railway
#   ./deploy-relay.sh render     # 部署到 Render
#   ./deploy-relay.sh fly        # 部署到 Fly.io
#   ./deploy-relay.sh local      # 本地运行（测试用）
#   ./deploy-relay.sh docker     # Docker 构建并运行
#
# 前提:
#   - railway: 已安装 Railway CLI (npm i -g @railway/cli)
#   - render:  已安装 Render CLI 或通过网页部署
#   - fly:     已安装 flyctl (https://fly.io/docs/hands-on/install-flyctl/)
#   - docker:  已安装 Docker
# ═══════════════════════════════════════════════════════════════

set -e

PLATFORM="${1:-local}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}  [✓]${RESET} $1"; }
bad()  { echo -e "${RED}  [✗]${RESET} $1"; }
inf()  { echo -e "${CYAN}  [i]${RESET} $1"; }
hdr()  { echo -e "\n${BOLD}${YELLOW}══ $1 ══${RESET}"; }

# ── 检查 relay.js 是否存在 ──────────────────────────────────
check_relay() {
  if [ ! -f "$DEPLOY_DIR/relay.js" ]; then
    # 从上级目录复制
    if [ -f "$DEPLOY_DIR/../relay.js" ]; then
      inf "复制 relay.js 到部署目录..."
      cp "$DEPLOY_DIR/../relay.js" "$DEPLOY_DIR/relay.js"
      ok "relay.js 已复制"
    else
      bad "未找到 relay.js！请确保文件在 $DEPLOY_DIR/ 或上级目录"
      exit 1
    fi
  fi
}

# ═══════════════════════════════════════════════════════════════
# Railway 部署
# ═══════════════════════════════════════════════════════════════
deploy_railway() {
  hdr "部署到 Railway"
  inf "Railway: 简单易用，支持 WebSocket，$5/月免费额度"

  # 检查 Railway CLI
  if ! command -v railway &>/dev/null; then
    inf "安装 Railway CLI..."
    npm install -g @railway/cli
  fi
  ok "Railway CLI 已就绪"

  # 登录
  inf "请登录 Railway（浏览器会自动打开）..."
  railway login || true

  # 创建项目并部署
  inf "创建新项目并部署..."
  cd "$DEPLOY_DIR"
  railway init --name doze-relay || railway link
  railway up

  inf "部署中... 请在 Railway Dashboard 查看进度"
  echo ""
  echo "  ════════════════════════════════════════════"
  echo "  部署完成后:"
  echo ""
  echo "  1. 在 Railway Dashboard → Settings → Networking"
  echo "     点击 Generate Domain 获取公网地址"
  echo "     如: https://doze-relay-production.up.railway.app"
  echo ""
  echo "  2. 设置环境变量:"
  echo "     在 Railway Dashboard → Variables 中添加:"
  echo "     DOZE_ACCESS_KEY=your-access-key-123"
  echo ""
  echo "  3. 生成配对命令:"
  echo "     方法 A: 在 Web UI 中点击「配对」按钮"
  echo "     方法 B: curl -X POST https://doze-relay-production.up.railway.app/api/pair/init \\"
  echo "       -H 'Authorization: Bearer YOUR_ACCESS_KEY'"
  echo ""
  echo "  4. 在本地机器执行配对命令:"
  echo "     npx -y doze-bridge --pat-token=sat_xxx --pair-code=xxxx \\"
  echo "       --relay-url=https://doze-relay-production.up.railway.app"
  echo ""
  echo "  5. 使用 Web UI 聊天:"
  echo "     浏览器打开 https://doze-relay-production.up.railway.app/"
  echo "     输入 Access Key 登录即可聊天"
  echo "  ════════════════════════════════════════════"
}

# ═══════════════════════════════════════════════════════════════
# Render 部署
# ═══════════════════════════════════════════════════════════════
deploy_render() {
  hdr "部署到 Render"
  inf "Render: 免费套餐 750h/月，支持 WebSocket"

  echo ""
  echo "  Render 推荐通过网页 Blueprint 部署:"
  echo ""
  echo "  1. 将本仓库推送到 GitHub/GitLab"
  echo "  2. 打开 https://dashboard.render.com/blueprints"
  echo "  3. 选择你的仓库"
  echo "  4. Render 会自动识别 render.yaml 配置"
  echo "  5. 点击 Apply"
  echo ""
  echo "  或者手动创建 Web Service:"
  echo "  1. 打开 https://dashboard.render.com/create"
  echo "  2. 选择 Node.js"
  echo "  3. Build Command:  npm install"
  echo "  4. Start Command:  node relay.js"
  echo "  5. Health Check:   /health"
  echo ""
  echo "  部署完成后获得地址如:"
  echo "  https://doze-relay.onrender.com"
  echo ""
  echo "  ⚠ Render 免费套餐 15 分钟无请求会休眠"
  echo "    首次请求有 30-60 秒冷启动延迟"
}

# ═══════════════════════════════════════════════════════════════
# Fly.io 部署
# ═══════════════════════════════════════════════════════════════
deploy_fly() {
  hdr "部署到 Fly.io"
  inf "Fly.io: 3 个免费 VM，支持 WebSocket，全球边缘节点"

  # 检查 flyctl
  if ! command -v flyctl &>/dev/null; then
    bad "未安装 flyctl"
    inf "安装方法:"
    echo "  macOS:   brew install flyctl"
    echo "  Linux:   curl -L https://fly.io/install.sh | sh"
    echo "  Windows: pwsh -Command 'iwr https://fly.io/install.ps1 -useb | iex'"
    exit 1
  fi
  ok "flyctl 已就绪"

  cd "$DEPLOY_DIR"

  # 登录
  inf "请登录 Fly.io..."
  flyctl auth login

  # 创建应用
  inf "创建 Fly.io 应用..."
  flyctl launch --no-deploy --dockerfile Dockerfile --name doze-relay || true

  # 部署
  inf "部署中..."
  flyctl deploy

  # 获取地址
  inf "应用信息:"
  flyctl info

  echo ""
  echo "  部署完成后获得地址如:"
  echo "  https://doze-relay.fly.dev"
  echo ""
  echo "  生成配对命令:"
  echo "  curl -X POST https://doze-relay.fly.dev/api/pair/init"
}

# ═══════════════════════════════════════════════════════════════
# Docker 本地部署
# ═══════════════════════════════════════════════════════════════
deploy_docker() {
  hdr "Docker 本地部署"
  inf "使用 Docker 构建并运行 Relay"

  if ! command -v docker &>/dev/null; then
    bad "未安装 Docker"
    inf "安装方法: https://docs.docker.com/get-docker/"
    exit 1
  fi
  ok "Docker 已就绪"

  cd "$DEPLOY_DIR"

  # 构建
  inf "构建镜像..."
  docker build -t doze-relay .

  # 运行
  inf "启动容器..."
  docker run -d --name doze-relay -p 4000:4000 --restart unless-stopped \
    -e DOZE_ACCESS_KEY=your-access-key-123 \
    doze-relay

  ok "Relay 已启动: http://localhost:4000"
  echo ""
  echo "  浏览器打开 http://localhost:4000 输入 Access Key 即可使用"
  echo "  生成配对命令:"
  echo "  curl -X POST http://localhost:4000/api/pair/init -H 'Authorization: Bearer your-access-key-123'"
  echo ""
  echo "  查看日志:   docker logs doze-relay"
  echo "  停止:       docker stop doze-relay"
  echo "  重启:       docker restart doze-relay"
}

# ═══════════════════════════════════════════════════════════════
# 本地运行（测试用）
# ═══════════════════════════════════════════════════════════════
deploy_local() {
  hdr "本地运行（测试用）"
  inf "直接在本机运行 Relay，适合开发测试"

  cd "$DEPLOY_DIR"

  if [ ! -d node_modules ]; then
    inf "安装依赖..."
    npm install
  fi
  ok "依赖已就绪"

  inf "启动 Relay (端口 4000)..."
  echo ""
  node relay.js --port 4000
}

# ═══════════════════════════════════════════════════════════════
# 主逻辑
# ═══════════════════════════════════════════════════════════════

echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║  Doze Relay v2 部署工具                   ║"
echo "║  Web UI + Access Key 授权 + Frontier WS   ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${RESET}"

check_relay

case "$PLATFORM" in
  railway) deploy_railway ;;
  render)  deploy_render ;;
  fly)     deploy_fly ;;
  docker)  deploy_docker ;;
  local)   deploy_local ;;
  *)
    echo "用法: $0 <platform>"
    echo ""
    echo "  railway  — 部署到 Railway (推荐，最简单)"
    echo "  render   — 部署到 Render (免费 750h/月)"
    echo "  fly      — 部署到 Fly.io (全球边缘节点)"
    echo "  docker   — Docker 本地构建运行"
    echo "  local    — 本地直接运行（测试用）"
    echo ""
    echo "⚠ Vercel 不支持 WebSocket，无法部署 Relay"
    echo "  详见 VERCEL.md"
    exit 1
    ;;
esac
