const axios = require('axios')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime')

const logger = require('../utils/logger')
const ProxyHelper = require('../utils/proxyHelper')
const upstreamErrorHelper = require('../utils/upstreamErrorHelper')
const redis = require('../models/redis')
const { normalizeUsage } = require('../utils/usageNormalizer')
const {
  createClaudeTestPayload,
  createGeminiTestPayload,
  createOpenAITestPayload,
  extractErrorMessage
} = require('../utils/testPayloadHelper')
const { buildGeminiApiUrl } = require('../handlers/geminiHandlers')

const claudeAccountService = require('./account/claudeAccountService')
const claudeConsoleAccountService = require('./account/claudeConsoleAccountService')
const bedrockAccountService = require('./account/bedrockAccountService')
const geminiAccountService = require('./account/geminiAccountService')
const geminiApiAccountService = require('./account/geminiApiAccountService')
const openaiAccountService = require('./account/openaiAccountService')
const openaiResponsesAccountService = require('./account/openaiResponsesAccountService')
const azureOpenaiAccountService = require('./account/azureOpenaiAccountService')
const droidAccountService = require('./account/droidAccountService')
const ccrAccountService = require('./account/ccrAccountService')

const claudeRelayService = require('./relay/claudeRelayService')
const bedrockRelayService = require('./relay/bedrockRelayService')
const openaiResponsesRelayService = require('./relay/openaiResponsesRelayService')
const unifiedClaudeScheduler = require('./scheduler/unifiedClaudeScheduler')
const unifiedOpenAIScheduler = require('./scheduler/unifiedOpenAIScheduler')
const modelService = require('./modelService')
const modelsConfig = require('../../config/models')

const AGENT_PROFILES = Object.freeze({
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    userAgent: 'codex_cli_rs/0.144.1 (account-test; admin)'
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    userAgent: 'claude-cli/2.1.207 (account-test, cli)'
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    userAgent: 'GeminiCLI/0.1 account-test'
  },
  droid: {
    id: 'droid',
    label: 'Droid',
    userAgent: 'factory-cli/0.32.1'
  }
})

const PLATFORM_ALIASES = Object.freeze({
  azure_openai: 'azure-openai',
  'openai-responses': 'openai-responses',
  openai_responses: 'openai-responses',
  'claude-console': 'claude-console',
  claude_console: 'claude-console',
  'gemini-api': 'gemini-api',
  gemini_api: 'gemini-api'
})

const DEFAULT_MODELS = Object.freeze({
  codex: 'gpt-5',
  'claude-code': 'claude-sonnet-4-5-20250929',
  'gemini-cli': 'gemini-2.5-flash',
  droid: 'claude-sonnet-4-20250514'
})

const DEFAULT_MAX_TOKENS = 32
const MAX_TEST_TOKENS = 256
const DEFAULT_TIMEOUT_MS = 45000
const DEFAULT_BATCH_CONCURRENCY = 2
const MAX_BATCH_CONCURRENCY = 5
const ACCOUNT_TEST_RESULTS_KEY = 'account_agent_test_results'
const LATEST_BATCH_TEST_RESULT_KEY = 'account_agent_test_latest_batch'
const BATCH_JOB_RETENTION_MS = 60 * 60 * 1000

const TEST_PLATFORMS = Object.freeze([
  'claude',
  'claude-console',
  'bedrock',
  'gemini',
  'gemini-api',
  'openai',
  'openai-responses',
  'azure-openai',
  'droid',
  'ccr'
])

class AccountAgentTestError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'AccountAgentTestError'
    this.statusCode = options.statusCode || 500
    this.responseData = options.responseData || null
    this.responseHeaders = options.responseHeaders || null
    this.code = options.code || null
    this.rateLimitHandled = options.rateLimitHandled === true
  }
}

class MemoryResponse extends EventEmitter {
  constructor() {
    super()
    this.statusCode = 200
    this.headers = {}
    this.headersSent = false
    this.writableEnded = false
    this.destroyed = false
    this.body = null
    this.chunks = []
  }

  status(code) {
    this.statusCode = code
    return this
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value
    return this
  }

  getHeader(name) {
    return this.headers[String(name).toLowerCase()]
  }

  writeHead(code, headers = {}) {
    this.statusCode = code
    Object.entries(headers).forEach(([name, value]) => this.setHeader(name, value))
    this.headersSent = true
    return this
  }

  write(chunk) {
    this.headersSent = true
    if (chunk !== undefined && chunk !== null) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
    return true
  }

  json(data) {
    this.headersSent = true
    this.writableEnded = true
    this.body = data
    return this
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) {
      this.write(chunk)
    }
    this.headersSent = true
    this.writableEnded = true
    if (this.body === null && this.chunks.length > 0) {
      const raw = Buffer.concat(this.chunks).toString()
      try {
        this.body = JSON.parse(raw)
      } catch {
        this.body = raw
      }
    }
    this.emit('finish')
    return this
  }
}

function normalizePlatform(platform) {
  const value = String(platform || '')
    .trim()
    .toLowerCase()
  return PLATFORM_ALIASES[value] || value
}

function isManuallyStopped(account) {
  return account?.schedulable === false || account?.schedulable === 'false'
}

function normalizeProxy(proxy) {
  if (!proxy) {
    return null
  }
  if (typeof proxy === 'object') {
    return proxy
  }
  if (typeof proxy === 'string') {
    try {
      return JSON.parse(proxy)
    } catch {
      return null
    }
  }
  return null
}

function createAxiosConfig(account, options = {}) {
  const config = {
    timeout: options.timeout || DEFAULT_TIMEOUT_MS,
    validateStatus: () => true,
    headers: options.headers || {}
  }
  const proxyAgent = ProxyHelper.createProxyAgent(normalizeProxy(account?.proxy))
  if (proxyAgent) {
    config.httpAgent = proxyAgent
    config.httpsAgent = proxyAgent
    config.proxy = false
  }
  return config
}

function clampMaxTokens(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_TOKENS
  }
  return Math.min(Math.floor(parsed), MAX_TEST_TOKENS)
}

function sanitizePrompt(value) {
  const prompt = typeof value === 'string' ? value.trim() : ''
  return (prompt || 'Reply with OK only.').slice(0, 1000)
}

