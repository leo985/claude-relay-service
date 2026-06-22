#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Claude Relay Service - 远程日志查看脚本
#
# 用法:
#   ./scripts/remote-logs.sh                       # 列出今日日志文件
#   ./scripts/remote-logs.sh list                  # 列出所有日志文件
#   ./scripts/remote-logs.sh tail                  # 查看今日主日志末尾 100 行
#   ./scripts/remote-logs.sh follow                # 实时跟踪今日主日志
#   ./scripts/remote-logs.sh errors                # 查看今日错误日志末尾
#   ./scripts/remote-logs.sh grep "529"            # 在今日主日志搜索 529
#   ./scripts/remote-logs.sh grep "529" --type error --lines 50
#   ./scripts/remote-logs.sh recent-errors         # 远端汇总最近 30 分钟错误（不拉完整请求体）
#   ./scripts/remote-logs.sh key-errors cr_xxx     # 按 API Key 明文/名称/ID 精确汇总错误
#
# 选项:
#   --type <name>     日志类型: main|error|auth|security|token-refresh|
#                                token-refresh-error|exceptions|rejections
#                      默认: main
#                      注意: main/error 在远程是 service.log/service-error.log (不轮转)
#                            security/auth 是按日轮转
#   --date <YYYY-MM-DD>  日期 (默认: today); 用 latest 表示最新; 仅对按日轮转日志有效
#   --lines <N>       tail/grep 显示行数 (默认: 100, follow 模式忽略)
#   --minutes <N>     recent-errors/key-errors 回看分钟数
#                      recent-errors 默认 30；key-errors 默认 1440
#   --limit <N>       recent-errors/key-errors 输出最近错误条数 (默认: 50)
#   --truncate <N>    grep 输出单行最大字符数 (默认: 800；0 表示不截断)
#   --no-truncate     grep 输出完整行
#   --case-sensitive  grep 区分大小写 (默认不区分)
# ============================================================

# ---------- 配置 (沿用 deploy.sh 的环境变量约定) ----------
REMOTE_USER="${DEPLOY_USER:-ubuntu}"
REMOTE_HOST="${DEPLOY_HOST:-13.229.252.196}"
REMOTE_PORT="${DEPLOY_PORT:-22}"
SSH_KEY="${DEPLOY_KEY:-$(cd "$(dirname "$0")/.." && pwd)/sshkey.pem}"
REMOTE_DIR="${DEPLOY_DIR:-~/claude-relay-service}"
REMOTE_LOGS_DIR="${REMOTE_DIR}/logs"
LOG_TIME_ZONE="${REMOTE_LOG_TZ:-Asia/Shanghai}"

# ---------- 颜色 ----------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
  C_GRAY=$'\033[90m'
else
  C_RESET=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""; C_GRAY=""
fi

# ---------- 参数解析 ----------
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '3,32p' "$0"
  exit 0
fi

ACTION="${1:-list}"
[ "$#" -gt 0 ] && shift

LOG_TYPE="main"
LOG_DATE="today"
LINES=100
MINUTES=30
MINUTES_SET=false
RESULT_LIMIT=50
TRUNCATE_CHARS=800
CASE_SENSITIVE=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --type)
      LOG_TYPE="${2:-}"
      shift 2
      ;;
    --date)
      LOG_DATE="${2:-}"
      shift 2
      ;;
    --lines)
      LINES="${2:-100}"
      shift 2
      ;;
    --minutes)
      MINUTES="${2:-30}"
      MINUTES_SET=true
      shift 2
      ;;
    --limit)
      RESULT_LIMIT="${2:-50}"
      shift 2
      ;;
    --truncate)
      TRUNCATE_CHARS="${2:-800}"
      shift 2
      ;;
    --no-truncate)
      TRUNCATE_CHARS=0
      shift
      ;;
    --case-sensitive)
      CASE_SENSITIVE=true
      shift
      ;;
    -h|--help)
      sed -n '3,26p' "$0"
      exit 0
      ;;
    *)
      # 第一个位置参数当作 grep 关键词
      if [ "$ACTION" = "grep" ] && [ -z "${GREP_PATTERN:-}" ]; then
        GREP_PATTERN="$1"
      elif [ "$ACTION" = "key-errors" ] && [ -z "${KEY_TARGET:-}" ]; then
        KEY_TARGET="$1"
      else
        echo "${C_RED}未知参数: $1${C_RESET}" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

