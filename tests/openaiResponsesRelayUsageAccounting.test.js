const { EventEmitter } = require('events')

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000
  }),
  { virtual: true }
)

jest.mock('axios', () => jest.fn())

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  api: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/headerFilter', () => ({
  filterForOpenAI: jest.fn((headers) => headers || {})
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  updateAccountUsage: jest.fn(),
  updateUsageQuota: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordUsage: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  markAccountRateLimited: jest.fn(),
  _deleteSessionMapping: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(),
  parseRetryAfter: jest.fn(() => null),
  sanitizeErrorForClient: jest.fn((error) => error),
  isTempUnavailable: jest.fn()
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn((_req, meta) => ({ requestId: 'req-1', ...meta })),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/services/codexToOpenAI', () =>
  jest.fn().mockImplementation(() => ({
    createStreamState: jest.fn(() => ({})),
    convertStreamChunk: jest.fn(() => []),
    convertResponse: jest.fn((data) => data)
  }))
)

const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')
const apiKeyService = require('../src/services/apiKeyService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const { extractOpenAICacheReadTokens } = require('../src/utils/requestDetailHelper')
const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')

function createReq(overrides = {}) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    method: 'POST',
    path: '/v1/responses',
    originalUrl: '/openai/v1/responses',
    headers: {},
    body: { model: 'gpt-4.1' },
    apiKey: { id: 'key-1' },
    _serviceTier: 'priority',
    _openaiCompatibleUpstreamBody: { model: 'gpt-4.1' },
    ...overrides
  })
}

function createRes({ onEnd } = {}) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    statusCode: 200,
    headers: {},
    destroyed: false,
    headersSent: false,
    setHeader: jest.fn((key, value) => {
      emitter.headers[key] = value
    }),
    status: jest.fn((code) => {
      emitter.statusCode = code
      return emitter
    }),
    json: jest.fn((payload) => {
      emitter.payload = payload
      return emitter
    }),
    write: jest.fn(),
    end: jest.fn(() => {
      if (onEnd) {
        onEnd()
      }
      return emitter
    })
  })
}

