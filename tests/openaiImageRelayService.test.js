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
  error: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/headerFilter', () => ({
  filterForOpenAI: jest.fn((headers = {}) => {
    const filtered = {}
    for (const [key, value] of Object.entries(headers)) {
      if (!['authorization', 'content-length', 'host'].includes(key.toLowerCase())) {
        filtered[key] = value
      }
    }
    return filtered
  })
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  updateAccountUsage: jest.fn(),
  updateUsageQuota: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordImageUsage: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  markAccountRateLimited: jest.fn(),
  _deleteSessionMapping: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(),
  parseRetryAfter: jest.fn(() => null),
  buildSafeUpstreamErrorForClient: jest.fn((_status, _error) => ({ error: { message: 'safe' } })),
  sanitizeErrorForClient: jest.fn((error) => error)
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn((_req, meta) => ({ requestId: 'req-image-1', ...meta }))
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

const axios = require('axios')
const openaiImageRelayService = require('../src/services/relay/openaiImageRelayService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const { createRequestDetailMeta } = require('../src/utils/requestDetailHelper')
const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')

function createReq(overrides = {}) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    method: 'POST',
    path: '/v1/images/generations',
    originalUrl: '/openai/v1/images/generations',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer client-key'
    },
    body: { model: 'client-image-model', prompt: 'draw a cat' },
    apiKey: { id: 'key-1' },
    ...overrides
  })
}

function createRes() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    statusCode: 200,
    headersSent: false,
    status: jest.fn((code) => {
      emitter.statusCode = code
      return emitter
    }),
    json: jest.fn((payload) => {
      emitter.payload = payload
      return emitter
    }),
    end: jest.fn(() => emitter)
  })
}

function fullAccount(overrides = {}) {
  return {
    id: 'acct-1',
    name: 'image-account',
    apiKey: 'sk-upstream',
    baseApi: 'https://api.openai.com/v1',
    boundModel: 'gpt-5.5',
    imageBoundModel: 'gpt-image-2-upstream',
    customHeaders: { 'X-Custom': '1' },
    userAgent: 'image-agent',
    dailyQuota: '0',
    ...overrides
  }
}