# 快捷动作映射
case "$ACTION" in
  errors|error) ACTION="tail"; LOG_TYPE="error" ;;
  auth)         ACTION="tail"; LOG_TYPE="auth-detail" ;;
  security)     ACTION="tail"; LOG_TYPE="security" ;;
esac

case "$ACTION" in
  list|tail|follow|grep|recent-errors|key-errors) ;;
  *)
    echo "${C_RED}未知动作: $ACTION${C_RESET}" >&2
    echo "合法动作: list | tail | follow | grep | recent-errors | key-errors | errors | auth | security" >&2
    exit 1
    ;;
esac

if [ "$ACTION" = "grep" ] && [ -z "${GREP_PATTERN:-}" ]; then
  echo "${C_RED}grep 动作需要关键词: $0 grep \"keyword\"${C_RESET}" >&2
  exit 1
fi

if [ "$ACTION" = "key-errors" ] && [ -z "${KEY_TARGET:-}" ]; then
  echo "${C_RED}key-errors 动作需要 API Key 明文、名称或 ID: $0 key-errors cr_xxx${C_RESET}" >&2
  exit 1
fi

if [ "$ACTION" = "key-errors" ] && [ "$MINUTES_SET" = false ]; then
  MINUTES=1440
fi

# ---------- SSH 前置检查 ----------
if [ ! -f "$SSH_KEY" ]; then
  echo "${C_RED}找不到 SSH 私钥: $SSH_KEY${C_RESET}" >&2
  echo "可通过 DEPLOY_KEY 环境变量覆盖路径" >&2
  exit 1
fi

SSH_CMD=(ssh -i "$SSH_KEY" -p "$REMOTE_PORT"
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=10
  -o ServerAliveInterval=60
  "${REMOTE_USER}@${REMOTE_HOST}")

# ---------- 辅助函数 ----------
# 解析日期为 YYYY-MM-DD
resolve_date() {
  local d="$1"
  case "$d" in
    today) date +%Y-%m-%d ;;
    yesterday|yd) date -v-1d +%Y-%m-%d 2>/dev/null || date -d yesterday +%Y-%m-%d ;;
    latest) echo "latest" ;;
    *)
      if echo "$d" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
        echo "$d"
      else
        echo "${C_RED}无效日期: $d (需 YYYY-MM-DD)${C_RESET}" >&2
        exit 1
      fi
      ;;
  esac
}

# 映射 --type 到实际文件名 (匹配远程实际部署)
# 远程实际布局 (实测):
#   service.log / service-error.log              — 静态文件 (不轮转)
#   claude-relay-security-YYYY-MM-DD.log         — 按日轮转
#   claude-relay-auth-detail-YYYY-MM-DD.log      — 按日轮转
#   exceptions.log / rejections.log / token-refresh*.log — 静态文件
type_to_prefix() {
  case "$1" in
    main)            echo "service" ;;
    error)           echo "service-error" ;;
    auth|auth-detail) echo "claude-relay-auth-detail" ;;
    security)        echo "claude-relay-security" ;;
    token-refresh)        echo "token-refresh" ;;
    token-refresh-error)  echo "token-refresh-error" ;;
    exceptions)      echo "exceptions" ;;
    rejections)      echo "rejections" ;;
    *)
      echo "${C_RED}未知日志类型: $1${C_RESET}" >&2
      echo "合法类型: main | error | auth | security | token-refresh | token-refresh-error | exceptions | rejections" >&2
      exit 1
      ;;
  esac
}

