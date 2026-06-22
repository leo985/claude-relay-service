#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Claude Relay Service - 一键发布脚本
# 用法: ./scripts/deploy.sh [选项]
#   --skip-build         跳过本地前端构建
#   --dry-run            仅显示将要执行的命令，不实际执行
#   --no-auto-rollback   发布失败时不自动回滚
#   --rollback <path|latest>  回滚到指定备份；latest 表示最近一次备份
# ============================================================

# ---------- 配置 ----------
REMOTE_USER="${DEPLOY_USER:-ubuntu}"
REMOTE_HOST="${DEPLOY_HOST:-13.229.252.196}"
REMOTE_PORT="${DEPLOY_PORT:-22}"
SSH_KEY="${DEPLOY_KEY:-$(cd "$(dirname "$0")/.." && pwd)/sshkey.pem}"
REMOTE_DIR="${DEPLOY_DIR:-~/claude-relay-service}"
BACKUP_DIR="${DEPLOY_BACKUP_DIR:-~/claude-relay-backups}"
BACKUP_NAME="claude-relay-service-$(date +%Y%m%d-%H%M%S).tar.gz"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

SKIP_BUILD=false
DRY_RUN=false
AUTO_ROLLBACK=true
BACKUP_CREATED=false
ROLLBACK_ONLY=false
ROLLBACK_TARGET=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --no-auto-rollback)
      AUTO_ROLLBACK=false
      shift
      ;;
    --rollback)
      ROLLBACK_ONLY=true
      ROLLBACK_TARGET="${2:-}"
      if [ -z "$ROLLBACK_TARGET" ]; then
        echo "--rollback 需要指定备份路径或 latest"
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "未知参数: $1"
      exit 1
      ;;
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
echo "备份目录:   ${BACKUP_DIR}"
echo "============================================"

run() {
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] $*"
  else
    echo ">>> $*"
    eval "$@"
  fi
}

rollback() {
  local target="${1:-$BACKUP_PATH}"

  if [ "$AUTO_ROLLBACK" != true ]; then
    echo "自动回滚已关闭 (--no-auto-rollback)，请手动检查服务器状态。"
    return 0
  fi

  if [ -z "${1:-}" ] && [ "$BACKUP_CREATED" != true ]; then
    echo "未创建备份，跳过自动回滚。"
    return 0
  fi

  echo ""
  echo "============================================"
  if [ "$ROLLBACK_ONLY" = true ]; then
    echo "  开始回滚"
  else
    echo "  发布失败，开始自动回滚"
  fi
  echo "============================================"
  echo "备份文件: ${target}"

  local rollback_cmd="set -e; BACKUP_FILE=\"${target}\"; if [ \"\$BACKUP_FILE\" = \"latest\" ]; then BACKUP_FILE=\$(ls -t ${BACKUP_DIR}/claude-relay-service-*.tar.gz 2>/dev/null | head -1); fi; case \"\$BACKUP_FILE\" in \"~/\"*) BACKUP_FILE=\"\$HOME/\${BACKUP_FILE#~/}\" ;; esac; if [ -z \"\$BACKUP_FILE\" ] || [ ! -f \"\$BACKUP_FILE\" ]; then echo \"Backup not found: \$BACKUP_FILE\"; exit 1; fi; TMP_DIR=\$(mktemp -d /tmp/claude-relay-rollback.XXXXXX); tar -xzf \"\$BACKUP_FILE\" -C \$TMP_DIR; rsync -a --delete --exclude='.env' --exclude='data/' --exclude='logs/' --exclude='node_modules/' --exclude='config/config.js' --exclude='sshkey.pem' \$TMP_DIR/ ${REMOTE_DIR}/; rm -rf \$TMP_DIR; cd ${REMOTE_DIR} && npm install --production && node scripts/manage.js restart -d 2>&1"

  if run "${SSH_CMD} '${rollback_cmd}'"; then
    if [ "$ROLLBACK_ONLY" = true ]; then
      echo "回滚完成。"
    else
      echo "自动回滚完成。"
    fi
    return 0
  else
    echo "回滚失败，请手动处理。备份文件: ${target}"
    return 1
  fi
}

