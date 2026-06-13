#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Claude Relay Service - 一键发布脚本
# 用法: ./scripts/deploy.sh [选项]
#   --skip-build    跳过本地前端构建
#   --dry-run       仅显示将要执行的命令，不实际执行
# ============================================================

# ---------- 配置 ----------
REMOTE_USER="${DEPLOY_USER:-ubuntu}"
REMOTE_HOST="${DEPLOY_HOST:-13.229.252.196}"
REMOTE_PORT="${DEPLOY_PORT:-22}"
SSH_KEY="${DEPLOY_KEY:-$(cd "$(dirname "$0")/.." && pwd)/sshkey.pem}"
REMOTE_DIR="${DEPLOY_DIR:-~/claude-relay-service}"

SKIP_BUILD=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --dry-run)    DRY_RUN=true ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

SSH_CMD="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${SSH_KEY} -p ${REMOTE_PORT} ${REMOTE_USER}@${REMOTE_HOST}"
RSYNC_CMD="rsync -avz --delete -e \"ssh -o StrictHostKeyChecking=no -i ${SSH_KEY} -p ${REMOTE_PORT}\""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "============================================"
echo "  Claude Relay Service - 一键发布"
echo "============================================"
echo "目标服务器: ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PORT}"
echo "远程目录:   ${REMOTE_DIR}"
echo "项目目录:   ${PROJECT_DIR}"
echo "============================================"

run() {
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] $*"
  else
    echo ">>> $*"
    eval "$@"
  fi
}

# ---------- Step 1: 本地构建前端 ----------
if [ "$SKIP_BUILD" = false ]; then
  echo ""
  echo "[1/5] 构建前端..."
  if [ -d "${PROJECT_DIR}/web/admin-spa" ]; then
    run "cd ${PROJECT_DIR}/web/admin-spa && npm install && npm run build"
  else
    echo "  跳过: 未找到前端项目目录"
  fi
else
  echo ""
  echo "[1/5] 跳过前端构建 (--skip-build)"
fi

# ---------- Step 2: 同步源码 ----------
echo ""
echo "[2/5] 同步源码到服务器..."
run "rsync -avz --delete \\
  -e 'ssh -o StrictHostKeyChecking=no -i ${SSH_KEY} -p ${REMOTE_PORT}' \\
  --exclude='node_modules/' \\
  --exclude='.env' \\
  --exclude='data/' \\
  --exclude='logs/' \\
  --exclude='config/config.js' \\
  --exclude='.git/' \\
  --exclude='sshkey.pem' \\
  --exclude='web/admin-spa/dist/' \\
  --exclude='web/admin-spa/node_modules/' \\
  --exclude='coverage/' \\
  --exclude='.DS_Store' \\
  --exclude='*.log' \\
  --exclude='tmp/' \\
  --exclude='.claude/' \\
  --exclude='.mcp.json' \\
  --exclude='claude-relay-service.pid' \\
  ${PROJECT_DIR}/ ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

# ---------- Step 3: 同步前端构建产物 ----------
echo ""
echo "[3/5] 同步前端构建产物..."
if [ -d "${PROJECT_DIR}/web/admin-spa/dist" ]; then
  run "rsync -avz --delete \\
    -e 'ssh -o StrictHostKeyChecking=no -i ${SSH_KEY} -p ${REMOTE_PORT}' \\
    ${PROJECT_DIR}/web/admin-spa/dist/ ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/web/admin-spa/dist/"
else
  echo "  跳过: 本地未找到 dist 目录，请先构建前端"
fi

# ---------- Step 4: 服务器上安装依赖 ----------
echo ""
echo "[4/5] 安装服务器端依赖..."
run "${SSH_CMD} 'cd ${REMOTE_DIR} && npm install --production 2>&1 | tail -5'"

# ---------- Step 5: 重启服务 ----------
echo ""
echo "[5/5] 重启服务..."
run "${SSH_CMD} 'cd ${REMOTE_DIR} && node scripts/manage.js restart -d 2>&1'"

# ---------- 验证 ----------
echo ""
echo "等待服务启动..."
sleep 8

echo ""
echo "验证服务状态..."
run "${SSH_CMD} 'curl -s http://localhost:3000/health'"

echo ""
echo "============================================"
echo "  发布完成!"
echo "============================================"
echo "管理界面: http://${REMOTE_HOST}:3000/admin-next/api-stats"
echo "健康检查: http://${REMOTE_HOST}:3000/health"
echo ""
echo "服务管理命令:"
echo "  ${SSH_CMD} 'cd ${REMOTE_DIR} && node scripts/manage.js status'"
echo "  ${SSH_CMD} 'cd ${REMOTE_DIR} && node scripts/manage.js logs'"
echo "  ${SSH_CMD} 'cd ${REMOTE_DIR} && node scripts/manage.js restart -d'"
echo "  ${SSH_CMD} 'cd ${REMOTE_DIR} && node scripts/manage.js stop'"
echo "============================================"
