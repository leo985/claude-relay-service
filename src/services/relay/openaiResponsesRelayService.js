const axios = require('axios')
const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')
const { filterForOpenAI } = require('../../utils/headerFilter')
const openaiResponsesAccountService = require('../account/openaiResponsesAccountService')
const apiKeyService = require('../apiKeyService')
const unifiedOpenAIScheduler = require('../scheduler/unifiedOpenAIScheduler')
const CodexToOpenAIConverter = require('../codexToOpenAI')
const OpenAIResponsesAdapters = require('../openaiResponsesAdapters')
const config = require('../../../config/config')
const crypto = require('crypto')
const LRUCache = require('../../utils/lruCache')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const {
  createRequestDetailMeta,
  extractOpenAICacheReadTokens
} = require('../../utils/requestDetailHelper')
const { updateRateLimitCounters } = require('../../utils/rateLimitHelper')
const { normalizeUsage } = require('../../utils/usageNormalizer')
const {
  RESERVED_CUSTOM_HEADERS,
  clonePlainObject,
  createOpenAICompatibleError,
  detectEndpointKindFromPath,
  getProviderProtocol,
  getRequestFeaturesFromBody,
  normalizeProviderEndpoint
} = require('../../utils/openaiCompatible')

// lastUsedAt 更新节流（每账户 60 秒内最多更新一次，使用 LRU 防止内存泄漏）
const lastUsedAtThrottle = new LRUCache(1000) // 最多缓存 1000 个账户
const LAST_USED_AT_THROTTLE_MS = 60000

// 抽取缓存写入 token，兼容多种字段命名
function extractCacheCreationTokens(usageData) {
  if (!usageData || typeof usageData !== 'object') {
    return 0
  }

  const details = usageData.input_tokens_details || usageData.prompt_tokens_details || {}
  const candidates = [
    details.cache_creation_input_tokens,
    details.cache_creation_tokens,
    usageData.cache_creation_input_tokens,
    usageData.cache_creation_tokens
  ]

  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== '') {
      const parsed = Number(value)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
  }

  return 0
}

function isAnthropicUsageContext({ providerEndpoint, responseAdapter } = {}) {
  if (responseAdapter === 'claude_to_responses') {
    return true
  }
  return (
    getProviderProtocol(normalizeProviderEndpoint(providerEndpoint || 'responses')) ===
    'passthrough'
  )
}

function summarizeUsage(usageData = {}, context = {}) {
  const usageForNormalization = { ...usageData }
  const extractedCacheReadTokens = extractOpenAICacheReadTokens(usageData)
  if (extractedCacheReadTokens > 0) {
    usageForNormalization.cache_read_input_tokens = extractedCacheReadTokens
  }
  const extractedCacheCreateTokens = extractCacheCreationTokens(usageData)
  if (extractedCacheCreateTokens > 0) {
    usageForNormalization.cache_creation_input_tokens = extractedCacheCreateTokens
  }

  const inputIncludesCacheRead = !isAnthropicUsageContext(context)
  const normalized = normalizeUsage(
    inputIncludesCacheRead ? 'openai-responses' : 'anthropic',
    usageForNormalization,
    {
      inputIncludesCacheRead
    }
  )

  return {
    totalInputTokens: normalized.totalInputTokens,
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    cacheCreateTokens: normalized.cacheCreateTokens,
    cacheReadTokens: normalized.cacheReadTokens,
    totalTokens: normalized.totalTokens
  }
}

function getUsageNormalizationContext(req = {}) {
  return {
    providerEndpoint:
      req?._openaiCompatible?.providerEndpoint || req?._openaiCompatibleProviderEndpoint,
    responseAdapter: req?._openaiCompatibleResponseAdapter
  }
}

function emptyUsageSummary() {
  return {
    totalInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0
  }
}

const TIMEOUT_ERROR_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED'])
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND'
])

const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20'
const ANTHROPIC_CLAUDE_CODE_BETA = 'claude-code-20250219'
const ANTHROPIC_INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14'
const ANTHROPIC_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14'

class OpenAIResponsesRelayService {
  constructor() {
    this.defaultTimeout = config.requestTimeout || 600000
    this.responsesAdapters = new OpenAIResponsesAdapters()
  }

  // 节流更新 lastUsedAt
  async _throttledUpdateLastUsedAt(accountId) {
    const now = Date.now()
    const lastUpdate = lastUsedAtThrottle.get(accountId)

    if (lastUpdate && now - lastUpdate < LAST_USED_AT_THROTTLE_MS) {
      return // 跳过更新
    }

    lastUsedAtThrottle.set(accountId, now, LAST_USED_AT_THROTTLE_MS)
    await openaiResponsesAccountService.updateAccount(accountId, {
      lastUsedAt: new Date().toISOString()
    })
  }

  _isTimeoutError(error) {
    if (!error) {
      return false
    }
    if (TIMEOUT_ERROR_CODES.has(error.code)) {
      return true
    }
    return /timeout|timed out/i.test(error.message || '')
  }

  _isClientAbortError(error) {
    if (!error) {
      return false
    }
    if (error.code === 'ERR_CANCELED') {
      return true
    }
    return /canceled|cancelled|client aborted|aborted by client/i.test(error.message || '')
  }

  _isRetryableNetworkError(error) {
    if (!error || error.response || this._isClientAbortError(error)) {
      return false
    }
    return RETRYABLE_NETWORK_ERROR_CODES.has(error.code) || this._isTimeoutError(error)
  }

  _buildNetworkErrorResponse(error) {
    if (this._isTimeoutError(error)) {
      return {
        status: 504,
        body: {
          error: {
            message: 'Request timeout',
            type: 'timeout_error',
            code: 'upstream_timeout'
          }
        }
      }
    }

    return {
      status: 502,
      body: {
        error: {
          message: 'Upstream network error',
          type: 'upstream_error',
          code: 'upstream_network_error'
        }
      }
    }
  }

  async _markRetryableNetworkFailures(failures = []) {
    const markedAccountIds = new Set()
    for (const failure of failures) {
      const account = failure?.account
      const accountId = account?.id
      if (!accountId || markedAccountIds.has(accountId)) {
        continue
      }
      markedAccountIds.add(accountId)

      const oaiAutoProtectionDisabled =
        account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
      if (oaiAutoProtectionDisabled) {
        continue
      }

      await upstreamErrorHelper
        .markTempUnavailable(accountId, 'openai-responses', failure.statusCode || 503)
        .catch(() => {})
    }
  }

