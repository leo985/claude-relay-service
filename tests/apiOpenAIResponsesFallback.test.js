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
  clearSessionMapping: jest.fn()
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
  getAccount: jest.fn()
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
  sanitizeUpstreamError: jest.fn((value) => value)
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
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')
const openaiTokenAnthropicRelayService = require('../src/services/relay/openaiTokenAnthropicRelayService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const { handleMessagesRequest } = require('../src/routes/api')

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
})