function extractResponseText(data) {
  if (data === undefined || data === null) {
    return ''
  }
  if (typeof data === 'string') {
    return data
  }
  if (typeof data.output_text === 'string') {
    return data.output_text
  }
  if (Array.isArray(data.output)) {
    const outputText = data.output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .map((item) => item?.text || item?.output_text || '')
      .join('')
    if (outputText) {
      return outputText
    }
  }
  if (Array.isArray(data.choices)) {
    const choicesText = data.choices
      .map((choice) => choice?.message?.content || choice?.text || '')
      .join('')
    if (choicesText) {
      return choicesText
    }
  }
  if (Array.isArray(data.content)) {
    const contentText = data.content.map((item) => item?.text || '').join('')
    if (contentText) {
      return contentText
    }
  }
  const candidateText =
    data.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('') ||
    data.response?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('')
  if (candidateText) {
    return candidateText
  }
  if (data.response && data.response !== data) {
    return extractResponseText(data.response)
  }
  if (typeof data.message === 'string') {
    return data.message
  }
  return ''
}

function extractStatusCode(error) {
  const candidates = [
    error?.statusCode,
    error?.response?.status,
    error?.$metadata?.httpStatusCode,
    error?.responseData?.status,
    error?.status
  ]
  for (const value of candidates) {
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) {
      return parsed
    }
  }
  const messageMatch = String(error?.message || error?.error || '').match(
    /(?:HTTP|API error:)\s*(\d{3})/i
  )
  if (messageMatch) {
    return Number(messageMatch[1])
  }
  return 500
}

function extractRetryAfterSeconds(error) {
  const headers = error?.responseHeaders || error?.response?.headers || {}
  const fromHeaders = upstreamErrorHelper.parseRetryAfter(headers)
  if (fromHeaders) {
    return fromHeaders
  }
  const data = error?.responseData || error?.response?.data || null
  const candidates = [
    data?.error?.resets_in_seconds,
    data?.error?.retry_after,
    data?.resets_in_seconds,
    data?.retry_after
  ]
  for (const value of candidates) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.ceil(parsed)
    }
  }
  return null
}

function getErrorMessage(error, statusCode = null) {
  const responseData = error?.responseData || error?.response?.data
  const fallback = error?.message || (statusCode ? `HTTP ${statusCode}` : 'Account test failed')
  return extractErrorMessage(responseData, fallback)
}

function hasRateLimitState(account) {
  const status = String(account?.status || '').toLowerCase()
  return (
    account?.rateLimitStatus === 'limited' ||
    account?.rateLimitStatus?.isRateLimited === true ||
    status === 'ratelimited' ||
    status === 'rate_limited'
  )
}

function getDefaultAgent(platform, account = {}) {
  switch (normalizePlatform(platform)) {
    case 'openai':
    case 'azure-openai':
      return 'codex'
    case 'openai-responses':
      return ['passthrough', 'auto'].includes(account.providerEndpoint) ? 'claude-code' : 'codex'
    case 'gemini':
    case 'gemini-api':
      return 'gemini-cli'
    case 'droid':
      return 'droid'
    default:
      return 'claude-code'
  }
}

function getSupportedAgents(platform, account = {}) {
  switch (normalizePlatform(platform)) {
    case 'openai':
    case 'azure-openai':
      return ['codex']
    case 'openai-responses': {
      const agents = ['codex']
      if (['passthrough', 'auto'].includes(account.providerEndpoint)) {
        agents.push('claude-code')
      }
      return agents
    }
    case 'gemini':
    case 'gemini-api':
      return ['gemini-cli']
    case 'droid':
      return ['droid', 'codex', 'claude-code']
    case 'claude':
    case 'claude-console':
    case 'bedrock':
    case 'ccr':
      return ['claude-code']
    default:
      return []
  }
}

function normalizeModelId(value) {
  return String(value || '')
    .trim()
    .slice(0, 200)
}

function toModelOption(model) {
  const id = normalizeModelId(model?.id || model?.value || model)
  if (!id) {
    return null
  }
  return {
    value: id,
    label: model?.label || id,
    provider: model?.owned_by || model?.provider || ''
  }
}

function dedupeModelOptions(models) {
  const seen = new Set()
  const result = []
  for (const model of models || []) {
    const option = toModelOption(model)
    if (!option || seen.has(option.value)) {
      continue
    }
    seen.add(option.value)
    result.push(option)
  }
  return result
}

function getAccountPreferredModels(account = {}) {
  return dedupeModelOptions([
    account.boundModel,
    account.defaultModel,
    account.deploymentName,
    account.model
  ])
}

function modelLooksLikeProvider(model, provider) {
  const id = normalizeModelId(model?.id || model?.value || model).toLowerCase()
  const owner = String(model?.owned_by || model?.provider || '').toLowerCase()

  if (provider === 'openai') {
    return (
      owner.includes('openai') ||
      owner.includes('codex') ||
      /^gpt[-.]/.test(id) ||
      id.startsWith('codex') ||
      /^o\d/.test(id)
    )
  }

  if (provider === 'anthropic') {
    return (
      owner.includes('anthropic') ||
      owner.includes('claude') ||
      id.includes('claude') ||
      id.startsWith('anthropic.')
    )
  }

  if (provider === 'google') {
    return owner.includes('google') || owner.includes('gemini') || id.includes('gemini')
  }

  return false
}

function isCustomOpenAICompatibleModel(model) {
  const owner = String(model?.owned_by || model?.provider || '').toLowerCase()
  const id = normalizeModelId(model?.id || model?.value || model).toLowerCase()
  const looksLikeAnthropicOrGoogle =
    owner.includes('anthropic') ||
    owner.includes('claude') ||
    owner.includes('google') ||
    owner.includes('gemini') ||
    id.includes('claude') ||
    id.includes('gemini')
  return !looksLikeAnthropicOrGoogle
}

function getBedrockModelOptions(account = {}) {
  return dedupeModelOptions([
    ...getAccountPreferredModels(account),
    ...(modelsConfig.BEDROCK_MODELS || [])
  ])
}

function getClaudeConsoleModelOptions(account = {}, exposedModels = []) {
  const mapping = account.supportedModels
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return []
  }
  const exposedIds = new Set(
    exposedModels.map((model) => normalizeModelId(model?.id || model?.value || model).toLowerCase())
  )
  return dedupeModelOptions(
    Object.keys(mapping).filter((model) => exposedIds.has(normalizeModelId(model).toLowerCase()))
  )
}