  resolveUpstreamRequest(req, fullAccount) {
    const original = req._openaiCompatibleOriginal || null
    const providerEndpoint = normalizeProviderEndpoint(fullAccount.providerEndpoint || 'responses')
    const protocol = getProviderProtocol(providerEndpoint)
    const endpointKind =
      original?.endpointKind || detectEndpointKindFromPath(req.path || req.url || '')
    const originalBody = original?.body ? clonePlainObject(original.body) : null

    let targetPath = req.path
    let body = clonePlainObject(req.body || {})
    let responseAdapter = null
    let responseAdapterContext = null
    let validationKind = protocol === 'passthrough' ? endpointKind : protocol

    if (protocol === 'responses') {
      targetPath = this._normalizeResponsesPath(endpointKind, original?.path || req.path)
      body = clonePlainObject(req.body || {})
    } else if (protocol === 'chat_completions') {
      if (endpointKind === 'responses') {
        targetPath = this._normalizeChatCompletionsPath('/v1/chat/completions')
        responseAdapterContext = this.responsesAdapters.buildResponsesAdapterContext(req.body || {})
        body = this.responsesAdapters.buildChatCompletionsRequestFromResponses(req.body || {})
        responseAdapter = 'chat_to_responses'
      } else {
        targetPath = this._normalizeChatCompletionsPath(original?.path || req.path)
        body = originalBody || clonePlainObject(req.body || {})
      }
      validationKind = 'chat_completions'
    } else {
      if (endpointKind === 'responses') {
        targetPath = '/v1/messages'
        responseAdapterContext = this.responsesAdapters.buildResponsesAdapterContext(req.body || {})
        body = this.responsesAdapters.buildAnthropicMessagesRequestFromResponses(req.body || {})
        responseAdapter = 'claude_to_responses'
        validationKind = 'chat_completions'
      } else {
        targetPath = original?.path || req.path
        body = originalBody || clonePlainObject(req.body || {})
      }
    }

    const requestedModel = originalBody?.model || req.body?.model || null
    const upstreamModel = fullAccount.boundModel?.trim() || body?.model || requestedModel
    if (fullAccount.boundModel?.trim() && body && typeof body === 'object') {
      body.model = fullAccount.boundModel.trim()
    }

    this._validateAndAdjustRequestBody(body, fullAccount, validationKind)

    req._openaiCompatible = {
      requestedModel,
      upstreamModel: body?.model || upstreamModel,
      modelOverridden: !!(
        fullAccount.boundModel?.trim() && fullAccount.boundModel.trim() !== requestedModel
      ),
      providerEndpoint,
      endpointKind
    }

    return {
      targetPath,
      body,
      endpointKind,
      requestedModel,
      upstreamModel: body?.model || upstreamModel,
      providerEndpoint,
      responseAdapterContext,
      responseAdapter:
        responseAdapter ||
        (endpointKind === 'chat_completions' && protocol === 'responses'
          ? 'responses_to_chat'
          : null)
    }
  }

  _normalizeResponsesPath(endpointKind, originalPath = '/v1/responses') {
    if (endpointKind === 'chat_completions') {
      return originalPath && originalPath.startsWith('/v1/') ? '/v1/responses' : '/responses'
    }
    if (originalPath === '/responses' || originalPath === '/v1/responses') {
      return originalPath
    }
    return '/v1/responses'
  }

  _normalizeChatCompletionsPath(originalPath = '/v1/chat/completions') {
    if (originalPath === '/chat/completions' || originalPath === '/v1/chat/completions') {
      return originalPath
    }
    return '/v1/chat/completions'
  }

  _buildTargetUrl(baseApi, targetPath) {
    const normalizedBaseApi = (baseApi || '').replace(/\/+$/, '')
    const normalizedTargetPath = this._stripDuplicatedVersionPath(normalizedBaseApi, targetPath)
    return `${normalizedBaseApi}${normalizedTargetPath}`
  }

  _getClientModelAlias(req, fallbackModel = null) {
    return req?._openaiCompatible?.requestedModel || req?.body?.model || fallbackModel
  }

  _rewriteObjectModelFieldsForClient(value, clientModel) {
    if (
      !clientModel ||
      !value ||
      typeof value !== 'object' ||
      Buffer.isBuffer(value) ||
      typeof value.pipe === 'function'
    ) {
      return value
    }

    if (Array.isArray(value)) {
      return value.map((item) => this._rewriteObjectModelFieldsForClient(item, clientModel))
    }

    let rewritten = value
    const ensureClone = () => {
      if (rewritten === value) {
        rewritten = { ...value }
      }
      return rewritten
    }

    if (Object.prototype.hasOwnProperty.call(value, 'model')) {
      ensureClone().model = clientModel
    }

    for (const field of ['response', 'message']) {
      if (value[field] && typeof value[field] === 'object' && !Array.isArray(value[field])) {
        const nested = this._rewriteObjectModelFieldsForClient(value[field], clientModel)
        if (nested !== value[field]) {
          ensureClone()[field] = nested
        }
      }
    }

    return rewritten
  }

  _rewriteSSEEventModelForClient(event, clientModel) {
    if (!clientModel || !event || !event.includes('data:')) {
      return `${event}\n\n`
    }

    const lines = event.split('\n')
    const rewrittenLines = lines.map((line) => {
      if (!line.startsWith('data:')) {
        return line
      }

      const jsonStr = line.slice(5).trim()
      if (!jsonStr || jsonStr === '[DONE]') {
        return line
      }

      try {
        const payload = JSON.parse(jsonStr)
        const rewritten = this._rewriteObjectModelFieldsForClient(payload, clientModel)
        return `data: ${JSON.stringify(rewritten)}`
      } catch {
        return line
      }
    })

    return `${rewrittenLines.join('\n')}\n\n`
  }

  _stripDuplicatedVersionPath(baseApi, targetPath) {
    const safePath = targetPath || ''
    const normalizedTargetPath = safePath.startsWith('/') ? safePath : `/${safePath}`

    if (/\/v\d+$/i.test(baseApi) && /^\/v\d+\//i.test(normalizedTargetPath)) {
      return normalizedTargetPath.replace(/^\/v\d+/i, '')
    }

    return normalizedTargetPath
  }

  _validateAndAdjustRequestBody(body, account, bodyKind) {
    const endpointKind = bodyKind === 'chat_completions' ? 'chat_completions' : 'responses'
    const features = getRequestFeaturesFromBody(body || {}, endpointKind)

    if (features.hasTools && account.supportsTools === false) {
      throw createOpenAICompatibleError('This OpenAI-compatible account does not support tools')
    }
    if (features.hasImages && account.supportsImages !== true) {
      throw createOpenAICompatibleError(
        'This OpenAI-compatible account does not support image input'
      )
    }
    if (features.hasReasoning && account.supportsReasoning !== true) {
      throw createOpenAICompatibleError(
        'This OpenAI-compatible account does not support reasoning fields'
      )
    }
    if (features.hasImageGeneration && account.supportsImageGeneration !== true) {
      throw createOpenAICompatibleError(
        'This OpenAI-compatible account does not support image generation'
      )
    }

    const maxOutputTokens = parseInt(account.maxOutputTokens, 10) || 0
    if (maxOutputTokens <= 0 || !body || typeof body !== 'object') {
      return
    }

    if (endpointKind === 'chat_completions') {
      this._clampBodyTokenField(body, 'max_tokens', maxOutputTokens)
      this._clampBodyTokenField(body, 'max_output_tokens', maxOutputTokens)
    } else {
      this._clampBodyTokenField(body, 'max_output_tokens', maxOutputTokens)
    }
  }