describe('openaiImageRelayService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    axios.mockReset()
    openaiResponsesAccountService.getAccount.mockResolvedValue(fullAccount())
    openaiResponsesAccountService.updateAccount.mockResolvedValue()
    openaiResponsesAccountService.updateAccountUsage.mockResolvedValue()
    openaiResponsesAccountService.updateUsageQuota.mockResolvedValue()
    apiKeyService.recordImageUsage.mockResolvedValue({ realCost: 0, ratedCost: 0 })
    updateRateLimitCounters.mockResolvedValue({ totalTokens: 0, totalCost: 0 })
  })

  test('rejects image streaming before selecting an account', async () => {
    const req = createReq({ body: { model: 'gpt-image-2', stream: true, prompt: 'draw' } })
    const res = createRes()

    await openaiImageRelayService.handleGenerations(req, res, { id: 'acct-1' }, { id: 'key-1' })

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.payload.error.code).toBe('image_stream_not_supported')
    expect(openaiResponsesAccountService.getAccount).not.toHaveBeenCalled()
    expect(axios).not.toHaveBeenCalled()
  })

  test('forwards generations with imageBoundModel and records zero usage when usage is absent', async () => {
    axios.mockResolvedValue({ status: 200, data: { id: 'img-1', data: [] } })
    const req = createReq({ body: { model: 'client-image-model', prompt: 'draw a cat' } })
    const res = createRes()

    await openaiImageRelayService.handleGenerations(
      req,
      res,
      { id: 'acct-1', name: 'image-account' },
      { id: 'key-1' }
    )

    const upstreamRequest = axios.mock.calls[0][0]
    expect(upstreamRequest.url).toBe('https://api.openai.com/v1/images/generations')
    expect(upstreamRequest.data).toEqual({
      model: 'gpt-image-2-upstream',
      prompt: 'draw a cat'
    })
    expect(upstreamRequest.headers.Authorization).toBe('Bearer sk-upstream')
    expect(upstreamRequest.headers['Content-Type']).toBe('application/json')
    expect(upstreamRequest.headers['User-Agent']).toBe('image-agent')
    expect(upstreamRequest.headers['X-Custom']).toBe('1')

    expect(apiKeyService.recordImageUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: 'key-1',
        model: 'gpt-image-2-upstream',
        accountId: 'acct-1',
        imageUsage: expect.objectContaining({
          inputTextTokens: 0,
          inputImageTokens: 0,
          outputImageTokens: 0,
          totalTokens: 0
        })
      })
    )
    expect(openaiResponsesAccountService.updateAccountUsage).toHaveBeenCalledWith('acct-1', 0)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.payload).toEqual({ id: 'img-1', data: [] })
  })

  test('rejects non-multipart edits without touching the upstream account', async () => {
    const req = createReq({
      path: '/v1/images/edits',
      originalUrl: '/openai/v1/images/edits',
      headers: { 'content-type': 'application/json' },
      body: { model: 'gpt-image-2' }
    })
    const res = createRes()

    await openaiImageRelayService.handleEdits(req, res, { id: 'acct-1' }, { id: 'key-1' })

    expect(res.status).toHaveBeenCalledWith(415)
    expect(res.payload.error.code).toBe('unsupported_media_type')
    expect(openaiResponsesAccountService.getAccount).not.toHaveBeenCalled()
    expect(axios).not.toHaveBeenCalled()
  })

  test('passes multipart edits as the raw request stream and records image usage', async () => {
    axios.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-image-2',
        data: [],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30
        }
      }
    })
    openaiResponsesAccountService.getAccount.mockResolvedValue(
      fullAccount({ imageBoundModel: 'raw-model-hint' })
    )

    const req = createReq({
      path: '/v1/images/edits',
      originalUrl: '/openai/v1/images/edits',
      headers: {
        'content-type': 'multipart/form-data; boundary=abc123',
        'content-length': '999',
        authorization: 'Bearer client-key'
      },
      body: undefined,
      rateLimitInfo: { tokenCountKey: 'tokens', costCountKey: 'cost' }
    })
    const res = createRes()

    await openaiImageRelayService.handleEdits(
      req,
      res,
      { id: 'acct-1', name: 'image-account' },
      { id: 'key-1' }
    )

    const upstreamRequest = axios.mock.calls[0][0]
    expect(upstreamRequest.url).toBe('https://api.openai.com/v1/images/edits')
    expect(upstreamRequest.data).toBe(req)
    expect(upstreamRequest.headers.Authorization).toBe('Bearer sk-upstream')
    expect(upstreamRequest.headers['Content-Type']).toBe('multipart/form-data; boundary=abc123')
    expect(upstreamRequest.headers['content-length']).toBeUndefined()

    expect(createRequestDetailMeta).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        requestBody: expect.objectContaining({
          multipart: true,
          contentLength: '999',
          modelHint: 'raw-model-hint'
        }),
        stream: false,
        statusCode: 200
      })
    )
    expect(apiKeyService.recordImageUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: 'key-1',
        model: 'gpt-image-2',
        imageUsage: expect.objectContaining({
          inputTextTokens: 10,
          inputImageTokens: 0,
          outputImageTokens: 20,
          totalTokens: 30
        })
      })
    )
    expect(updateRateLimitCounters).toHaveBeenCalledWith(
      req.rateLimitInfo,
      {
        totalInputTokens: 10,
        inputTokens: 10,
        outputTokens: 20,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 30
      },
      'gpt-image-2',
      'key-1',
      'openai-responses',
      { realCost: 0, ratedCost: 0 }
    )
    expect(openaiResponsesAccountService.updateAccountUsage).toHaveBeenCalledWith('acct-1', 30)
    expect(res.status).toHaveBeenCalledWith(200)
  })
})