# 判断该前缀是否为每日轮转 (有 -YYYY-MM-DD 后缀)
is_daily_rotating() {
  case "$1" in
    service|service-error|token-refresh|token-refresh-error|exceptions|rejections) return 1 ;;
    *) return 0 ;;
  esac
}

resolve_filename() {
  local prefix resolved
  prefix="$(type_to_prefix "$LOG_TYPE")"
  if is_daily_rotating "$prefix"; then
    if [ "$LOG_DATE" = "latest" ]; then
      echo "__LATEST__:${prefix}"
    else
      resolved="$(resolve_date "$LOG_DATE")"
      echo "${prefix}-${resolved}.log"
    fi
  else
    echo "${prefix}.log"
  fi
}

shell_quote() {
  printf '%q' "$1"
}

# ---------- 动作: list ----------
do_list() {
  echo "${C_CYAN}远程日志目录: ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_LOGS_DIR}${C_RESET}"
  echo "${C_GRAY}---${C_RESET}"
  "${SSH_CMD[@]}" "cd ${REMOTE_LOGS_DIR} 2>/dev/null && ls -lhS *.log 2>/dev/null \
    | awk '{printf \"%-12s %8s  %s %s\n\", \$5, \$6, \$7, \$9}'" \
    || echo "${C_RED}无法访问远程日志目录${C_RESET}" >&2
}

# ---------- 动作: tail ----------
do_tail() {
  local filename
  filename="$(resolve_filename)"
  echo "${C_GRAY}→ tail -n ${LINES} ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_LOGS_DIR}/${filename}${C_RESET}"
  if [[ "$filename" == __LATEST__:* ]]; then
    local prefix="${filename#__LATEST__\:}"
    "${SSH_CMD[@]}" "cd ${REMOTE_LOGS_DIR} && \
      f=\$(ls -t ${prefix}-*.log 2>/dev/null | head -1); \
      [ -z \"\$f\" ] && { echo '${C_RED}找不到匹配文件${C_RESET}' >&2; exit 1; }; \
      echo '${C_GRAY}最新文件: '\$f'${C_RESET}'; \
      tail -n ${LINES} \"\$f\""
  else
    "${SSH_CMD[@]}" "tail -n ${LINES} ${REMOTE_LOGS_DIR}/${filename} 2>/dev/null \
      || { echo '${C_RED}文件不存在: ${filename}${C_RESET}' >&2; exit 1; }"
  fi
}

# ---------- 动作: follow ----------
do_follow() {
  local filename
  filename="$(resolve_filename)"
  echo "${C_GRAY}→ tail -f ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_LOGS_DIR}/${filename}  (Ctrl+C 退出)${C_RESET}"
  if [[ "$filename" == __LATEST__:* ]]; then
    local prefix="${filename#__LATEST__\:}"
    "${SSH_CMD[@]}" "cd ${REMOTE_LOGS_DIR} && \
      f=\$(ls -t ${prefix}-*.log 2>/dev/null | head -1); \
      [ -z \"\$f\" ] && { echo '${C_RED}找不到匹配文件${C_RESET}' >&2; exit 1; }; \
      echo '${C_GRAY}最新文件: '\$f'${C_RESET}'; \
      tail -f \"\$f\""
  else
    "${SSH_CMD[@]}" "tail -f ${REMOTE_LOGS_DIR}/${filename} 2>/dev/null \
      || { echo '${C_RED}文件不存在: ${filename}${C_RESET}' >&2; exit 1; }"
  fi
}