  _ensureChatCompletionsStreamUsage(body, providerEndpoint) {
    if (!body || typeof body !== 'object' || body.stream !== true) {
      return
    }

    if (normalizeProviderEndpoint(providerEndpoint || 'responses') !== 'chat_completions') {
      return
    }

    const existingOptions =
      body.stream_options &&
      typeof body.stream_options === 'object' &&
      !Array.isArray(body.stream_options)
        ? body.stream_options
        : {}

    body.stream_options = {
      ...existingOptions,
      include_usage: true
    }
  }

  async _applyRateLimitTracking(req, usageSummary, model, costs, context) {
    if (!req?.rateLimitInfo) {
      return
    }

    try {
      const { totalTokens, ratedCost } = await updateRateLimitCounters(
        req.rateLimitInfo,
        usageSummary,
        model,
        req.apiKey?.id,
        'openai-responses',
        costs
      )

      if (totalTokens > 0) {
        logger.api(
          `📊 Updated OpenAI-compatible rate limit token count (${context}): +${totalTokens}`
        )
      }
      if (typeof ratedCost === 'number' && ratedCost > 0) {
        logger.api(
          `💰 Updated OpenAI-compatible rate limit cost count (${context}): +$${ratedCost.toFixed(6)}`
        )
      }
    } catch (error) {
      logger.error(`❌ Failed to update OpenAI-compatible rate limit counters (${context}):`, error)
    }
  }

  async _recordSuccessfulUsage({
    req,
    res: _res,
    account,
    apiKeyData,
    requestedModel,
    actualModel,
    usageData = null,
    stream = false,
    statusCode = 200,
    context = 'openai-compatible',
    fallbackReason = ''
  }) {
    const modelToRecord = actualModel || requestedModel || 'gpt-4'
    const usageSummary = usageData
      ? summarizeUsage(usageData, getUsageNormalizationContext(req))
      : emptyUsageSummary()
    const serviceTier = req?._serviceTier || null

    const costs = (await apiKeyService.recordUsage(
      apiKeyData.id,
      usageSummary.inputTokens,
      usageSummary.outputTokens,
      usageSummary.cacheCreateTokens,
      usageSummary.cacheReadTokens,
      modelToRecord,
      account.id,
      'openai-responses',
      serviceTier,
      createRequestDetailMeta(req, {
        requestBody: req?._openaiCompatibleUpstreamBody || req?.body,
        stream,
        statusCode
      })
    )) || { realCost: 0, ratedCost: 0 }

    if (usageData) {
      await this._applyRateLimitTracking(req, usageSummary, modelToRecord, costs, context)
    } else if (fallbackReason) {
      logger.warn(
        `📊 Recorded OpenAI-compatible successful request without usage (${fallbackReason}) - ` +
          `Model: ${modelToRecord}`
      )
    }

    await openaiResponsesAccountService.updateAccountUsage(account.id, usageSummary.totalTokens)

    const dailyQuota = parseFloat(account.dailyQuota) || 0
    if (usageData && dailyQuota > 0 && costs.realCost > 0) {
      await openaiResponsesAccountService.updateUsageQuota(account.id, costs.realCost)
    }

    return {
      modelToRecord,
      usageSummary,
      costs
    }
  }

