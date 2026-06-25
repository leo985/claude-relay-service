const CATEGORY_META = {
  auth_error: {
    key: 'auth_error',
    label: '认证失败',
    currentLabel: '认证异常',
    severity: 'critical'
  },
  rate_limit: {
    key: 'rate_limit',
    label: '限流',
    currentLabel: '限流中',
    severity: 'warning'
  },
  service_unavailable: {
    key: 'service_unavailable',
    label: '服务不可用',
    currentLabel: '服务不可用',
    severity: 'warning'
  },
  overload: {
    key: 'overload',
    label: '上游过载',
    currentLabel: '上游过载',
    severity: 'warning'
  },
  timeout: {
    key: 'timeout',
    label: '超时',
    currentLabel: '请求超时',
    severity: 'warning'
  },
  server_error: {
    key: 'server_error',
    label: '服务端错误',
    currentLabel: '服务端异常',
    severity: 'error'
  },
  quota_exceeded: {
    key: 'quota_exceeded',
    label: '配额不足',
    currentLabel: '配额不足',
    severity: 'critical'
  },
  temp_unavailable: {
    key: 'temp_unavailable',
    label: '临时暂停',
    currentLabel: '临时暂停',
    severity: 'warning'
  },
  manual_paused: {
    key: 'manual_paused',
    label: '手动停调',
    currentLabel: '手动停调',
    severity: 'neutral'
  },
  expired: {
    key: 'expired',
    label: '已过期',
    currentLabel: '已过期',
    severity: 'critical'
  },
  account_blocked: {
    key: 'account_blocked',
    label: '账号封锁',
    currentLabel: '账号封锁',
    severity: 'critical'
  },
  unknown_error: {
    key: 'unknown_error',
    label: '其他异常',
    currentLabel: '其他异常',
    severity: 'error'
  }
}

const CATEGORY_PRIORITY = [
  'account_blocked',
  'auth_error',
  'quota_exceeded',
  'expired',
  'rate_limit',
  'overload',
  'temp_unavailable',
  'service_unavailable',
  'timeout',
  'server_error',
  'manual_paused',
  'unknown_error'
]

const ACCOUNT_TYPE_BY_PLATFORM = {
  claude: 'claude-official',
  'claude-oauth': 'claude-official',
  'claude-official': 'claude-official',
  'claude-console': 'claude-console',
  openai: 'openai',
  'openai-responses': 'openai-responses',
  gemini: 'gemini',
  'gemini-api': 'gemini-api',
  droid: 'droid',
  bedrock: 'bedrock',
  ccr: 'ccr',
  azure_openai: 'azure-openai',
  'azure-openai': 'azure-openai'
}

function getExceptionCategoryMeta(key) {
  return CATEGORY_META[key] || CATEGORY_META.unknown_error
}

function normalizeAccountType(platform) {
  return ACCOUNT_TYPE_BY_PLATFORM[platform] || platform || 'unknown'
}

function normalizeStatusCode(statusCode) {
  const code = Number(statusCode)
  return Number.isFinite(code) && code > 0 ? Math.floor(code) : null
}

function normalizeText(value) {
  return value === undefined || value === null ? '' : String(value).trim().toLowerCase()
}

function truthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function classifyErrorEvent({ statusCode, errorType, context } = {}) {
  const normalizedStatus = normalizeStatusCode(statusCode)
  const type = normalizeText(errorType || context?.errorType || context?.type || context?.code)
  const status = normalizeText(context?.status)

  if (type === 'auth_error' || type === 'unauthorized' || type === 'token_refresh_failed') {
    return 'auth_error'
  }
  if (type === 'rate_limit' || type === 'rate_limited') {
    return 'rate_limit'
  }
  if (type === 'service_unavailable') {
    return 'service_unavailable'
  }
  if (type === 'overload' || type === 'overloaded') {
    return 'overload'
  }
  if (type === 'timeout' || type === 'request_timeout') {
    return 'timeout'
  }
  if (type === 'server_error' || type === 'internal_error') {
    return 'server_error'
  }
  if (type === 'quota_exceeded' || status === 'quota_exceeded') {
    return 'quota_exceeded'
  }
  if (type === 'temp_unavailable') {
    return 'temp_unavailable'
  }
  if (type === 'manual_paused') {
    return 'manual_paused'
  }
  if (type === 'expired') {
    return 'expired'
  }
  if (type === 'account_blocked' || status === 'blocked' || status === 'account_blocked') {
    return 'account_blocked'
  }

  if (normalizedStatus === 401 || normalizedStatus === 403) {
    return 'auth_error'
  }
  if (normalizedStatus === 429) {
    return 'rate_limit'
  }
  if (normalizedStatus === 503) {
    return 'service_unavailable'
  }
  if (normalizedStatus === 529) {
    return 'overload'
  }
  if (normalizedStatus === 504) {
    return 'timeout'
  }
  if (normalizedStatus >= 500) {
    return 'server_error'
  }

  return 'unknown_error'
}