async function getExposedModelOptionsForAgent(platform, agent, account = {}) {
  const normalizedPlatform = normalizePlatform(platform)

  if (normalizedPlatform === 'azure-openai') {
    return dedupeModelOptions([
      ...getAccountPreferredModels(account),
      ...((await modelService.getAllModels()).filter((model) =>
        modelLooksLikeProvider(model, 'openai')
      ) || [])
    ])
  }

  if (normalizedPlatform === 'bedrock') {
    return getBedrockModelOptions(account)
  }

  const exposedModels = await modelService.getAllModels()
  if (normalizedPlatform === 'claude-console') {
    const mappedModels = getClaudeConsoleModelOptions(account, exposedModels)
    if (Object.keys(account.supportedModels || {}).length > 0) {
      return mappedModels
    }
  }

  let providerModels
  if (agent === 'gemini-cli') {
    providerModels = exposedModels.filter((model) => modelLooksLikeProvider(model, 'google'))
  } else if (agent === 'claude-code' || agent === 'droid') {
    providerModels = exposedModels.filter((model) => modelLooksLikeProvider(model, 'anthropic'))
  } else {
    providerModels = exposedModels.filter((model) => {
      if (modelLooksLikeProvider(model, 'openai')) {
        return true
      }
      // OpenAI-compatible accounts can expose non-OpenAI provider IDs through /v1/models.
      return normalizedPlatform === 'openai-responses' && isCustomOpenAICompatibleModel(model)
    })
  }

  return dedupeModelOptions([...getAccountPreferredModels(account), ...providerModels])
}

async function resolveModel(platform, agent, account, requestedModel) {
  const explicit = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  if (explicit) {
    return explicit.slice(0, 200)
  }
  const accountModel =
    account?.boundModel || account?.defaultModel || account?.deploymentName || account?.model
  if (typeof accountModel === 'string' && accountModel.trim()) {
    return accountModel.trim().slice(0, 200)
  }
  const models = await getExposedModelOptionsForAgent(platform, agent, account)
  if (models.length > 0) {
    return models[0].value
  }
  return DEFAULT_MODELS[agent] || DEFAULT_MODELS[getDefaultAgent(platform, account)]
}

function buildCodexPayload(model, prompt, maxTokens) {
  return {
    ...createOpenAITestPayload(model, { prompt, maxTokens, stream: false }),
    instructions: 'You are Codex. Reply with exactly OK.',
    store: false
  }
}

function buildRelayRequest(agent, model, prompt, maxTokens) {
  const req = new EventEmitter()
  const sessionId = `account-test-${crypto.randomUUID()}`
  const profile = AGENT_PROFILES[agent]
  req.method = 'POST'
  req.headers = {
    'content-type': 'application/json',
    'user-agent': profile.userAgent,
    session_id: sessionId
  }

  if (agent === 'codex') {
    req.path = '/v1/responses'
    req.url = req.path
    req.originalUrl = `/openai${req.path}`
    req.body = buildCodexPayload(model, prompt, maxTokens)
    req.headers.version = '0.144.1'
    req.headers['openai-beta'] = 'responses=experimental'
  } else {
    req.path = '/v1/messages'
    req.url = req.path
    req.originalUrl = `/api${req.path}`
    req.body = createClaudeTestPayload(model, { prompt, maxTokens })
    req.headers['anthropic-version'] = '2023-06-01'
    req.headers['anthropic-beta'] = 'claude-code-20250219'
  }

  return req
}

async function postJson(account, url, payload, headers) {
  const response = await axios.post(
    url,
    payload,
    createAxiosConfig(account, {
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    })
  )
  return {
    statusCode: response.status,
    data: response.data,
    headers: response.headers
  }
}

class AccountAgentTestService {
  constructor() {
    this.batchJobs = new Map()
    this.activeBatchJobId = null
  }

  _resultKey(platform, accountId) {
    return `${normalizePlatform(platform)}:${accountId}`
  }

  _extractUsage(data = {}) {
    const payload = data?.response || data
    return (
      payload?.usage ||
      payload?.usageMetadata ||
      payload?.usage_metadata ||
      data?.usage ||
      data?.usageMetadata ||
      {}
    )
  }

  async _recordTestUsage({ accountId, platform, model, data }) {
    try {
      const usage = normalizeUsage(platform, this._extractUsage(data))
      await redis.incrementAccountUsage(
        accountId,
        usage.totalTokens,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreateTokens,
        usage.cacheReadTokens,
        usage.ephemeral5mTokens,
        usage.ephemeral1hTokens,
        model
      )
    } catch (error) {
      logger.warn('Failed to record account test usage', {
        accountId,
        platform,
        message: error.message
      })
    }
  }

  async _persistLatestResult(group) {
    try {
      const client = redis.getClientSafe()
      await client.hset(
        ACCOUNT_TEST_RESULTS_KEY,
        this._resultKey(group.platform, group.accountId),
        JSON.stringify(group)
      )
    } catch (error) {
      logger.warn('Failed to persist latest account test result', {
        accountId: group.accountId,
        platform: group.platform,
        message: error.message
      })
    }
  }

