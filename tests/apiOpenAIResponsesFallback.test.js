jest.mock('../src/services/relay/claudeRelayService', () => ({
  relayRequest: jest.fn(),
  _buildStandardRateLimitMessage: jest.fn(() => 'rate limited')
}))

jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({
  relayRequest: jest.fn()
}))

jest.mock('../src/services/relay/bedrockRelayService', () => ({
  handleNonStreamRequest: jest.fn()
}))

jest.mock('../src/services/relay/ccrRelayService', () => ({
  relayRequest: jest.fn()
}))

jest.mock('../src/services/account/bedrockAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  clearSessionMapping: jest.fn().mockResolvedValue()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true),
  recordUsageWithDetails: jest.fn()
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((_req, _res, next) => next())
}))

jest.mock('../src/services/claudeRelayConfigService', () => ({
  isGlobalSessionBindingEnabled: jest.fn().mockResolvedValue(false),
  extractOriginalSessionId: jest.fn(),
  validateNewSession: jest.fn(),
  getSessionBindingErrorMessage: jest.fn(),
  setOriginalSessionBinding: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  isCountTokensUnavailable: jest.fn(),
  markCountTokensUnavailable: jest.fn()
}))

jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/relay/openaiTokenAnthropicRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/utils/warmupInterceptor', () => ({
  isWarmupRequest: jest.fn(() => false),
  buildMockWarmupResponse: jest.fn(),
  sendMockWarmupStream: jest.fn()
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  sanitizeUpstreamError: jest.fn((value) => value),
  getSafeMessage: jest.fn()
}))

jest.mock('../src/utils/anthropicRequestDump', () => ({
  dumpAnthropicMessagesRequest: jest.fn()
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => null)
}))

jest.mock('../src/services/anthropicGeminiBridgeService', () => ({
  handleAnthropicMessagesToGemini: jest.fn(),
  handleAnthropicCountTokensToGemini: jest.fn()
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  security: jest.fn(),
  success: jest.fn(),
  warn: jest.fn()
}))

const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const claudeRelayService = require('../src/services/relay/claudeRelayService')
const claudeConsoleRelayService = require('../src/services/relay/claudeConsoleRelayService')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')
const openaiTokenAnthropicRelayService = require('../src/services/relay/openaiTokenAnthropicRelayService')
const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const { handleMessagesRequest, handleCountTokensRequest } = require('../src/routes/api')

function createReq() {
  return {
    apiKey: {
      id: 'key-1',
      name: 'Test Key',
      permissions: ['claude'],
      openaiAccountId: 'group:openai-group'
    },
    body: {
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false
    },
    headers: {},
    path: '/v1/messages',
    query: {},
    url: '/v1/messages'
  }
}

function createRes() {
  const res = {
    destroyed: false,
    finished: false,
    headers: {},
    headersSent: false,
    statusCode: 200,
    writableEnded: false,
    socket: null,
    end: jest.fn(() => {
      res.finished = true
      res.headersSent = true
      return res
    }),
    getHeader: jest.fn((key) => res.headers[key]),
    json: jest.fn((payload) => {
      res.payload = payload
      res.headersSent = true
      return res
    }),
    once: jest.fn(() => res),
    send: jest.fn((payload) => {
      res.payload = payload
      res.headersSent = true
      return res
    }),
    setHeader: jest.fn((key, value) => {
      res.headers[key] = value
    }),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    })
  }
  return res
}