# ---------- 动作: grep ----------
do_grep() {
  local filename grep_opts="-E" pattern_q
  $CASE_SENSITIVE || grep_opts="-iE"
  filename="$(resolve_filename)"
  pattern_q="$(shell_quote "$GREP_PATTERN")"
  echo "${C_GRAY}→ grep ${GREP_PATTERN} (${LOG_TYPE}, last ${LINES} matches, truncate=${TRUNCATE_CHARS})${C_RESET}"
  if [[ "$filename" == __LATEST__:* ]]; then
    local prefix="${filename#__LATEST__\:}"
    "${SSH_CMD[@]}" "cd ${REMOTE_LOGS_DIR} && \
      f=\$(ls -t ${prefix}-*.log 2>/dev/null | head -1); \
      [ -z \"\$f\" ] && { echo '${C_RED}找不到匹配文件${C_RESET}' >&2; exit 1; }; \
      grep ${grep_opts} -- ${pattern_q} \"\$f\" | tail -n ${LINES} | \
      awk -v max=${TRUNCATE_CHARS} '{ if (max > 0 && length(\$0) > max) print substr(\$0, 1, max) \"... <truncated>\"; else print }'"
  else
    "${SSH_CMD[@]}" "grep ${grep_opts} -- ${pattern_q} ${REMOTE_LOGS_DIR}/${filename} 2>/dev/null \
      | tail -n ${LINES} \
      | awk -v max=${TRUNCATE_CHARS} '{ if (max > 0 && length(\$0) > max) print substr(\$0, 1, max) \"... <truncated>\"; else print }' \
      || echo '${C_YELLOW}无匹配${C_RESET}'"
  fi
}

# ---------- 动作: recent-errors / key-errors ----------
do_error_summary() {
  local mode="$1"
  local target="${2:-}"
  local target_q mode_q minutes_q limit_q log_tz_q

  mode_q="$(shell_quote "$mode")"
  target_q="$(shell_quote "$target")"
  minutes_q="$(shell_quote "$MINUTES")"
  limit_q="$(shell_quote "$RESULT_LIMIT")"
  log_tz_q="$(shell_quote "$LOG_TIME_ZONE")"

  if [ "$mode" = "key" ]; then
    echo "${C_GRAY}→ summarize errors for key ${target} in last ${MINUTES} minutes (remote parse, compact output)${C_RESET}"
  else
    echo "${C_GRAY}→ summarize recent errors in last ${MINUTES} minutes (remote parse, compact output)${C_RESET}"
  fi

  "${SSH_CMD[@]}" "cd ${REMOTE_DIR} && LOG_MODE=${mode_q} TARGET_KEY=${target_q} MINUTES=${minutes_q} RESULT_LIMIT=${limit_q} LOG_TIME_ZONE=${log_tz_q} node" <<'NODE'
const fs = require('fs')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { Readable } = require('stream')
const readline = require('readline')

const mode = process.env.LOG_MODE || 'recent'
const target = process.env.TARGET_KEY || ''
const minutes = Math.max(1, Number.parseInt(process.env.MINUTES || '30', 10) || 30)
const resultLimit = Math.max(1, Number.parseInt(process.env.RESULT_LIMIT || '50', 10) || 50)
const logTimeZone = process.env.LOG_TIME_ZONE || 'Asia/Shanghai'
const logFile = './logs/service.log'

function firstMatch(text, re) {
  const match = text.match(re)
  return match ? match[1] : null
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function zonedParts(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: logTimeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const parts = {}
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  // Some ICU builds format midnight-adjacent times as 24:xx; Date.UTC would roll
  // that to the next day and produce a bogus timezone offset.
  if (parts.hour === 24) parts.hour = 0
  return parts
}

function timeZoneOffsetMs(date) {
  const parts = zonedParts(date)
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  )
  return asUtc - date.getTime()
}

function zonedTimeToUtcMs(parts) {
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  )
  return guess - timeZoneOffsetMs(new Date(guess))
}