on_error() {
  local exit_code=$?
  trap - ERR
  echo ""
  echo "发布失败，退出码: ${exit_code}"
  rollback
  exit "${exit_code}"
}

if [ "$ROLLBACK_ONLY" = true ]; then
  rollback "$ROLLBACK_TARGET"
  exit $?
fi

trap on_error ERR

# ---------- Step 1: 本地构建前端 ----------
if [ "$SKIP_BUILD" = false ]; then
  echo ""
  echo "[1/6] 构建前端..."
  if [ -d "${PROJECT_DIR}/web/admin-spa" ]; then
    run "cd ${PROJECT_DIR}/web/admin-spa && npm install && npm run build"
  else
    echo "  跳过: 未找到前端项目目录"
  fi
else
  echo ""
  echo "[1/6] 跳过前端构建 (--skip-build)"
fi

# ---------- Step 2: 备份当前版本 ----------
echo ""
echo "[2/6] 备份服务器当前版本..."
run "${SSH_CMD} 'mkdir -p ${BACKUP_DIR} && cd ${REMOTE_DIR} && tar --exclude=\"./node_modules\" --exclude=\"./logs\" --exclude=\"./data\" --exclude=\"./.env\" --exclude=\"./config/config.js\" --exclude=\"./sshkey.pem\" --exclude=\"./.git\" --exclude=\"./tmp\" --exclude=\"./coverage\" -czf ${BACKUP_PATH} .'"
if [ "$DRY_RUN" = false ]; then
  BACKUP_CREATED=true
fi
echo "备份文件: ${BACKUP_PATH}"

# ---------- Step 3: 同步源码 ----------
echo ""
echo "[3/6] 同步源码到服务器..."
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

# ---------- Step 4: 同步前端构建产物 ----------
echo ""
echo "[4/6] 同步前端构建产物..."
if [ -d "${PROJECT_DIR}/web/admin-spa/dist" ]; then
  run "rsync -avz --delete \\
    -e 'ssh -o StrictHostKeyChecking=no -i ${SSH_KEY} -p ${REMOTE_PORT}' \\
    ${PROJECT_DIR}/web/admin-spa/dist/ ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/web/admin-spa/dist/"
else
  echo "  跳过: 本地未找到 dist 目录，请先构建前端"
fi

# ---------- Step 5: 服务器上安装依赖 ----------
echo ""
echo "[5/6] 安装服务器端依赖..."
run "${SSH_CMD} 'cd ${REMOTE_DIR} && npm install --production'"

# ---------- Step 6: 重启服务 ----------
echo ""
echo "[6/6] 重启服务..."
run "${SSH_CMD} 'cd ${REMOTE_DIR} && node scripts/manage.js restart -d 2>&1'"

# ---------- 验证 ----------
echo ""
echo "等待服务启动..."
sleep 8

echo ""
echo "验证服务状态..."
run "${SSH_CMD} 'curl -fsS http://localhost:3000/health'"

echo ""
echo "============================================"
echo "  发布完成!"
echo "============================================"
echo "本次备份: ${BACKUP_PATH}"
echo "手动回滚: ./scripts/deploy.sh --rollback ${BACKUP_PATH}"
echo "管理界面: http://${REMOTE_HOST}:3000/admin-next/api-stats"
echo "健康检查: http://${REMOTE_HOST}:3000/health"
echo ""
echo "服务管理命令:"
echo "  ${SSH_CMD} 'cd ${REMOTE_DIR} && node scripts/manage.js status'"
echo "  ${SSH_CMD} 'cd ${REMOTE_DIR} && node scripts/manage.js logs'"
echo "  ${SSH_CMD} 'cd ${REMOTE_DIR} && node scripts/manage.js restart -d'"
echo "  ${SSH_CMD} 'cd ${REMOTE_DIR} && node scripts/manage.js stop'"
echo "============================================"