  _clampBodyTokenField(body, field, limit) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      return
    }
    const parsed = Number(body[field])
    if (!Number.isFinite(parsed)) {
      return
    }
    body[field] = Math.max(0, Math.min(Math.floor(parsed), limit))
  }

  _buildUpstreamHeaders(req, fullAccount, upstreamRequest = {}) {
    const headers = {
      ...filterForOpenAI(req.headers),
      Authorization: `Bearer ${fullAccount.apiKey}`,
      'Content-Type': 'application/json'
    }

    if (fullAccount.userAgent) {
      headers['User-Agent'] = fullAccount.userAgent
      logger.debug(`📱 Using custom User-Agent: ${fullAccount.userAgent}`)
    } else if (req.headers['user-agent']) {
      headers['User-Agent'] = req.headers['user-agent']
      logger.debug(`📱 Forwarding original User-Agent: ${req.headers['user-agent']}`)
    }

    const extraHeaders = fullAccount.customHeaders || {}
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (RESERVED_CUSTOM_HEADERS.has(key.toLowerCase())) {
        logger.warn('Skipping reserved custom header', { key })
        continue
      }
      headers[key] = value
    }

    if (Object.keys(extraHeaders).length > 0) {
      logger.info('📨 Applied OpenAI-compatible custom headers', {
        accountId: fullAccount.id,
        headerKeys: Object.keys(extraHeaders)
      })
    }

    if (this._shouldApplyAnthropicThinkingBeta(upstreamRequest)) {
      const existingBetaValues = []
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'anthropic-beta') {
          existingBetaValues.push(headers[key])
          delete headers[key]
        }
      }
      headers['anthropic-beta'] = this._mergeAnthropicBetaHeader(
        this._getDefaultAnthropicBetas(upstreamRequest.body?.model),
        existingBetaValues.join(',')
      )
      logger.info('🧠 Applied Anthropic thinking beta header for passthrough Messages request', {
        accountId: fullAccount.id,
        betaHeader: headers['anthropic-beta']
      })
    }

    return headers
  }

  _shouldApplyAnthropicThinkingBeta(upstreamRequest = {}) {
    if (
      normalizeProviderEndpoint(upstreamRequest.providerEndpoint || 'responses') !== 'passthrough'
    ) {
      return false
    }

    const targetPath = String(upstreamRequest.targetPath || '').split('?')[0]
    if (!targetPath.endsWith('/v1/messages')) {
      return false
    }

    return this._hasEnabledAnthropicThinking(upstreamRequest.body)
  }

  _hasEnabledAnthropicThinking(body = {}) {
    if (!body || typeof body !== 'object' || !body.thinking) {
      return false
    }
    if (typeof body.thinking === 'object') {
      const thinkingType = String(body.thinking.type || '').toLowerCase()
      return thinkingType !== 'disabled' && thinkingType !== 'none' && thinkingType !== 'off'
    }
    return String(body.thinking).toLowerCase() !== 'disabled'
  }

  _getDefaultAnthropicBetas(modelId) {
    const isHaikuModel = modelId && String(modelId).toLowerCase().includes('haiku')
    return isHaikuModel
      ? [ANTHROPIC_OAUTH_BETA, ANTHROPIC_INTERLEAVED_THINKING_BETA]
      : [
          ANTHROPIC_CLAUDE_CODE_BETA,
          ANTHROPIC_OAUTH_BETA,
          ANTHROPIC_INTERLEAVED_THINKING_BETA,
          ANTHROPIC_TOOL_STREAMING_BETA
        ]
  }

  _mergeAnthropicBetaHeader(defaultBetas = [], existingBetaHeader = '') {
    const betaList = []
    const seen = new Set()
    const addBeta = (beta) => {
      const normalized = String(beta || '').trim()
      if (!normalized || seen.has(normalized)) {
        return
      }
      seen.add(normalized)
      betaList.push(normalized)
    }

    defaultBetas.forEach(addBeta)
    String(existingBetaHeader || '')
      .split(',')
      .forEach(addBeta)

    return betaList.join(',')
  }

  // 处理请求转发
  async handleRequest(req, res, account, apiKeyData, options = {}) {
    let abortController = null
    let handleClientDisconnect = null
    const retryAttempt = Number.isInteger(options.retryAttempt) ? options.retryAttempt : 0
    const maxNetworkRetries = Number.isInteger(options.maxNetworkRetries)
      ? options.maxNetworkRetries
      : 0
    const failedAccountIds = Array.isArray(options.failedAccountIds)
      ? options.failedAccountIds.filter(Boolean)
      : []
    const pendingNetworkFailures = Array.isArray(options.pendingNetworkFailures)
      ? options.pendingNetworkFailures
      : []
    // 获取会话哈希（如果有的话）
    const sessionId = req.headers['session_id'] || req.body?.session_id
    const sessionHash = sessionId
      ? crypto.createHash('sha256').update(sessionId).digest('hex')
      : null

    try {
      // 获取完整的账户信息（包含解密的 API Key）
      const fullAccount = await openaiResponsesAccountService.getAccount(account.id, {
        includeSecretHeaders: true
      })
      if (!fullAccount) {
        throw new Error('Account not found')
      }

      // 创建 AbortController 用于取消请求
      abortController = new AbortController()

      // 设置客户端断开监听器
      handleClientDisconnect = () => {
        logger.info('🔌 Client disconnected, aborting OpenAI-Responses request')
        if (abortController && !abortController.signal.aborted) {
          abortController.abort()
        }
      }

      // 监听客户端断开事件
      req.once('close', handleClientDisconnect)
      res.once('close', handleClientDisconnect)

      const upstreamRequest = this.resolveUpstreamRequest(req, fullAccount)
      this._ensureChatCompletionsStreamUsage(upstreamRequest.body, upstreamRequest.providerEndpoint)
      req._openaiCompatibleUpstreamBody = upstreamRequest.body
      req._openaiCompatibleResponseAdapter = upstreamRequest.responseAdapter
      req._openaiCompatibleResponseAdapterContext = upstreamRequest.responseAdapterContext
      const targetUrl = this._buildTargetUrl(fullAccount.baseApi, upstreamRequest.targetPath)
      logger.info(`🎯 Forwarding to: ${targetUrl}`)

      const headers = this._buildUpstreamHeaders(req, fullAccount, upstreamRequest)
      const isStream = upstreamRequest.body?.stream === true

      // 配置请求选项
      const requestOptions = {
        method: req.method,
        url: targetUrl,
        headers,
        data: upstreamRequest.body,
        timeout: this.defaultTimeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true, // 允许处理所有状态码
        signal: abortController.signal
      }

      // 配置代理（如果有）
      if (fullAccount.proxy) {
        const proxyAgent = ProxyHelper.createProxyAgent(fullAccount.proxy)
        if (proxyAgent) {
          requestOptions.httpAgent = proxyAgent
          requestOptions.httpsAgent = proxyAgent
          requestOptions.proxy = false
          logger.info(
            `🌐 Using proxy for OpenAI-Responses: ${ProxyHelper.getProxyDescription(fullAccount.proxy)}`
          )
        }
      }

      // 记录请求信息
      logger.info('📤 OpenAI-Responses relay request', {
        accountId: account.id,
        accountName: account.name,
        targetUrl,
        method: req.method,
        stream: isStream,
        model: upstreamRequest.upstreamModel || 'unknown',
        requestedModel: upstreamRequest.requestedModel || 'unknown',
        providerEndpoint: upstreamRequest.providerEndpoint,
        endpointKind: upstreamRequest.endpointKind,
        userAgent: headers['User-Agent'] || 'not set',
        customHeaderKeys: Object.keys(fullAccount.customHeaders || {})
      })

      // 发送请求
      const response = await axios(requestOptions)

      // 处理 429 限流错误
      if (response.status === 429) {
        const { resetsInSeconds, errorData } = await this._handle429Error(
          account,
          response,
          isStream,
          sessionHash
        )

        const oaiAutoProtectionDisabled =
          account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
        if (!oaiAutoProtectionDisabled) {
          await upstreamErrorHelper
            .markTempUnavailable(
              account.id,
              'openai-responses',
              429,
              resetsInSeconds || upstreamErrorHelper.parseRetryAfter(response.headers)
            )
            .catch(() => {})
        }

        // 返回错误响应（使用处理后的数据，避免循环引用）
        const errorResponse = upstreamErrorHelper.sanitizeErrorForClient(
          errorData || {
            error: {
              message: 'Rate limit exceeded',
              type: 'rate_limit_error',
              code: 'rate_limit_exceeded',
              resets_in_seconds: resetsInSeconds
            }
          },
          { statusCode: 429, retryAfterSeconds: resetsInSeconds }
        )
        return res.status(429).json(errorResponse)
      }

      // 处理其他错误状态码
      if (response.status >= 400) {
        // 处理流式错误响应
        let errorData = response.data
        if (response.data && typeof response.data.pipe === 'function') {
          // 流式响应需要先读取内容
          const chunks = []
          await new Promise((resolve) => {
            response.data.on('data', (chunk) => chunks.push(chunk))
            response.data.on('end', resolve)
            response.data.on('error', resolve)
            setTimeout(resolve, 5000) // 超时保护
          })
          const fullResponse = Buffer.concat(chunks).toString()

          // 尝试解析错误响应
          try {
            if (fullResponse.includes('data: ')) {
              // SSE格式
              const lines = fullResponse.split('\n')
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const jsonStr = line.slice(6).trim()
                  if (jsonStr && jsonStr !== '[DONE]') {
                    errorData = JSON.parse(jsonStr)
                    break
                  }
                }
              }
            } else {
              // 普通JSON
              errorData = JSON.parse(fullResponse)
            }
          } catch (e) {
            logger.error('Failed to parse error response:', e)
            errorData = { error: { message: fullResponse || 'Unknown error' } }
          }
        }

        logger.error('OpenAI-Responses API error', {
          status: response.status,
          statusText: response.statusText,
          errorData
        })

        if (response.status === 401) {
          logger.warn(`🚫 OpenAI Responses账号认证失败（401错误）for account ${account?.id}`)

          try {
            // 仅临时暂停，不永久禁用
            const oaiAutoProtectionDisabled =
              account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
            if (!oaiAutoProtectionDisabled) {
              await upstreamErrorHelper
                .markTempUnavailable(account.id, 'openai-responses', 401)
                .catch(() => {})
            }
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.error(
              '❌ Failed to mark OpenAI-Responses account temporarily unavailable after 401:',
              markError
            )
          }

          let unauthorizedResponse = errorData
          if (
            !unauthorizedResponse ||
            typeof unauthorizedResponse !== 'object' ||
            unauthorizedResponse.pipe ||
            Buffer.isBuffer(unauthorizedResponse)
          ) {
            const fallbackMessage =
              typeof errorData === 'string' && errorData.trim() ? errorData.trim() : 'Unauthorized'
            unauthorizedResponse = {
              error: {
                message: fallbackMessage,
                type: 'unauthorized',
                code: 'unauthorized'
              }
            }
          }

          // 清理监听器
          req.removeListener('close', handleClientDisconnect)
          res.removeListener('close', handleClientDisconnect)

          return res
            .status(401)
            .json(
              upstreamErrorHelper.sanitizeErrorForClient(unauthorizedResponse, { statusCode: 401 })
            )
        }

        // 处理 5xx 上游错误
        if (response.status >= 500 && account?.id) {
          try {
            const oaiAutoProtectionDisabled =
              account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
            if (!oaiAutoProtectionDisabled) {
              await upstreamErrorHelper.markTempUnavailable(
                account.id,
                'openai-responses',
                response.status
              )
            }
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.warn(
              'Failed to mark OpenAI-Responses account temporarily unavailable:',
              markError
            )
          }
        }

        // 清理监听器
        req.removeListener('close', handleClientDisconnect)
        res.removeListener('close', handleClientDisconnect)

        return res
          .status(response.status)
          .json(
            upstreamErrorHelper.sanitizeErrorForClient(errorData, { statusCode: response.status })
          )
      }

      // 更新最后使用时间（节流）
      await this._throttledUpdateLastUsedAt(account.id)

      // 处理流式响应
      if (isStream && response.data && typeof response.data.pipe === 'function') {
        return this._handleStreamResponse(
          response,
          res,
          account,
          apiKeyData,
          upstreamRequest.responseAdapter
            ? upstreamRequest.requestedModel
            : upstreamRequest.upstreamModel || upstreamRequest.requestedModel,
          handleClientDisconnect,
          req
        )
      }

      // 处理非流式响应
      return this._handleNormalResponse(
        response,
        res,
        account,
        apiKeyData,
        upstreamRequest.responseAdapter
          ? upstreamRequest.requestedModel
          : upstreamRequest.upstreamModel || upstreamRequest.requestedModel,
        req
      )
    } catch (error) {
      // 清理 AbortController
      if (abortController && !abortController.signal.aborted) {
        abortController.abort()
      }
      if (handleClientDisconnect) {
        req.removeListener('close', handleClientDisconnect)
        res.removeListener('close', handleClientDisconnect)
      }

      // 安全地记录错误，避免循环引用
      const errorInfo = {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        statusText: error.response?.statusText
      }
      logger.error('OpenAI-Responses relay error:', errorInfo)

      const isRetryableNetworkError = this._isRetryableNetworkError(error)
      const networkErrorResponse = isRetryableNetworkError
        ? this._buildNetworkErrorResponse(error)
        : null

      // 检查是否是网络错误
      const nextPendingNetworkFailures = isRetryableNetworkError
        ? [
            ...pendingNetworkFailures,
            {
              account,
              statusCode: networkErrorResponse?.status || 503
            }
          ]
        : pendingNetworkFailures

      if (isRetryableNetworkError) {
        if (sessionHash) {
          await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
        }
      }

      const nextFailedAccountIds = [...new Set([...failedAccountIds, account?.id].filter(Boolean))]
      const canRetryNetworkError =
        isRetryableNetworkError &&
        !res.headersSent &&
        !res.writableEnded &&
        !res.destroyed &&
        retryAttempt < maxNetworkRetries &&
        typeof options.selectRetryAccount === 'function'

      if (canRetryNetworkError) {
        try {
          const retryAccount = await options.selectRetryAccount({
            error,
            failedAccount: account,
            failedAccountIds: nextFailedAccountIds,
            retryAttempt
          })

          if (retryAccount?.id && !nextFailedAccountIds.includes(retryAccount.id)) {
            logger.warn(
              `🔁 Retrying OpenAI-Responses request after network error (${error.code || error.message}) with account ${retryAccount.name || retryAccount.id}`
            )
            return await this.handleRequest(req, res, retryAccount, apiKeyData, {
              ...options,
              retryAttempt: retryAttempt + 1,
              failedAccountIds: nextFailedAccountIds,
              pendingNetworkFailures: nextPendingNetworkFailures
            })
          }

          logger.warn('🔁 OpenAI-Responses retry skipped: no alternate account available')
        } catch (retryError) {
          logger.warn('🔁 OpenAI-Responses retry selection failed:', retryError)
        }
      }

      // 如果已经发送了响应头，直接结束
      if (res.headersSent) {
        return res.end()
      }

      if (error.statusCode) {
        return res.status(error.statusCode).json({
          error: {
            message: error.message,
            type: error.code || 'invalid_request_error',
            code: error.code || 'invalid_request'
          }
        })
      }

      // 检查是否是axios错误并包含响应
      if (error.response) {
        // 处理axios错误响应
        const status = error.response.status || 500
        let errorData = {
          error: {
            message: error.response.statusText || 'Request failed',
            type: 'api_error',
            code: error.code || 'unknown'
          }
        }

        // 如果响应包含数据，尝试使用它
        if (error.response.data) {
          // 检查是否是流
          if (typeof error.response.data === 'object' && !error.response.data.pipe) {
            errorData = error.response.data
          } else if (typeof error.response.data === 'string') {
            try {
              errorData = JSON.parse(error.response.data)
            } catch (e) {
              errorData.error.message = error.response.data
            }
          }
        }

        if (status === 401) {
          logger.warn(
            `🚫 OpenAI Responses账号认证失败（401错误）for account ${account?.id} (catch handler)`
          )

          try {
            // 仅临时暂停，不永久禁用
            const oaiAutoProtectionDisabled =
              account?.disableAutoProtection === true || account?.disableAutoProtection === 'true'
            if (!oaiAutoProtectionDisabled) {
              await upstreamErrorHelper
                .markTempUnavailable(account.id, 'openai-responses', 401)
                .catch(() => {})
            }
            if (sessionHash) {
              await unifiedOpenAIScheduler._deleteSessionMapping(sessionHash).catch(() => {})
            }
          } catch (markError) {
            logger.error(
              '❌ Failed to mark OpenAI-Responses account temporarily unavailable in catch handler:',
              markError
            )
          }

          let unauthorizedResponse = errorData
          if (
            !unauthorizedResponse ||
            typeof unauthorizedResponse !== 'object' ||
            unauthorizedResponse.pipe ||
            Buffer.isBuffer(unauthorizedResponse)
          ) {
            const fallbackMessage =
              typeof errorData === 'string' && errorData.trim() ? errorData.trim() : 'Unauthorized'
            unauthorizedResponse = {
              error: {
                message: fallbackMessage,
                type: 'unauthorized',
                code: 'unauthorized'
              }
            }
          }

          return res
            .status(401)
            .json(
              upstreamErrorHelper.sanitizeErrorForClient(unauthorizedResponse, { statusCode: 401 })
            )
        }

        return res
          .status(status)
          .json(upstreamErrorHelper.sanitizeErrorForClient(errorData, { statusCode: status }))
      }

      if (networkErrorResponse) {
        // 重试成功时不污染异常面板；只有请求级重试耗尽后才记录冷却和异常统计。
        await this._markRetryableNetworkFailures(nextPendingNetworkFailures)
        return res.status(networkErrorResponse.status).json(networkErrorResponse.body)
      }

      // 其他错误
      return res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'internal_error',
          code: 'internal_error'
        }
      })
    }
  }

  // 处理流式响应
  async _handleStreamResponse(
    response,
    res,
    account,
    apiKeyData,
    requestedModel,
    handleClientDisconnect,
    req
  ) {
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    let usageData = null
    let actualModel = null
    let buffer = ''
    let rateLimitDetected = false
    let rateLimitResetsInSeconds = null
    let streamEnded = false
    const clientModelAlias = this._getClientModelAlias(req, requestedModel)
    const shouldAdaptResponsesToChat = req._openaiCompatibleResponseAdapter === 'responses_to_chat'
    const shouldAdaptChatToResponses = req._openaiCompatibleResponseAdapter === 'chat_to_responses'
    const shouldAdaptClaudeToResponses =
      req._openaiCompatibleResponseAdapter === 'claude_to_responses'
    const chatConverter = shouldAdaptResponsesToChat ? new CodexToOpenAIConverter() : null
    const chatStreamState = chatConverter?.createStreamState()
    const responsesStreamState =
      shouldAdaptChatToResponses || shouldAdaptClaudeToResponses
        ? this.responsesAdapters.createChatToResponsesStreamState(
            req._openaiCompatibleResponseAdapterContext
          )
        : null
    const claudeToOpenAIConverter = shouldAdaptClaudeToResponses
      ? require('../openaiToClaude')
      : null

    // 解析 SSE 事件以捕获 usage 数据和 model
    const parseSSEForUsage = (data) => {
      const lines = data.split('\n')

      for (const line of lines) {
        if (line.startsWith('data:')) {
          try {
            const jsonStr = line.slice(5).trim()
            if (jsonStr === '[DONE]') {
              continue
            }

            const eventData = JSON.parse(jsonStr)

            // Chat Completions stream usage is emitted as a top-level usage object
            // when stream_options.include_usage is enabled.
            if (eventData.model) {
              actualModel = eventData.model
            }
            if (eventData.usage) {
              usageData = eventData.usage
              logger.info('📊 Successfully captured usage data from Chat Completions stream:', {
                prompt_tokens: usageData.prompt_tokens,
                completion_tokens: usageData.completion_tokens,
                total_tokens: usageData.total_tokens
              })
            }

            // 检查是否是 response.completed 事件（OpenAI-Responses 格式）
            if (eventData.type === 'response.completed' && eventData.response) {
              // 从响应中获取真实的 model
              if (eventData.response.model) {
                actualModel = eventData.response.model
                logger.debug(`📊 Captured actual model from response.completed: ${actualModel}`)
              }

              // 获取 usage 数据 - OpenAI-Responses 格式在 response.usage 下
              if (eventData.response.usage) {
                usageData = eventData.response.usage
                logger.info('📊 Successfully captured usage data from OpenAI-Responses:', {
                  input_tokens: usageData.input_tokens,
                  output_tokens: usageData.output_tokens,
                  total_tokens: usageData.total_tokens
                })
              }
            }

            // Anthropic Messages stream usage is used by passthrough adapters.
            if (eventData.type === 'message_start' && eventData.message?.usage) {
              usageData = eventData.message.usage
              if (eventData.message.model) {
                actualModel = eventData.message.model
              }
            }
            if (eventData.type === 'message_delta' && eventData.usage) {
              usageData = {
                ...(usageData || {}),
                ...eventData.usage
              }
            }

            // 检查是否有限流错误
            if (eventData.error) {
              // 检查多种可能的限流错误类型
              if (
                eventData.error.type === 'rate_limit_error' ||
                eventData.error.type === 'usage_limit_reached' ||
                eventData.error.type === 'rate_limit_exceeded'
              ) {
                rateLimitDetected = true
                if (eventData.error.resets_in_seconds) {
                  rateLimitResetsInSeconds = eventData.error.resets_in_seconds
                  logger.warn(
                    `🚫 Rate limit detected in stream, resets in ${rateLimitResetsInSeconds} seconds (${Math.ceil(rateLimitResetsInSeconds / 60)} minutes)`
                  )
                }
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    const adaptChatSSEToResponses = (data) => {
      if (!responsesStreamState) {
        return
      }
      const lines = data.split('\n')
      for (const line of lines) {
        if (!line.startsWith('data:')) {
          continue
        }
        const jsonStr = line.slice(5).trim()
        if (!jsonStr || jsonStr === '[DONE]') {
          continue
        }
        try {
          const eventData = JSON.parse(jsonStr)
          const converted = this.responsesAdapters.convertChatStreamChunkToResponses(
            eventData,
            clientModelAlias,
            responsesStreamState
          )
          for (const chunk of converted) {
            if (!res.destroyed && !streamEnded) {
              res.write(chunk)
            }
          }
        } catch {
          // Ignore malformed upstream SSE events while preserving the stream.
        }
      }
    }

    const adaptSSEToChat = (data) => {
      if (!chatConverter) {
        return
      }
      const lines = data.split('\n')
      for (const line of lines) {
        if (!line.startsWith('data:')) {
          continue
        }
        const jsonStr = line.slice(5).trim()
        if (!jsonStr || jsonStr === '[DONE]') {
          continue
        }
        try {
          const eventData = this._rewriteObjectModelFieldsForClient(
            JSON.parse(jsonStr),
            clientModelAlias
          )
          const converted = chatConverter.convertStreamChunk(
            eventData,
            clientModelAlias,
            chatStreamState
          )
          for (const chunk of converted) {
            if (!res.destroyed && !streamEnded) {
              res.write(chunk)
            }
          }
        } catch {
          // Ignore malformed upstream SSE events while preserving the stream.
        }
      }
    }

    const adaptAnthropicSSEToResponses = (data) => {
      if (!claudeToOpenAIConverter) {
        return
      }
      const chatSSE = claudeToOpenAIConverter.convertStreamChunk(
        data,
        clientModelAlias,
        responsesStreamState?.responseId || clientModelAlias || 'chatcmpl'
      )
      if (chatSSE) {
        adaptChatSSEToResponses(chatSSE)
      }
    }

    // 监听数据流
    response.data.on('data', (chunk) => {
      try {
        const chunkStr = chunk.toString()

        // 同时解析数据以捕获 usage 信息
        buffer += chunkStr

        // 处理完整的 SSE 事件
        if (buffer.includes('\n\n')) {
          const events = buffer.split('\n\n')
          buffer = events.pop() || ''

          for (const event of events) {
            if (event.trim()) {
              parseSSEForUsage(event)
              if (shouldAdaptResponsesToChat) {
                adaptSSEToChat(event)
              } else if (shouldAdaptChatToResponses) {
                adaptChatSSEToResponses(event)
              } else if (shouldAdaptClaudeToResponses) {
                adaptAnthropicSSEToResponses(event)
              } else if (!res.destroyed && !streamEnded) {
                res.write(this._rewriteSSEEventModelForClient(event, clientModelAlias))
              }
            }
          }
        }
      } catch (error) {
        logger.error('Error processing stream chunk:', error)
      }
    })

    response.data.on('end', async () => {
      // 处理剩余的 buffer
      if (buffer.trim()) {
        parseSSEForUsage(buffer)
        if (shouldAdaptResponsesToChat) {
          adaptSSEToChat(buffer)
        } else if (shouldAdaptChatToResponses) {
          adaptChatSSEToResponses(buffer)
        } else if (shouldAdaptClaudeToResponses) {
          adaptAnthropicSSEToResponses(buffer)
        } else if (!res.destroyed && !streamEnded) {
          res.write(this._rewriteSSEEventModelForClient(buffer, clientModelAlias))
        }
      }

      // 先记录真实 usage；如果没有 usage 且不是限流错误，再补记 0-token 成功请求。
      if (usageData || !rateLimitDetected) {
        try {
          const result = await this._recordSuccessfulUsage({
            req,
            res,
            account,
            apiKeyData,
            requestedModel,
            actualModel,
            usageData,
            stream: true,
            statusCode: res.statusCode,
            context: 'openai-compatible-stream',
            fallbackReason: usageData ? '' : 'stream completed without usage'
          })

          const { usageSummary, modelToRecord } = result
          logger.info(
            `📊 Recorded stream usage - Input: ${usageSummary.totalInputTokens}(actual:${usageSummary.inputTokens}+cached:${usageSummary.cacheReadTokens}), CacheCreate: ${usageSummary.cacheCreateTokens}, Output: ${usageSummary.outputTokens}, Total: ${usageSummary.totalTokens}, Model: ${modelToRecord}`
          )
        } catch (error) {
          logger.error('Failed to record usage:', error)
        }
      }

      // 如果在流式响应中检测到限流
      if (rateLimitDetected) {
        // 使用统一调度器处理限流（与非流式响应保持一致）
        const sessionId = req.headers['session_id'] || req.body?.session_id
        const sessionHash = sessionId
          ? crypto.createHash('sha256').update(sessionId).digest('hex')
          : null

        await unifiedOpenAIScheduler.markAccountRateLimited(
          account.id,
          'openai-responses',
          sessionHash,
          rateLimitResetsInSeconds
        )

        logger.warn(
          `🚫 Processing rate limit for OpenAI-Responses account ${account.id} from stream`
        )
      }

      // 清理监听器
      req.removeListener('close', handleClientDisconnect)
      res.removeListener('close', handleClientDisconnect)

      streamEnded = true
      if (!res.destroyed) {
        if (shouldAdaptResponsesToChat) {
          res.write('data: [DONE]\n\n')
        } else if (shouldAdaptChatToResponses || shouldAdaptClaudeToResponses) {
          const finalChunks = this.responsesAdapters.finalizeChatToResponsesStream(
            clientModelAlias,
            responsesStreamState
          )
          for (const chunk of finalChunks) {
            res.write(chunk)
          }
          res.write('data: [DONE]\n\n')
        }
        res.end()
      }

      logger.info('Stream response completed', {
        accountId: account.id,
        hasUsage: !!usageData,
        actualModel: actualModel || 'unknown'
      })
    })

    response.data.on('error', (error) => {
      streamEnded = true
      logger.error('Stream error:', error)

      // 清理监听器
      req.removeListener('close', handleClientDisconnect)
      res.removeListener('close', handleClientDisconnect)

      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'Upstream stream error' } })
      } else if (!res.destroyed) {
        res.end()
      }
    })

    // 处理客户端断开连接
    const cleanup = () => {
      streamEnded = true
      try {
        response.data?.unpipe?.(res)
        response.data?.destroy?.()
      } catch (_) {
        // 忽略清理错误
      }
    }

    req.on('close', cleanup)
    req.on('aborted', cleanup)
  }

  // 处理非流式响应
  async _handleNormalResponse(response, res, account, apiKeyData, requestedModel, req) {
    const responseData = response.data
    let clientResponseData = responseData
    const clientModelAlias = this._getClientModelAlias(req, requestedModel)

    // 提取 usage 数据和实际 model
    // 支持两种格式：直接的 usage 或嵌套在 response 中的 usage
    const usageData = responseData?.usage || responseData?.response?.usage
    const actualModel =
      responseData?.model || responseData?.response?.model || requestedModel || 'gpt-4'

    // 记录使用统计；成功但无 usage 时也补记 0-token 请求，用于 API Key 请求数和 lastUsedAt。
    try {
      const result = await this._recordSuccessfulUsage({
        req,
        res,
        account,
        apiKeyData,
        requestedModel,
        actualModel,
        usageData,
        stream: false,
        statusCode: response.status,
        context: 'openai-compatible-non-stream',
        fallbackReason: usageData ? '' : 'non-stream response without usage'
      })

      const { usageSummary, modelToRecord } = result
      logger.info(
        `📊 Recorded non-stream usage - Input: ${usageSummary.totalInputTokens}(actual:${usageSummary.inputTokens}+cached:${usageSummary.cacheReadTokens}), CacheCreate: ${usageSummary.cacheCreateTokens}, Output: ${usageSummary.outputTokens}, Total: ${usageSummary.totalTokens}, Model: ${modelToRecord}`
      )
    } catch (error) {
      logger.error('Failed to record usage:', error)
    }

    if (req._openaiCompatibleResponseAdapter === 'responses_to_chat') {
      try {
        const converter = new CodexToOpenAIConverter()
        const rewrittenResponse = this._rewriteObjectModelFieldsForClient(
          responseData,
          clientModelAlias
        )
        clientResponseData = converter.convertResponse(rewrittenResponse, clientModelAlias)
      } catch (error) {
        logger.warn('Failed to convert Responses payload to Chat Completions format:', error)
      }
    } else if (req._openaiCompatibleResponseAdapter === 'chat_to_responses') {
      try {
        clientResponseData = this.responsesAdapters.convertChatCompletionToResponse(
          responseData,
          clientModelAlias,
          req._openaiCompatibleResponseAdapterContext
        )
      } catch (error) {
        logger.warn('Failed to convert Chat Completions payload to Responses format:', error)
      }
    } else if (req._openaiCompatibleResponseAdapter === 'claude_to_responses') {
      try {
        clientResponseData = this.responsesAdapters.convertClaudeMessageToResponse(
          responseData,
          clientModelAlias,
          req._openaiCompatibleResponseAdapterContext
        )
      } catch (error) {
        logger.warn('Failed to convert Anthropic Messages payload to Responses format:', error)
      }
    } else {
      clientResponseData = this._rewriteObjectModelFieldsForClient(responseData, clientModelAlias)
    }

    clientResponseData = this._rewriteObjectModelFieldsForClient(
      clientResponseData,
      clientModelAlias
    )

    // 返回响应
    res.status(response.status).json(clientResponseData)

    logger.info('Normal response completed', {
      accountId: account.id,
      status: response.status,
      hasUsage: !!usageData,
      model: actualModel
    })
  }

  // 处理 429 限流错误
  async _handle429Error(account, response, isStream = false, sessionHash = null) {
    let resetsInSeconds = null
    let errorData = null

    try {
      // 对于429错误，响应可能是JSON或SSE格式
      if (isStream && response.data && typeof response.data.pipe === 'function') {
        // 流式响应需要先收集数据
        const chunks = []
        await new Promise((resolve, reject) => {
          response.data.on('data', (chunk) => chunks.push(chunk))
          response.data.on('end', resolve)
          response.data.on('error', reject)
          // 设置超时防止无限等待
          setTimeout(resolve, 5000)
        })

        const fullResponse = Buffer.concat(chunks).toString()

        // 尝试解析SSE格式的错误响应
        if (fullResponse.includes('data: ')) {
          const lines = fullResponse.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const jsonStr = line.slice(6).trim()
                if (jsonStr && jsonStr !== '[DONE]') {
                  errorData = JSON.parse(jsonStr)
                  break
                }
              } catch (e) {
                // 继续尝试下一行
              }
            }
          }
        }

        // 如果SSE解析失败，尝试直接解析为JSON
        if (!errorData) {
          try {
            errorData = JSON.parse(fullResponse)
          } catch (e) {
            logger.error('Failed to parse 429 error response:', e)
            logger.debug('Raw response:', fullResponse)
          }
        }
      } else if (response.data && typeof response.data !== 'object') {
        // 如果response.data是字符串，尝试解析为JSON
        try {
          errorData = JSON.parse(response.data)
        } catch (e) {
          logger.error('Failed to parse 429 error response as JSON:', e)
          errorData = { error: { message: response.data } }
        }
      } else if (response.data && typeof response.data === 'object' && !response.data.pipe) {
        // 非流式响应，且是对象，直接使用
        errorData = response.data
      }

      // 从响应体中提取重置时间（OpenAI 标准格式）
      if (errorData && errorData.error) {
        if (errorData.error.resets_in_seconds) {
          resetsInSeconds = errorData.error.resets_in_seconds
          logger.info(
            `🕐 Rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes / ${Math.ceil(resetsInSeconds / 3600)} hours)`
          )
        } else if (errorData.error.resets_in) {
          // 某些 API 可能使用不同的字段名
          resetsInSeconds = parseInt(errorData.error.resets_in)
          logger.info(
            `🕐 Rate limit will reset in ${resetsInSeconds} seconds (${Math.ceil(resetsInSeconds / 60)} minutes / ${Math.ceil(resetsInSeconds / 3600)} hours)`
          )
        }
      }

      if (!resetsInSeconds) {
        logger.warn('⚠️ Could not extract reset time from 429 response, using default 60 minutes')
      }
    } catch (e) {
      logger.error('⚠️ Failed to parse rate limit error:', e)
    }

    // 使用统一调度器标记账户为限流状态（与普通OpenAI账号保持一致）
    await unifiedOpenAIScheduler.markAccountRateLimited(
      account.id,
      'openai-responses',
      sessionHash,
      resetsInSeconds
    )

    logger.warn('OpenAI-Responses account rate limited', {
      accountId: account.id,
      accountName: account.name,
      resetsInSeconds: resetsInSeconds || 'unknown',
      resetInMinutes: resetsInSeconds ? Math.ceil(resetsInSeconds / 60) : 60,
      resetInHours: resetsInSeconds ? Math.ceil(resetsInSeconds / 3600) : 1
    })

    // 返回处理后的数据，避免循环引用
    return { resetsInSeconds, errorData }
  }

  // 过滤请求头 - 已迁移到 headerFilter 工具类
  // 此方法保留用于向后兼容，实际使用 filterForOpenAI()
  _filterRequestHeaders(headers) {
    return filterForOpenAI(headers)
  }

  // 估算费用（简化版本，实际应该根据不同的定价模型）
  _estimateCost(model, inputTokens, outputTokens) {
    // 这是一个简化的费用估算，实际应该根据不同的 API 提供商和模型定价
    const rates = {
      'gpt-4': { input: 0.03, output: 0.06 }, // per 1K tokens
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
      'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
      'claude-3-opus': { input: 0.015, output: 0.075 },
      'claude-3-sonnet': { input: 0.003, output: 0.015 },
      'claude-3-haiku': { input: 0.00025, output: 0.00125 }
    }

    // 查找匹配的模型定价
    let rate = rates['gpt-3.5-turbo'] // 默认使用 GPT-3.5 的价格
    for (const [modelKey, modelRate] of Object.entries(rates)) {
      if (model.toLowerCase().includes(modelKey.toLowerCase())) {
        rate = modelRate
        break
      }
    }

    const inputCost = (inputTokens / 1000) * rate.input
    const outputCost = (outputTokens / 1000) * rate.output
    return inputCost + outputCost
  }
}

module.exports = new OpenAIResponsesRelayService()