  async getLatestResults() {
    const client = redis.getClientSafe()
    const stored = await client.hgetall(ACCOUNT_TEST_RESULTS_KEY)
    return Object.values(stored || {})
      .map((value) => {
        try {
          return JSON.parse(value)
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.testedAt || '').localeCompare(String(a.testedAt || '')))
  }

  async getLatestBatchResult() {
    const client = redis.getClientSafe()
    const stored = await client.get(LATEST_BATCH_TEST_RESULT_KEY)
    if (!stored) {
      return null
    }
    try {
      return JSON.parse(stored)
    } catch {
      return null
    }
  }

  async _persistLatestBatchResult(result) {
    try {
      const client = redis.getClientSafe()
      await client.set(LATEST_BATCH_TEST_RESULT_KEY, JSON.stringify(result))
    } catch (error) {
      logger.warn('Failed to persist latest batch account test result', {
        message: error.message
      })
    }
  }

  startBatchTestJob(options = {}) {
    this._cleanupBatchJobs()
    if (this.activeBatchJobId) {
      const activeJob = this.batchJobs.get(this.activeBatchJobId)
      if (activeJob?.status === 'running') {
        return this._serializeBatchJob(activeJob, { reused: true })
      }
    }

    const now = new Date().toISOString()
    const job = {
      id: crypto.randomUUID(),
      status: 'running',
      phase: 'discovering',
      accountCount: 0,
      testCount: 0,
      completedCount: 0,
      successCount: 0,
      failedCount: 0,
      rateLimitedCount: 0,
      currentTests: new Map(),
      completedResults: [],
      result: null,
      error: '',
      startedAt: now,
      updatedAt: now,
      completedAt: null
    }
    this.batchJobs.set(job.id, job)
    this.activeBatchJobId = job.id

    this._runBatchTestJob(job, options).catch((error) => {
      logger.error('Unexpected batch account test job failure', {
        jobId: job.id,
        message: error.message
      })
    })
    return this._serializeBatchJob(job)
  }

  getBatchTestJob(jobId) {
    this._cleanupBatchJobs()
    const job = this.batchJobs.get(String(jobId || ''))
    if (!job) {
      throw new AccountAgentTestError('Batch account test job not found', { statusCode: 404 })
    }
    return this._serializeBatchJob(job)
  }

  async _runBatchTestJob(job, options) {
    try {
      const result = await this.testAccountsBatch({
        ...options,
        onProgress: (event) => this._updateBatchTestJob(job, event)
      })
      job.status = 'completed'
      job.phase = 'completed'
      job.result = result
      job.accountCount = result.accountCount
      job.testCount = result.testCount
      job.completedCount = result.testCount
      job.successCount = result.successCount
      job.failedCount = result.failedCount
      job.rateLimitedCount = result.rateLimitedCount
      job.currentTests.clear()
      job.completedAt = new Date().toISOString()
      job.updatedAt = job.completedAt
    } catch (error) {
      job.status = 'failed'
      job.phase = 'failed'
      job.error = error.message || 'Batch account test failed'
      job.currentTests.clear()
      job.completedAt = new Date().toISOString()
      job.updatedAt = job.completedAt
      logger.error('Batch account test job failed', { jobId: job.id, message: job.error })
    } finally {
      if (this.activeBatchJobId === job.id) {
        this.activeBatchJobId = null
      }
    }
  }

  _updateBatchTestJob(job, event = {}) {
    if (event.type === 'prepared') {
      job.phase = 'testing'
      job.accountCount = event.accountCount || 0
      job.testCount = event.testCount || 0
    } else if (event.type === 'started') {
      job.phase = 'testing'
      job.currentTests.set(event.index, event.job)
    } else if (event.type === 'completed') {
      job.currentTests.delete(event.index)
      job.completedResults.push(event.result)
      job.completedCount += 1
      if (event.result?.success) {
        job.successCount += 1
      } else {
        job.failedCount += 1
      }
      if (event.result?.statusCode === 429) {
        job.rateLimitedCount += 1
      }
    }
    job.updatedAt = new Date().toISOString()
  }

  _serializeBatchJob(job, extra = {}) {
    const progressPercent =
      job.testCount > 0
        ? Math.min(100, Math.round((job.completedCount / job.testCount) * 100))
        : job.status === 'completed'
          ? 100
          : 0
    return {
      id: job.id,
      status: job.status,
      phase: job.phase,
      accountCount: job.accountCount,
      testCount: job.testCount,
      completedCount: job.completedCount,
      pendingCount: Math.max(0, job.testCount - job.completedCount),
      progressPercent,
      successCount: job.successCount,
      failedCount: job.failedCount,
      rateLimitedCount: job.rateLimitedCount,
      currentTests: Array.from(job.currentTests.values()).map((item) => ({
        platform: item.platform,
        accountId: item.accountId,
        accountName: item.accountName || item.accountId,
        agent: item.agent,
        agentLabel: AGENT_PROFILES[item.agent]?.label || item.agent
      })),
      results: job.result?.results || this._groupProgressResults(job.completedResults),
      result: job.result,
      error: job.error,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      ...extra
    }
  }

  _groupProgressResults(results) {
    const groups = new Map()
    for (const result of results) {
      const key = `${normalizePlatform(result.platform)}:${result.accountId}`
      if (!groups.has(key)) {
        groups.set(key, {
          platform: normalizePlatform(result.platform),
          accountId: result.accountId,
          accountName: result.accountName || result.accountId,
          tests: [],
          testedAt: result.testedAt
        })
      }
      groups.get(key).tests.push(result)
      groups.get(key).testedAt = result.testedAt || groups.get(key).testedAt
    }
    return Array.from(groups.values())
  }

  _cleanupBatchJobs() {
    const cutoff = Date.now() - BATCH_JOB_RETENTION_MS
    for (const [jobId, job] of this.batchJobs.entries()) {
      if (job.status !== 'running' && Date.parse(job.completedAt || job.updatedAt) < cutoff) {
        this.batchJobs.delete(jobId)
      }
    }
  }

  getAgentProfiles() {
    return Object.values(AGENT_PROFILES).map(({ id, label }) => ({ id, label }))
  }

  async getCapabilities(platform, accountId) {
    const normalizedPlatform = normalizePlatform(platform)
    const account = await this._loadAccount(normalizedPlatform, accountId)
    const supportedAgents = getSupportedAgents(normalizedPlatform, account)
    const modelsByAgent = {}
    const defaultModelByAgent = {}
    for (const agent of supportedAgents) {
      const models = await getExposedModelOptionsForAgent(normalizedPlatform, agent, account)
      modelsByAgent[agent] = models
      defaultModelByAgent[agent] =
        (await resolveModel(normalizedPlatform, agent, account, null)) ||
        DEFAULT_MODELS[agent] ||
        ''
    }
    const defaultAgent = getDefaultAgent(normalizedPlatform, account)
    return {
      platform: normalizedPlatform,
      accountId,
      accountName: account.name || accountId,
      defaultAgent,
      supportedAgents,
      modelsByAgent,
      defaultModelByAgent,
      modelSource: 'models-endpoint'
    }
  }

  async testAccount(options = {}) {
    const platform = normalizePlatform(options.platform)
    const accountId = String(options.accountId || '').trim()
    if (!platform || !accountId) {
      throw new AccountAgentTestError('platform and accountId are required', { statusCode: 400 })
    }

    const account = await this._loadAccount(platform, accountId)
    const supportedAgents = getSupportedAgents(platform, account)
    if (supportedAgents.length === 0) {
      throw new AccountAgentTestError(`Unsupported account platform: ${platform}`, {
        statusCode: 400
      })
    }

    const requestedAgent = String(options.agent || 'auto')
      .trim()
      .toLowerCase()
    const agent = requestedAgent === 'auto' ? getDefaultAgent(platform, account) : requestedAgent
    if (!AGENT_PROFILES[agent] || !supportedAgents.includes(agent)) {
      throw new AccountAgentTestError(
        `Agent ${requestedAgent || 'auto'} is not compatible with ${platform}; supported: ${supportedAgents.join(', ')}`,
        { statusCode: 400 }
      )
    }

    const model = await resolveModel(platform, agent, account, options.model)
    const prompt = sanitizePrompt(options.prompt)
    const maxTokens = clampMaxTokens(options.maxTokens)
    const startedAt = Date.now()

    logger.info('Account agent test started', {
      accountId,
      accountName: account.name,
      platform,
      agent,
      model
    })

    try {
      const rawResult = await this._runTest({
        platform,
        account,
        accountId,
        agent,
        model,
        prompt,
        maxTokens
      })
      const statusCode = Number(rawResult.statusCode) || 200
      await this._recordTestUsage({
        accountId,
        platform,
        model,
        data: rawResult.data
      })
      if (statusCode >= 400) {
        throw new AccountAgentTestError(
          extractErrorMessage(rawResult.data, `Upstream returned HTTP ${statusCode}`),
          {
            statusCode,
            responseData: rawResult.data,
            responseHeaders: rawResult.headers,
            rateLimitHandled: rawResult.rateLimitHandled
          }
        )
      }

      const result = {
        success: true,
        accountId,
        accountName: account.name || accountId,
        platform,
        agent,
        agentLabel: AGENT_PROFILES[agent].label,
        model,
        statusCode,
        latency: Date.now() - startedAt,
        responseText: extractResponseText(rawResult.data).slice(0, 500),
        rateLimitedMarked: false,
        testedAt: new Date().toISOString()
      }
      if (options.persistResult !== false) {
        await this._persistLatestResult({
          accountId,
          accountName: result.accountName,
          platform,
          tests: [result],
          testedAt: result.testedAt
        })
      }
      logger.info('Account agent test passed', result)
      return result
    } catch (error) {
      const statusCode = extractStatusCode(error)
      let rateLimit = { marked: false, reason: '' }
      if (statusCode === 429) {
        if (error.rateLimitHandled) {
          rateLimit =
            account.disableAutoProtection === true || account.disableAutoProtection === 'true'
              ? { marked: false, reason: 'auto_protection_disabled' }
              : { marked: true, reason: '' }
        } else {
          try {
            rateLimit = await this._markRateLimited({
              platform,
              account,
              accountId,
              agent,
              model,
              retryAfterSeconds: extractRetryAfterSeconds(error),
              errorData: error.responseData || error.response?.data
            })
          } catch (markError) {
            logger.error('Failed to mark account as rate limited after account test', {
              accountId,
              platform,
              message: markError.message
            })
            rateLimit = { marked: false, reason: 'mark_failed' }
          }
        }
      }

      const result = {
        success: false,
        accountId,
        accountName: account.name || accountId,
        platform,
        agent,
        agentLabel: AGENT_PROFILES[agent].label,
        model,
        statusCode,
        latency: Date.now() - startedAt,
        error: getErrorMessage(error, statusCode),
        rateLimitedMarked: rateLimit.marked,
        rateLimitMarkReason: rateLimit.reason || '',
        testedAt: new Date().toISOString()
      }
      if (options.persistResult !== false) {
        await this._persistLatestResult({
          accountId,
          accountName: result.accountName,
          platform,
          tests: [result],
          testedAt: result.testedAt
        })
      }
      logger.warn('Account agent test failed', result)
      return result
    }
  }

  async testAccountsBatch(options = {}) {
    const startedAt = Date.now()
    const prompt = sanitizePrompt(options.prompt)
    const maxTokens = clampMaxTokens(options.maxTokens)
    const concurrency = Math.min(
      Math.max(parseInt(options.concurrency, 10) || DEFAULT_BATCH_CONCURRENCY, 1),
      MAX_BATCH_CONCURRENCY
    )
    const requestedAgents = Array.isArray(options.agents)
      ? options.agents
          .map((agent) =>
            String(agent || '')
              .trim()
              .toLowerCase()
          )
          .filter(Boolean)
      : []

    const accountRefs = Array.isArray(options.accounts)
      ? this._normalizeAccountRefs(options.accounts)
      : await this.listAllTestableAccounts({ includeInactive: options.includeInactive === true })

    const jobs = []
    const accountMeta = new Map()
    for (const ref of accountRefs) {
      const platform = normalizePlatform(ref.platform)
      if (!platform || !ref.accountId) {
        continue
      }

      try {
        const account = await this._loadAccount(platform, ref.accountId)
        if (isManuallyStopped(account)) {
          logger.info('Skipping manually stopped account in batch test', {
            platform,
            accountId: ref.accountId,
            accountName: account.name || ref.accountName || ref.accountId
          })
          continue
        }
        const supportedAgents = getSupportedAgents(platform, account)
        const agents =
          requestedAgents.length > 0
            ? supportedAgents.filter((agent) => requestedAgents.includes(agent))
            : supportedAgents

        if (agents.length === 0) {
          continue
        }

        const metaKey = `${platform}:${ref.accountId}`
        accountMeta.set(metaKey, {
          platform,
          accountId: ref.accountId,
          accountName: account.name || ref.accountName || ref.accountId,
          supportedAgents
        })

        for (const agent of agents) {
          jobs.push({
            platform,
            accountId: ref.accountId,
            accountName: account.name || ref.accountName || ref.accountId,
            agent,
            prompt,
            maxTokens
          })
        }
      } catch (error) {
        const metaKey = `${platform}:${ref.accountId}`
        accountMeta.set(metaKey, {
          platform,
          accountId: ref.accountId,
          accountName: ref.accountName || ref.accountId,
          supportedAgents: []
        })
        jobs.push({
          platform,
          accountId: ref.accountId,
          accountName: ref.accountName || ref.accountId,
          agent: 'auto',
          prompt,
          maxTokens,
          preflightError: error
        })
      }
    }

    this._notifyBatchProgress(options.onProgress, {
      type: 'prepared',
      accountCount: accountMeta.size,
      testCount: jobs.length
    })

    const flatResults = await this._mapWithConcurrency(jobs, concurrency, async (job, index) => {
      this._notifyBatchProgress(options.onProgress, { type: 'started', index, job })
      let result
      if (job.preflightError) {
        result = {
          success: false,
          accountId: job.accountId,
          accountName: job.accountId,
          platform: job.platform,
          agent: job.agent,
          agentLabel: job.agent === 'auto' ? 'Auto' : AGENT_PROFILES[job.agent]?.label || job.agent,
          model: '',
          statusCode: job.preflightError.statusCode || 500,
          latency: 0,
          error: job.preflightError.message || 'Account preflight failed',
          rateLimitedMarked: false,
          rateLimitMarkReason: '',
          testedAt: new Date().toISOString()
        }
      } else {
        result = await this.testAccount({
          platform: job.platform,
          accountId: job.accountId,
          agent: job.agent,
          prompt: job.prompt,
          maxTokens: job.maxTokens,
          persistResult: false
        })
      }
      this._notifyBatchProgress(options.onProgress, { type: 'completed', index, job, result })
      return result
    })

    const grouped = new Map()
    for (const result of flatResults) {
      const key = `${normalizePlatform(result.platform)}:${result.accountId}`
      const meta = accountMeta.get(key) || {
        platform: normalizePlatform(result.platform),
        accountId: result.accountId,
        accountName: result.accountName || result.accountId,
        supportedAgents: []
      }
      if (!grouped.has(key)) {
        grouped.set(key, { ...meta, tests: [] })
      }
      grouped.get(key).tests.push(result)
    }

    const groupedResults = Array.from(grouped.values()).map((group) => ({
      ...group,
      testedAt:
        group.tests
          .map((test) => test.testedAt)
          .filter(Boolean)
          .sort()
          .at(-1) || new Date().toISOString()
    }))
    await Promise.all(groupedResults.map((group) => this._persistLatestResult(group)))

    const failedTests = flatResults.filter((result) => !result.success).length
    const rateLimitedTests = flatResults.filter((result) => result.statusCode === 429).length
    const batchResult = {
      accountCount: grouped.size,
      testCount: flatResults.length,
      successCount: flatResults.length - failedTests,
      failedCount: failedTests,
      rateLimitedCount: rateLimitedTests,
      durationMs: Date.now() - startedAt,
      concurrency,
      results: groupedResults,
      testedAt: new Date().toISOString()
    }
    await this._persistLatestBatchResult(batchResult)
    return batchResult
  }

  async listAllTestableAccounts({ includeInactive = false } = {}) {
    const loaders = [
      { platform: 'claude', load: () => claudeAccountService.getAllAccounts() },
      { platform: 'claude-console', load: () => claudeConsoleAccountService.getAllAccounts() },
      { platform: 'bedrock', load: () => bedrockAccountService.getAllAccounts() },
      { platform: 'gemini', load: () => geminiAccountService.getAllAccounts() },
      {
        platform: 'gemini-api',
        load: () => geminiApiAccountService.getAllAccounts(includeInactive)
      },
      { platform: 'openai', load: () => openaiAccountService.getAllAccounts() },
      {
        platform: 'openai-responses',
        load: () => openaiResponsesAccountService.getAllAccounts(includeInactive)
      },
      { platform: 'azure-openai', load: () => azureOpenaiAccountService.getAllAccounts() },
      { platform: 'droid', load: () => droidAccountService.getAllAccounts() },
      { platform: 'ccr', load: () => ccrAccountService.getAllAccounts() }
    ]

    const refs = []
    for (const loader of loaders) {
      try {
        const raw = await loader.load()
        const accounts = this._normalizeAccountsList(raw)
        for (const account of accounts) {
          const accountId = String(account?.id || '').trim()
          if (!accountId || getSupportedAgents(loader.platform, account).length === 0) {
            continue
          }
          if (!includeInactive && (account.isActive === false || account.isActive === 'false')) {
            continue
          }
          if (isManuallyStopped(account)) {
            continue
          }
          refs.push({
            platform: loader.platform,
            accountId,
            accountName: account.name || account.email || account.accountName || accountId
          })
        }
      } catch (error) {
        logger.warn('Failed to load accounts for batch account test', {
          platform: loader.platform,
          message: error.message
        })
      }
    }
    return refs
  }

  _normalizeAccountRefs(accounts) {
    return accounts
      .map((account) => ({
        platform: normalizePlatform(account?.platform),
        accountId: String(account?.accountId || account?.id || '').trim(),
        accountName: account?.accountName || account?.name || account?.email || ''
      }))
      .filter((account) => TEST_PLATFORMS.includes(account.platform) && account.accountId)
  }

  _normalizeAccountsList(raw) {
    if (Array.isArray(raw)) {
      return raw
    }
    if (Array.isArray(raw?.data)) {
      return raw.data
    }
    if (Array.isArray(raw?.accounts)) {
      return raw.accounts
    }
    return []
  }

  async _mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length)
    let nextIndex = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await worker(items[index], index)
      }
    })
    await Promise.all(workers)
    return results
  }

  _notifyBatchProgress(callback, event) {
    if (typeof callback !== 'function') {
      return
    }
    try {
      callback(event)
    } catch (error) {
      logger.warn('Batch account test progress callback failed', { message: error.message })
    }
  }

  async _loadAccount(platform, accountId) {
    let account
    switch (platform) {
      case 'claude':
        account = await claudeAccountService.getAccount(accountId)
        break
      case 'claude-console':
        account = await claudeConsoleAccountService.getAccount(accountId)
        break
      case 'bedrock': {
        const result = await bedrockAccountService.getAccount(accountId)
        account = result?.success ? result.data : null
        break
      }
      case 'gemini':
        account = await geminiAccountService.getAccount(accountId)
        break
      case 'gemini-api':
        account = await geminiApiAccountService.getAccount(accountId)
        break
      case 'openai':
        account = await openaiAccountService.getAccount(accountId)
        break
      case 'openai-responses':
        account = await openaiResponsesAccountService.getAccount(accountId, {
          includeSecretHeaders: true
        })
        break
      case 'azure-openai':
        account = await azureOpenaiAccountService.getAccount(accountId)
        break
      case 'droid':
        account = await droidAccountService.getAccount(accountId)
        break
      case 'ccr':
        account = await ccrAccountService.getAccount(accountId)
        break
      default:
        throw new AccountAgentTestError(`Unsupported account platform: ${platform}`, {
          statusCode: 400
        })
    }

    if (!account) {
      throw new AccountAgentTestError('Account not found', { statusCode: 404 })
    }
    return account
  }

  async _runTest(context) {
    switch (context.platform) {
      case 'claude':
        return this._testClaude(context)
      case 'claude-console':
        return this._testClaudeConsole(context)
      case 'bedrock':
        return this._testBedrock(context)
      case 'gemini':
        return this._testGemini(context)
      case 'gemini-api':
        return this._testGeminiApi(context)
      case 'openai':
        return this._testOpenAI(context)
      case 'openai-responses':
        return this._testOpenAIResponses(context)
      case 'azure-openai':
        return this._testAzureOpenAI(context)
      case 'droid':
        return this._testDroid(context)
      case 'ccr':
        return this._testCcr(context)
      default:
        throw new AccountAgentTestError(`Unsupported account platform: ${context.platform}`, {
          statusCode: 400
        })
    }
  }

  async _testClaude({ accountId, model }) {
    const result = await claudeRelayService.testAccountConnectionSync(accountId, model)
    const statusCode = result.success ? 200 : result.statusCode || extractStatusCode(result)
    let rateLimitHandled = false
    if (statusCode === 429) {
      const currentAccount = await claudeAccountService.getAccount(accountId)
      rateLimitHandled =
        currentAccount?.disableAutoProtection === true ||
        currentAccount?.disableAutoProtection === 'true' ||
        hasRateLimitState(currentAccount)
    }
    return {
      statusCode,
      rateLimitHandled,
      data: result.success
        ? { message: result.message, model: result.model, usage: result.usage }
        : { error: { message: result.error } }
    }
  }

  async _testClaudeConsole({ account, model, prompt, maxTokens }) {
    const cleanUrl = String(account.apiUrl || '').replace(/\/+$/, '')
    if (!cleanUrl) {
      throw new AccountAgentTestError('Claude Console API URL is not configured', {
        statusCode: 400
      })
    }
    const apiUrl = cleanUrl.endsWith('/v1/messages') ? cleanUrl : `${cleanUrl}/v1/messages`
    const headers = {
      'anthropic-version': '2023-06-01',
      'User-Agent': account.userAgent || AGENT_PROFILES['claude-code'].userAgent
    }
    if (account.apiKey?.startsWith('sk-ant-')) {
      headers['x-api-key'] = account.apiKey
    } else {
      headers.Authorization = `Bearer ${account.apiKey}`
    }
    const upstreamModel = claudeConsoleAccountService.getMappedModel(account.supportedModels, model)
    return postJson(
      account,
      apiUrl,
      createClaudeTestPayload(upstreamModel, { prompt, maxTokens }),
      headers
    )
  }

  async _testBedrock({ account, model, prompt, maxTokens }) {
    const client = bedrockRelayService._getBedrockClient(account.region, account)
    const command = new InvokeModelCommand({
      modelId: model,
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      }),
      contentType: 'application/json',
      accept: 'application/json'
    })
    try {
      const response = await client.send(command)
      const raw = Buffer.from(response.body || []).toString()
      return {
        statusCode: response.$metadata?.httpStatusCode || 200,
        data: raw ? JSON.parse(raw) : {}
      }
    } catch (error) {
      error.statusCode = error.$metadata?.httpStatusCode || error.statusCode
      throw error
    }
  }

  async _testGemini({ account, accountId, model, prompt, maxTokens }) {
    const proxy = normalizeProxy(account.proxy)
    const client = await geminiAccountService.getOauthClient(
      account.accessToken,
      account.refreshToken,
      proxy,
      account.oauthProvider
    )
    if (!client) {
      throw new AccountAgentTestError('Failed to create Gemini OAuth client', { statusCode: 401 })
    }

    let projectId = account.projectId || account.tempProjectId || null
    const oauthProvider = account.oauthProvider || 'gemini-cli'
    if (!projectId && oauthProvider === 'antigravity') {
      projectId = `ag-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
      await geminiAccountService.updateTempProjectId(accountId, projectId)
    } else if (!projectId) {
      const loadResponse = await geminiAccountService.loadCodeAssist(client, null, proxy)
      projectId = loadResponse?.cloudaicompanionProject || null
      if (projectId) {
        await geminiAccountService.updateTempProjectId(accountId, projectId)
      }
    }
    if (!projectId) {
      throw new AccountAgentTestError('Gemini account requires a project ID', { statusCode: 403 })
    }

    const requestData = {
      model,
      request: createGeminiTestPayload(model, { prompt, maxTokens })
    }
    const userPromptId = `${crypto.randomUUID()}########0`
    const sessionId = `account-test-${crypto.randomUUID()}`
    const data =
      oauthProvider === 'antigravity'
        ? await geminiAccountService.generateContentAntigravity(
            client,
            requestData,
            userPromptId,
            projectId,
            sessionId,
            proxy
          )
        : await geminiAccountService.generateContent(
            client,
            requestData,
            userPromptId,
            projectId,
            sessionId,
            proxy
          )
    return { statusCode: 200, data }
  }

  async _testGeminiApi({ account, model, prompt, maxTokens }) {
    const baseUrl = account.baseUrl || 'https://generativelanguage.googleapis.com'
    const apiUrl = buildGeminiApiUrl(baseUrl, model, 'generateContent', account.apiKey)
    return postJson(account, apiUrl, createGeminiTestPayload(model, { prompt, maxTokens }), {
      'User-Agent': AGENT_PROFILES['gemini-cli'].userAgent
    })
  }

  async _testOpenAI({ account, accountId, model, prompt, maxTokens }) {
    let currentAccount = account
    if (openaiAccountService.isTokenExpired(currentAccount) && currentAccount.refreshToken) {
      await openaiAccountService.refreshAccountToken(accountId)
      currentAccount = await openaiAccountService.getAccount(accountId)
    }
    if (!currentAccount?.accessToken) {
      throw new AccountAgentTestError('OpenAI access token is unavailable', { statusCode: 401 })
    }
    const accessToken = openaiAccountService.decrypt(currentAccount.accessToken)
    if (!accessToken) {
      throw new AccountAgentTestError('Failed to decrypt OpenAI access token', { statusCode: 401 })
    }
    const codexModel = model.startsWith('gpt-5-') && !model.includes('codex') ? 'gpt-5' : model
    const payload = { ...buildCodexPayload(codexModel, prompt, maxTokens), stream: true }
    delete payload.max_output_tokens
    return postJson(currentAccount, 'https://chatgpt.com/backend-api/codex/responses', payload, {
      Authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': currentAccount.accountId || currentAccount.chatgptUserId || accountId,
      'User-Agent': AGENT_PROFILES.codex.userAgent,
      Accept: 'application/json',
      version: '0.144.1',
      'openai-beta': 'responses=experimental'
    })
  }

  async _testOpenAIResponses({ account, agent, model, prompt, maxTokens }) {
    const req = buildRelayRequest(agent, model, prompt, maxTokens)
    const res = new MemoryResponse()
    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      account,
      { id: 'admin-account-test', name: 'Admin account test' },
      { skipUsageRecord: true, maxNetworkRetries: 0 }
    )
    return {
      statusCode: res.statusCode,
      data: res.body,
      headers: res.headers,
      rateLimitHandled: res.statusCode === 429
    }
  }

  async _testAzureOpenAI({ account, model, prompt, maxTokens }) {
    const apiKey = await azureOpenaiAccountService.getDecryptedApiKey(account.id)
    if (!apiKey) {
      throw new AccountAgentTestError('Azure OpenAI API key is unavailable', { statusCode: 401 })
    }
    const deploymentName = account.deploymentName || model
    const apiVersion = account.apiVersion || '2025-04-01-preview'
    const endpoint = String(account.azureEndpoint || account.endpoint || '').replace(/\/+$/, '')
    if (!endpoint) {
      throw new AccountAgentTestError('Azure OpenAI endpoint is unavailable', { statusCode: 400 })
    }
    const apiUrl = `${endpoint}/openai/responses?api-version=${encodeURIComponent(apiVersion)}`
    return postJson(account, apiUrl, buildCodexPayload(deploymentName, prompt, maxTokens), {
      'api-key': apiKey,
      'User-Agent': AGENT_PROFILES.codex.userAgent,
      version: '0.144.1',
      'openai-beta': 'responses=experimental'
    })
  }

  async _testDroid({ account, accountId, agent, model, prompt, maxTokens }) {
    let accessToken
    try {
      if (
        String(account.authenticationMethod || '')
          .trim()
          .toLowerCase() === 'api_key'
      ) {
        const entries = await droidAccountService.getDecryptedApiKeyEntries(accountId)
        accessToken = entries.find((entry) => entry.status !== 'error')?.key || ''
      } else {
        accessToken = await droidAccountService.getValidAccessToken(accountId)
      }
    } catch (error) {
      throw new AccountAgentTestError(error.message || 'Droid credential is unavailable', {
        statusCode: 401
      })
    }
    if (!accessToken) {
      throw new AccountAgentTestError('Droid credential is unavailable', { statusCode: 401 })
    }

    const sessionId = crypto.randomUUID()
    const usesResponses = agent === 'codex'
    const apiUrl = usesResponses
      ? 'https://api.factory.ai/api/llm/o/v1/responses'
      : 'https://api.factory.ai/api/llm/a/v1/messages'
    const payload = usesResponses
      ? {
          ...buildCodexPayload(model, prompt, maxTokens),
          instructions: 'You are Droid, an AI software engineering agent built by Factory.'
        }
      : {
          ...createClaudeTestPayload(model, { prompt, maxTokens }),
          system: [
            {
              type: 'text',
              text:
                agent === 'droid'
                  ? 'You are Droid, an AI software engineering agent built by Factory.'
                  : "You are Claude Code, Anthropic's official CLI for Claude."
            }
          ]
        }

    return postJson(account, apiUrl, payload, {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': AGENT_PROFILES[agent].userAgent,
      'x-factory-client': 'cli',
      'x-api-provider': usesResponses
        ? model.toLowerCase().includes('-max')
          ? 'openai'
          : 'azure_openai'
        : 'anthropic',
      'x-session-id': sessionId,
      ...(usesResponses
        ? {}
        : {
            'anthropic-version': '2023-06-01',
            'x-api-key': 'placeholder'
          })
    })
  }

  async _testCcr({ account, accountId, model, prompt, maxTokens }) {
    const credentials = await ccrAccountService.getDecryptedCredentials(accountId)
    if (!credentials?.apiKey) {
      throw new AccountAgentTestError('CCR credentials are unavailable', { statusCode: 401 })
    }
    const baseUrl = String(
      account.apiUrl || account.baseUrl || 'https://api.anthropic.com'
    ).replace(/\/+$/, '')
    const apiUrl = baseUrl.endsWith('/v1/messages') ? baseUrl : `${baseUrl}/v1/messages`
    return postJson(account, apiUrl, createClaudeTestPayload(model, { prompt, maxTokens }), {
      'x-api-key': credentials.apiKey,
      'anthropic-version': '2023-06-01',
      'User-Agent': AGENT_PROFILES['claude-code'].userAgent
    })
  }

  async _markRateLimited(context) {
    const { platform, account, accountId, agent, model, retryAfterSeconds, errorData } = context
    if (account.disableAutoProtection === true || account.disableAutoProtection === 'true') {
      await upstreamErrorHelper
        .recordErrorHistory(accountId, platform, 429, 'rate_limit', {
          model,
          path: `admin-account-test:${agent}`,
          errorBody: errorData
        })
        .catch(() => {})
      return { marked: false, reason: 'auto_protection_disabled' }
    }

    const durationMinutes = retryAfterSeconds ? Math.ceil(retryAfterSeconds / 60) : null
    const resetAtTimestamp = retryAfterSeconds
      ? Math.ceil(Date.now() / 1000 + retryAfterSeconds)
      : null

    let markResult

    switch (platform) {
      case 'claude':
        markResult = await unifiedClaudeScheduler.markAccountRateLimited(
          accountId,
          'claude-official',
          null,
          resetAtTimestamp
        )
        break
      case 'claude-console':
        markResult = await claudeConsoleAccountService.markAccountRateLimited(accountId)
        break
      case 'bedrock':
        markResult = await bedrockAccountService.markAccountRateLimited(accountId, durationMinutes)
        break
      case 'gemini':
        markResult = await geminiAccountService.setAccountRateLimited(
          accountId,
          true,
          durationMinutes
        )
        break
      case 'gemini-api':
        markResult = await geminiApiAccountService.setAccountRateLimited(
          accountId,
          true,
          durationMinutes
        )
        break
      case 'openai':
        markResult = await unifiedOpenAIScheduler.markAccountRateLimited(
          accountId,
          'openai',
          null,
          retryAfterSeconds
        )
        break
      case 'openai-responses':
        markResult = await unifiedOpenAIScheduler.markAccountRateLimited(
          accountId,
          'openai-responses',
          null,
          retryAfterSeconds
        )
        break
      case 'azure-openai':
        markResult = await azureOpenaiAccountService.markAccountRateLimited(
          accountId,
          durationMinutes
        )
        break
      case 'droid':
        markResult = await droidAccountService.markAccountRateLimited(accountId, durationMinutes)
        break
      case 'ccr':
        markResult = await ccrAccountService.markAccountRateLimited(accountId)
        break
      default:
        return { marked: false, reason: 'unsupported_platform' }
    }

    await upstreamErrorHelper
      .recordErrorHistory(accountId, platform, 429, 'rate_limit', {
        model,
        path: `admin-account-test:${agent}`,
        errorBody: errorData
      })
      .catch(() => {})
    if (markResult?.skipped) {
      return { marked: false, reason: 'rate_limit_disabled' }
    }
    return { marked: true, reason: '' }
  }
}

const accountAgentTestService = new AccountAgentTestService()

module.exports = accountAgentTestService
module.exports.AccountAgentTestError = AccountAgentTestError
module.exports.AGENT_PROFILES = AGENT_PROFILES
module.exports.getDefaultAgent = getDefaultAgent
module.exports.getSupportedAgents = getSupportedAgents
module.exports.normalizePlatform = normalizePlatform