function parseHeader(line) {
  const match = line.match(/^(\d{2}):(\d{2}):(\d{2})\s+(.+)$/)
  if (!match) return null
  const now = new Date()
  const today = zonedParts(now)
  const timestampParts = {
    year: today.year,
    month: today.month,
    day: today.day,
    hour: Number(match[1]),
    minute: Number(match[2]),
    second: Number(match[3])
  }
  let timestamp = new Date(zonedTimeToUtcMs(timestampParts))
  if (timestamp.getTime() - now.getTime() > 5 * 60 * 1000) {
    timestamp = new Date(timestamp.getTime() - 24 * 60 * 60 * 1000)
  }
  return {
    time: `${match[1]}:${match[2]}:${match[3]}`,
    timestamp,
    title: match[4]
  }
}

function parseResponse(text) {
  const raw = firstMatch(text, /├─ res: (\{[^\n]+\})/)
  return raw ? safeJsonParse(raw) : null
}

function extractMessage(text, response) {
  return (
    response?.error?.message ||
    response?.message ||
    (typeof response?.error === 'string' ? response.error : null) ||
    firstMatch(text, /"message"\s*:\s*"([^"]+)"/) ||
    firstMatch(text, /message[:=]\s*([^\n]+)/i) ||
    null
  )
}

function extractCode(text, response) {
  return response?.error?.code || response?.code || firstMatch(text, /"code"\s*:\s*"([^"]+)"/) || null
}

function extractModel(text) {
  return (
    firstMatch(text, /"model"\s*:\s*"([^"]+)"/) ||
    firstMatch(text, /requested model: ([^"\s]+)/i) ||
    firstMatch(text, /模型 ([^ 的]+) 的可用渠道失败/) ||
    null
  )
}

function extractStatus(title, text) {
  const fromTitle = firstMatch(title, /^[^\d]*(\d{3})\s+/)
  if (fromTitle) return Number(fromTitle)
  const fromText = firstMatch(text, /status(?:Code)?[:=]\s*(\d{3})/i)
  return fromText ? Number(fromText) : null
}

function isErrorBlock(block, text) {
  const status = extractStatus(block.title, text)
  return (
    (status >= 400 && status < 600) ||
    /OpenAI-Responses API error/.test(block.title) ||
    /Failed to select account/.test(block.title) ||
    /Claude relay error/.test(block.title) ||
    /Stream error: canceled/.test(block.title) ||
    /all_groups_failed|new_api_error|No available accounts/.test(text)
  )
}

async function resolveTargetKeys() {
  if (mode !== 'key') return []

  const config = require('./config/config')
  const Redis = require('ioredis')
  const client = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    tls: config.redis.enableTLS ? {} : undefined,
    maxRetriesPerRequest: 1
  })

  const hits = new Map()
  const targetHash = crypto
    .createHash('sha256')
    .update(target + config.security.encryptionKey)
    .digest('hex')

  function compactKeyData(id, data = {}) {
    return {
      id,
      name: data.name || id,
      isActive: data.isActive || '',
      openaiAccountId: data.openaiAccountId || '',
      claudeAccountId: data.claudeAccountId || '',
      dailyCostLimit: data.dailyCostLimit || '',
      createdAt: data.createdAt || '',
      lastUsedAt: data.lastUsedAt || '',
      expiresAt: data.expiresAt || ''
    }
  }

  async function addHit(id, knownData) {
    if (!id || hits.has(id)) return
    const data = knownData || (await client.hgetall(`apikey:${id}`))
    if (data && Object.keys(data).length > 0) {
      hits.set(id, compactKeyData(id, data))
    }
  }

  try {
    // Fast paths: key id, stored hash, or plaintext API key -> hash_map -> key id.
    if ((await client.type(`apikey:${target}`)) === 'hash') {
      await addHit(target)
    }
    await addHit(await client.hget('apikey:hash_map', target))
    await addHit(await client.hget('apikey:hash_map', targetHash))

    const oldHashData = await client.hgetall(`apikey_hash:${targetHash}`)
    if (oldHashData?.id) {
      await addHit(oldHashData.id)
    }

    // Fallback path: match by display name or repair incomplete hash indexes.
    if (hits.size === 0) {
      let cursor = '0'
      do {
        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', 'apikey:*', 'COUNT', 500)
        cursor = nextCursor
        for (const key of keys) {
          if (key === 'apikey:hash_map' || key.split(':').length !== 2) continue
          if ((await client.type(key)) !== 'hash') continue
          const data = await client.hgetall(key)
          const id = key.slice('apikey:'.length)
          if (id === target || data?.name === target || data?.apiKey === target || data?.apiKey === targetHash) {
            await addHit(id, data)
          }
        }
      } while (cursor !== '0')
    }
  } finally {
    await client.quit()
  }

  return [...hits.values()]
}