describe('/v1/messages OpenAI-Responses fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    claudeRelayConfigService.extractOriginalSessionId.mockReturnValue(null)
    claudeRelayConfigService.validateNewSession.mockResolvedValue({
      valid: true,
      isNewSession: false
    })
  })

  it('preserves the original Claude scheduler error when fallback account selection fails', async () => {
    const claudeError = new Error('No available Claude accounts')
    claudeError.statusCode = 402
    unifiedClaudeScheduler.selectAccountForApiKey.mockRejectedValue(claudeError)

    const fallbackError = new Error('No available accounts in group OpenAI Group')
    fallbackError.statusCode = 402
    unifiedOpenAIScheduler.selectAccountForApiKey.mockRejectedValue(fallbackError)

    const res = createRes()
    await handleMessagesRequest(createReq(), res)

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalled()
    expect(openaiResponsesRelayService.handleRequest).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(402)
    expect(res.payload).toMatchObject({
      error: 'Relay service error',
      message: 'No available Claude accounts'
    })
  })

  it('routes image Claude fallback to OpenAI token accounts when selected', async () => {
    const claudeError = new Error('No available Claude accounts')
    claudeError.statusCode = 402
    unifiedClaudeScheduler.selectAccountForApiKey.mockRejectedValue(claudeError)
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-token-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-token-1',
      name: 'GPT-BEIMING',
      supportsImages: true
    })
    openaiTokenAnthropicRelayService.handleRequest.mockImplementation(async (_req, res) => {
      res.status(200).json({ ok: true })
    })

    const req = createReq()
    req.body.messages[0].content = [
      { type: 'text', text: 'describe' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc' }
      }
    ]

    const res = createRes()
    await handleMessagesRequest(req, res)

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      'claude-3-5-sonnet',
      expect.objectContaining({
        endpointKind: 'passthrough',
        hasImages: true,
        openaiResponsesOnly: true,
        allowOpenAITokenForAnthropicImages: true
      })
    )
    expect(openaiTokenAnthropicRelayService.handleRequest).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({ id: 'openai-token-1' }),
      req.apiKey
    )
    expect(openaiResponsesRelayService.handleRequest).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('keeps switching Claude accounts after 429 until one succeeds', async () => {
    unifiedClaudeScheduler.selectAccountForApiKey
      .mockResolvedValueOnce({
        accountId: 'claude-1',
        accountType: 'claude-official'
      })
      .mockResolvedValueOnce({
        accountId: 'claude-2',
        accountType: 'claude-official'
      })
      .mockResolvedValueOnce({
        accountId: 'claude-3',
        accountType: 'claude-official'
      })
      .mockResolvedValueOnce({
        accountId: 'claude-4',
        accountType: 'claude-official'
      })
    claudeAccountService.getAccount.mockImplementation(async (id) => ({
      id,
      interceptWarmup: 'false'
    }))
    claudeRelayService.relayRequest
      .mockResolvedValueOnce({
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: 'rate limited' } }),
        accountId: 'claude-1'
      })
      .mockResolvedValueOnce({
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: 'rate limited' } }),
        accountId: 'claude-2'
      })
      .mockResolvedValueOnce({
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: 'rate limited' } }),
        accountId: 'claude-3'
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-1',
          model: 'claude-3-5-sonnet',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 }
        }),
        accountId: 'claude-4'
      })

    const res = createRes()
    await handleMessagesRequest(createReq(), res)

    expect(claudeRelayService.relayRequest).toHaveBeenCalledTimes(4)
    expect(unifiedClaudeScheduler.selectAccountForApiKey.mock.calls[3][4]).toEqual({
      excludeAccountIds: ['claude-1', 'claude-2', 'claude-3']
    })
    expect(claudeRelayService.relayRequest.mock.calls[3][5]).toEqual({
      excludeAccountIds: ['claude-1', 'claude-2', 'claude-3']
    })
    expect(unifiedClaudeScheduler.clearSessionMapping).toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.status).not.toHaveBeenCalledWith(429)
  })

  it('returns 503 instead of 429 when Claude 429 retries are exhausted', async () => {
    unifiedClaudeScheduler.selectAccountForApiKey
      .mockResolvedValueOnce({
        accountId: 'claude-1',
        accountType: 'claude-official'
      })
      .mockRejectedValueOnce(new Error('No available accounts in group Test Group'))
    claudeAccountService.getAccount.mockResolvedValueOnce({ id: 'claude-1', interceptWarmup: 'false' })
    claudeRelayService.relayRequest.mockResolvedValueOnce({
      statusCode: 429,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { message: 'rate limited' } }),
      accountId: 'claude-1'
    })

    const res = createRes()
    await handleMessagesRequest(createReq(), res)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.status).not.toHaveBeenCalledWith(429)
    expect(res.payload).toMatchObject({
      error: 'service_unavailable',
      code: 'upstream_accounts_rate_limited'
    })
  })
})