function extractRecoverAt(source = {}) {
  const candidates = [
    source.expiresAt,
    source.rateLimitResetAt,
    source.rateLimitUntil,
    source.resetAt,
    source.recoverAt,
    source.quotaResetAt
  ]

  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }
    const date = new Date(candidate)
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString()
    }
  }
  return null
}

function buildReason(category, text, details = {}) {
  return {
    category,
    text,
    recoverAt: extractRecoverAt(details)
  }
}

function classifyCurrentAccountStatus(account = {}) {
  const reasons = []
  const { rateLimitStatus, schedulable } = account
  const status = normalizeText(account.status || account.accountStatus)
  const tempUnavailable = account.tempUnavailable || account.temp_unavailable
  const now = Date.now()

  if (status === 'blocked' || status === 'account_blocked' || truthy(account.blocked)) {
    reasons.push(buildReason('account_blocked', '账号已被封锁或停止调度'))
  }

  if (
    status === 'unauthorized' ||
    status === 'auth_error' ||
    status === 'token_refresh_failed' ||
    truthy(account.unauthorized)
  ) {
    reasons.push(buildReason('auth_error', '账号认证失败或 Token 刷新异常'))
  }

  if (status === 'quota_exceeded' || truthy(account.quotaAutoStopped) || account.quotaStoppedAt) {
    reasons.push(buildReason('quota_exceeded', '账号配额不足或已触发配额停调', account))
  }

  if (account.expiresAt) {
    const expiresAt = new Date(account.expiresAt).getTime()
    if (!Number.isNaN(expiresAt) && expiresAt <= now) {
      reasons.push(buildReason('expired', '账号已过期', { recoverAt: account.expiresAt }))
    }
  }

  const rateLimited =
    status === 'rate_limited' ||
    status === 'ratelimited' ||
    rateLimitStatus === 'limited' ||
    rateLimitStatus === 'rate_limited' ||
    truthy(rateLimitStatus?.isRateLimited) ||
    truthy(account.isRateLimited)
  if (rateLimited) {
    reasons.push(buildReason('rate_limit', '账号当前处于限流状态', rateLimitStatus || account))
  }

  if (status === 'overloaded' || truthy(account.isOverloaded) || account.overloadStatus) {
    reasons.push(
      buildReason('overload', '账号当前处于上游过载状态', account.overloadStatus || account)
    )
  }

  if (tempUnavailable) {
    const tempCategory = classifyErrorEvent({
      statusCode: tempUnavailable.statusCode,
      errorType: tempUnavailable.errorType,
      context: tempUnavailable
    })
    const category = tempCategory === 'unknown_error' ? 'temp_unavailable' : tempCategory
    const meta = getExceptionCategoryMeta(category)
    const reasonText =
      category === 'temp_unavailable'
        ? '账号当前处于临时暂停状态'
        : `账号当前因${meta.label}进入临时暂停状态`
    reasons.push(buildReason(category, reasonText, tempUnavailable))
  }

  if (
    schedulable === false ||
    schedulable === 'false' ||
    account.isActive === false ||
    account.isActive === 'false'
  ) {
    reasons.push(buildReason('manual_paused', '账号当前不可调度或已被手动停用'))
  }

  const primaryCategory = CATEGORY_PRIORITY.find((category) =>
    reasons.some((reason) => reason.category === category)
  )

  if (!primaryCategory) {
    return {
      isBlocked: false,
      primaryCategory: null,
      label: '当前正常',
      severity: 'success',
      reasons: ['当前账号未检测到异常状态'],
      recoverAt: null
    }
  }

  const primaryMeta = getExceptionCategoryMeta(primaryCategory)
  const recoverAt =
    reasons.find((reason) => reason.category === primaryCategory && reason.recoverAt)?.recoverAt ||
    reasons.find((reason) => reason.recoverAt)?.recoverAt ||
    null

  return {
    isBlocked: true,
    primaryCategory,
    label: primaryMeta.currentLabel || primaryMeta.label,
    severity: primaryMeta.severity,
    reasons: reasons.map((reason) => reason.text),
    recoverAt
  }
}

module.exports = {
  CATEGORY_META,
  CATEGORY_PRIORITY,
  classifyErrorEvent,
  classifyCurrentAccountStatus,
  getExceptionCategoryMeta,
  normalizeAccountType
}