function compactError(block) {
  const text = [block.title, ...block.lines].join('\n')
  const response = parseResponse(text)
  const status = extractStatus(block.title, text)
  const keyLine = firstMatch(text, /├─ key: ([^\n]+)/)
  return {
    time: block.time,
    timestamp: block.timestamp.toISOString(),
    status,
    endpoint: firstMatch(block.title, /^[^\d]*\d{3}\s+\w+\s+([^\s]+)/),
    title: block.title,
    requestId: firstMatch(text, /requestId: ([A-Za-z0-9_-]+)/),
    key: keyLine,
    model: extractModel(text),
    errorCode: extractCode(text, response),
    message: extractMessage(text, response),
    ip: firstMatch(text, /├─ ip: ([^\n]+)/),
    ua: firstMatch(text, /├─ ua: ([^\n]+)/)
  }
}

function addSkipReasons(summary, block) {
  const text = block.lines.join('\n')
  const raw = firstMatch(text, /skipReasons: (\[[^\n]+\])/)
  if (!raw) return
  const parsed = safeJsonParse(raw)
  if (!Array.isArray(parsed)) {
    summary.skipReasons.parse_failed = (summary.skipReasons.parse_failed || 0) + 1
    return
  }
  for (const item of parsed) {
    const key = `${item.accountName || item.accountId || 'unknown'} -> ${item.reason || 'unknown'}`
    summary.skipReasons[key] = (summary.skipReasons[key] || 0) + 1
  }
}