describe('/v1/messages/count_tokens OpenAI-Responses fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    claudeRelayConfigService.extractOriginalSessionId.mockReturnValue(null)
    claudeRelayConfigService.validateNewSession.mockResolvedValue({
      valid: true,
      isNewSession: false
    })
  })

  it('routes count_tokens to OpenAI-Responses passthrough without zero-token fallback', async () => {
    const claudeError = new Error(
      'No available Claude accounts support the requested model: glm-5.2'
    )
    claudeError.statusCode = 400
    unifiedClaudeScheduler.selectAccountForApiKey.mockRejectedValue(claudeError)
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'responses-count-1',
      accountType: 'openai-responses'
    })
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'responses-count-1',
      name: 'Ark Passthrough'
    })
    openaiResponsesRelayService.handleRequest.mockImplementation(async (_req, res) => {
      res.status(200).json({ input_tokens: 1234 })
    })

    const req = createReq()
    req.path = '/v1/messages/count_tokens'
    req.url = '/v1/messages/count_tokens?beta=true'
    req.body = {
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hello' }]
    }
    const res = createRes()

    await handleCountTokensRequest(req, res)

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      expect.any(String),
      'glm-5.2',
      expect.objectContaining({
        endpointKind: 'passthrough',
        openaiResponsesOnly: true
      })
    )
    expect(openaiResponsesRelayService.handleRequest).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({ id: 'responses-count-1' }),
      req.apiKey,
      {
        customPath: '/v1/messages/count_tokens',
        skipUsageRecord: true
      }
    )
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.payload).toEqual({ input_tokens: 1234 })
    expect(res.payload).not.toEqual({ input_tokens: 0 })
  })

  it('rejects unsupported fallback account types instead of returning input_tokens zero', async () => {
    const claudeError = new Error(
      'No available Claude accounts support the requested model: glm-5.2'
    )
    claudeError.statusCode = 400
    unifiedClaudeScheduler.selectAccountForApiKey.mockRejectedValue(claudeError)
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-token-1',
      accountType: 'openai'
    })

    const req = createReq()
    req.path = '/v1/messages/count_tokens'
    req.url = '/v1/messages/count_tokens?beta=true'
    req.body = {
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hello' }]
    }
    const res = createRes()

    await handleCountTokensRequest(req, res)

    expect(openaiResponsesRelayService.handleRequest).not.toHaveBeenCalled()
    expect(openaiTokenAnthropicRelayService.handleRequest).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(501)
    expect(res.payload).toMatchObject({
      error: {
        type: 'not_supported',
        message: 'Token counting is not supported for openai fallback accounts'
      }
    })
    expect(res.payload).not.toEqual({ input_tokens: 0 })
  })

  it('rejects unavailable Claude Console count_tokens instead of returning input_tokens zero', async () => {
    unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'console-1',
      accountType: 'claude-console'
    })
    claudeConsoleAccountService.isCountTokensUnavailable.mockResolvedValue(true)

    const req = createReq()
    req.path = '/v1/messages/count_tokens'
    req.url = '/v1/messages/count_tokens?beta=true'
    req.body = {
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hello' }]
    }
    const res = createRes()

    await handleCountTokensRequest(req, res)

    expect(claudeConsoleRelayService.relayRequest).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(501)
    expect(res.payload).toMatchObject({
      error: {
        type: 'not_supported',
        message: 'Token counting is not available for this Claude Console account'
      }
    })
    expect(res.payload).not.toEqual({ input_tokens: 0 })
  })

  it('sanitizes upstream/internal error details before returning count_tokens errors', async () => {
    // 原始上游/内部错误细节不得直接暴露给客户端（与 98145da8 对齐）。
    const { getSafeMessage } = require('../src/utils/errorSanitizer')
    getSafeMessage.mockReturnValue('Upstream service error')

    const sensitiveError = new Error(
      'upstream relay failed for account acme-prod-1 at 10.0.0.5: database connection refused'
    )
    sensitiveError.statusCode = 500
    unifiedClaudeScheduler.selectAccountForApiKey.mockRejectedValue(sensitiveError)

    const req = createReq()
    req.path = '/v1/messages/count_tokens'
    req.url = '/v1/messages/count_tokens?beta=true'
    req.body = {
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hello' }]
    }
    const res = createRes()

    await handleCountTokensRequest(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.payload.error.type).toBe('server_error')
    expect(res.payload.error.message).toBe('Upstream service error')
    expect(res.payload.error.message).not.toMatch(/acme-prod-1|10\.0\.0\.5|database connection/i)
    expect(getSafeMessage).toHaveBeenCalledWith(sensitiveError, {
      context: 'count_tokens',
      logOriginal: false
    })
  })
})