describe('openaiResponsesRelayService usage accounting', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.recordUsage.mockResolvedValue({ realCost: 0.001, ratedCost: 0.002 })
    openaiResponsesAccountService.updateAccountUsage.mockResolvedValue()
    openaiResponsesAccountService.updateUsageQuota.mockResolvedValue()
    updateRateLimitCounters.mockResolvedValue({ totalTokens: 0, ratedCost: 0 })
    extractOpenAICacheReadTokens.mockReturnValue(0)
  })

  test('records a zero-token request for successful non-stream responses without usage', async () => {
    const req = createReq({ rateLimitInfo: { tokenCountKey: 'tokens', costCountKey: 'cost' } })
    const res = createRes()
    const account = { id: 'acct-1', dailyQuota: '0' }
    const apiKeyData = { id: 'key-1' }

    await openaiResponsesRelayService._handleNormalResponse(
      { status: 200, data: { id: 'resp-1', model: 'gpt-4.1' } },
      res,
      account,
      apiKeyData,
      'gpt-4.1',
      req
    )

    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-1',
      0,
      0,
      0,
      0,
      'gpt-4.1',
      'acct-1',
      'openai-responses',
      'priority',
      expect.objectContaining({ stream: false, statusCode: 200 })
    )
    expect(updateRateLimitCounters).not.toHaveBeenCalled()
    expect(openaiResponsesAccountService.updateAccountUsage).toHaveBeenCalledWith('acct-1', 0)
    expect(res.status).toHaveBeenCalledWith(200)
  })

  test('uses recorded costs for rate-limit cost counters and account quota', async () => {
    extractOpenAICacheReadTokens.mockReturnValue(3)
    updateRateLimitCounters.mockResolvedValue({ totalTokens: 17, ratedCost: 0.002 })

    const req = createReq({ rateLimitInfo: { tokenCountKey: 'tokens', costCountKey: 'cost' } })
    const res = createRes()
    const account = { id: 'acct-1', dailyQuota: '10' }
    const apiKeyData = { id: 'key-1' }
    const usage = {
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17
    }

    await openaiResponsesRelayService._handleNormalResponse(
      { status: 200, data: { id: 'resp-1', model: 'gpt-4.1', usage } },
      res,
      account,
      apiKeyData,
      'gpt-4.1',
      req
    )

    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-1',
      9,
      5,
      0,
      3,
      'gpt-4.1',
      'acct-1',
      'openai-responses',
      'priority',
      expect.objectContaining({ stream: false, statusCode: 200 })
    )
    expect(updateRateLimitCounters).toHaveBeenCalledWith(
      req.rateLimitInfo,
      {
        totalInputTokens: 12,
        inputTokens: 9,
        outputTokens: 5,
        cacheCreateTokens: 0,
        cacheReadTokens: 3,
        totalTokens: 17
      },
      'gpt-4.1',
      'key-1',
      'openai-responses',
      { realCost: 0.001, ratedCost: 0.002 }
    )
    expect(openaiResponsesAccountService.updateUsageQuota).toHaveBeenCalledWith('acct-1', 0.001)
  })

  test('captures top-level Chat Completions stream usage once', async () => {
    extractOpenAICacheReadTokens.mockReturnValue(2)

    const upstream = new EventEmitter()
    const req = createReq({ rateLimitInfo: { tokenCountKey: 'tokens', costCountKey: 'cost' } })
    const endPromise = new Promise((resolve) => {
      const res = createRes({ onEnd: resolve })

      openaiResponsesRelayService._handleStreamResponse(
        { status: 200, data: upstream },
        res,
        { id: 'acct-1', dailyQuota: '0' },
        { id: 'key-1' },
        'gpt-4.1',
        jest.fn(),
        req
      )
    })

    upstream.emit(
      'data',
      Buffer.from(
        'data: {"object":"chat.completion.chunk","model":"gpt-4.1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'
      )
    )
    upstream.emit('end')
    await endPromise

    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-1',
      8,
      5,
      0,
      2,
      'gpt-4.1',
      'acct-1',
      'openai-responses',
      'priority',
      expect.objectContaining({ stream: true, statusCode: 200 })
    )
    expect(updateRateLimitCounters).toHaveBeenCalledTimes(1)
  })

  test('adds include_usage for Chat Completions streaming upstream requests', () => {
    const body = { model: 'gpt-4.1', stream: true, stream_options: { foo: 'bar' } }

    openaiResponsesRelayService._ensureChatCompletionsStreamUsage(body, 'chat_completions')

    expect(body.stream_options).toEqual({
      foo: 'bar',
      include_usage: true
    })
  })

  test('adapts Responses requests to Chat Completions upstream accounts', () => {
    const req = createReq({
      path: '/v1/responses',
      body: {
        model: 'gpt-5.5',
        instructions: 'system',
        input: 'hello',
        stream: true,
        max_output_tokens: 100
      }
    })

    const result = openaiResponsesRelayService.resolveUpstreamRequest(req, {
      id: 'acct-chat',
      providerEndpoint: 'chat_completions',
      boundModel: 'GLM-5.1'
    })

    expect(result.targetPath).toBe('/v1/chat/completions')
    expect(result.responseAdapter).toBe('chat_to_responses')
    expect(result.body).toMatchObject({
      model: 'GLM-5.1',
      stream: true,
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' }
      ]
    })
  })

  test('adapts Responses requests to Anthropic passthrough upstream accounts', () => {
    const req = createReq({
      path: '/v1/responses',
      body: {
        model: 'gpt-5.5',
        instructions: 'system',
        input: 'hello',
        stream: true,
        max_output_tokens: 100
      }
    })

    const result = openaiResponsesRelayService.resolveUpstreamRequest(req, {
      id: 'acct-pass',
      providerEndpoint: 'passthrough',
      boundModel: 'GLM-5.1'
    })

    expect(result.targetPath).toBe('/v1/messages')
    expect(result.responseAdapter).toBe('claude_to_responses')
    expect(result.body).toMatchObject({
      model: 'GLM-5.1',
      system: 'system',
      stream: true,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }]
    })
  })
})