function increment(map, key) {
  const normalized = key == null || key === '' ? '<empty>' : String(key)
  map[normalized] = (map[normalized] || 0) + 1
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function main() {
  const targetKeys = await resolveTargetKeys()
  if (mode === 'key' && targetKeys.length === 0) {
    console.log(JSON.stringify({ ok: false, error: 'key_not_found', target }, null, 2))
    return
  }

  const targetIdList = targetKeys.map((item) => item.id).filter(Boolean)
  const targetNameList = targetKeys.map((item) => item.name).filter(Boolean)
  const cutoff = Date.now() - minutes * 60 * 1000
  const summary = {
    ok: true,
    mode,
    target: mode === 'key' ? target : null,
    keys: targetKeys,
    logFile,
    logTimeZone,
    window: {
      minutes,
      start: new Date(cutoff).toISOString(),
      end: new Date().toISOString()
    },
    scannedBlocks: 0,
    matchedBlocks: 0,
    totalErrors: 0,
    byStatus: {},
    byCode: {},
    byEndpoint: {},
    byModel: {},
    byKey: {},
    byMessage: {},
    byIp: {},
    byUserAgent: {},
    skipReasons: {},
    recentErrors: []
  }

  function hasKnownTarget(text) {
    if (!text) return false
    return (
      targetIdList.some((id) => text.includes(id)) ||
      targetNameList.some((name) => text.includes(name))
    )
  }

  function hasKnownTargetPair(text) {
    for (const id of targetIdList) {
      for (const name of targetNameList) {
        if (text.includes(`${name} (${id})`) || text.includes(`${id} (${name})`)) {
          return true
        }
      }
    }
    return false
  }

  function isTargetReferenceLine(line) {
    if (mode !== 'key') return true
    if (!hasKnownTarget(line)) return false
    return /├─ key:/.test(line) || /\bfor key:/.test(line) || hasKnownTargetPair(line)
  }

  function blockMatchesTarget(text) {
    if (mode !== 'key') return true

    const keyLine = firstMatch(text, /├─ key: ([^\n]+)/) || ''
    if (hasKnownTarget(keyLine) || hasKnownTargetPair(text)) return true

    return (
      targetIdList.some((id) => text.includes(`for key: ${id}`) || text.includes(`key: ${id} (`)) ||
      targetNameList.some((name) => text.includes(`for key: ${name}`))
    )
  }

  function startBlock(header) {
    return {
      ...header,
      lines: [],
      prefixLines: [],
      capture: mode !== 'key' || isTargetReferenceLine(header.title)
    }
  }

  function fullLogInput(warning) {
    return {
      stream: fs.createReadStream(logFile, { encoding: 'utf8' }),
      scanMode: 'full-scan',
      warning
    }
  }

  function openLogInput() {
    if (mode !== 'key' || targetIdList.length === 0) {
      return fullLogInput()
    }

    const args = ['-E', '-B', '8', '-A', '4']
    for (const id of targetIdList) {
      args.push('-e', `├─ key: .*\\(${escapeRegExp(id)}\\)`)
    }
    args.push('--', logFile)

    try {
      const text = execFileSync('grep', args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      })
      if (text.trim()) {
        return {
          stream: Readable.from([text]),
          scanMode: 'grep-context'
        }
      }
      return fullLogInput('grep returned no key contexts')
    } catch (error) {
      if (error.status === 1) {
        return fullLogInput('grep returned no key contexts')
      }
      return fullLogInput(`grep prefilter failed: ${error.message}`)
    }
  }

  let current = null
  async function processBlock(block) {
    if (!block) return
    summary.scannedBlocks += 1
    if (block.timestamp.getTime() < cutoff) return
    if (mode === 'key' && !block.capture) return

    const text = [block.title, ...block.lines].join('\n')
    if (!blockMatchesTarget(text)) return
    summary.matchedBlocks += 1

    if (!isErrorBlock(block, text)) return

    const item = compactError(block)
    summary.totalErrors += 1
    increment(summary.byStatus, item.status)
    increment(summary.byCode, item.errorCode)
    increment(summary.byEndpoint, item.endpoint)
    increment(summary.byModel, item.model)
    if (item.key) increment(summary.byKey, item.key)
    increment(summary.byMessage, item.message || item.title)
    increment(summary.byIp, item.ip)
    increment(summary.byUserAgent, item.ua)
    addSkipReasons(summary, block)

    summary.recentErrors.push(item)
    if (summary.recentErrors.length > resultLimit) {
      summary.recentErrors.shift()
    }
  }

  const logInput = openLogInput()
  summary.logScanMode = logInput.scanMode
  if (logInput.warning) summary.logScanWarning = logInput.warning

  const rl = readline.createInterface({ input: logInput.stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (line === '--') {
      await processBlock(current)
      current = null
      continue
    }
    const header = parseHeader(line)
    if (header) {
      await processBlock(current)
      current = startBlock(header)
    } else if (current) {
      if (mode !== 'key' || current.capture) {
        current.lines.push(line)
      } else {
        const targetLine = isTargetReferenceLine(line)
        if (current.prefixLines.length < 32) {
          current.prefixLines.push(line)
        }
        if (targetLine) {
          current.capture = true
          current.lines =
            current.prefixLines[current.prefixLines.length - 1] === line
              ? current.prefixLines.slice()
              : [...current.prefixLines, line]
        }
      }
    }
  }
  await processBlock(current)

  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2))
  process.exit(1)
})
NODE
}

# ---------- 执行 ----------
case "$ACTION" in
  list)          do_list ;;
  tail)          do_tail ;;
  follow)        do_follow ;;
  grep)          do_grep ;;
  recent-errors) do_error_summary "recent" ;;
  key-errors)    do_error_summary "key" "$KEY_TARGET" ;;
esac
