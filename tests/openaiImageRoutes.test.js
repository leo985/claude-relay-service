const mockRouter = {
  get: jest.fn(),
  post: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000
  }),
  { virtual: true }
)

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((_req, _res, next) => next())
}))

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountRateLimited: jest.fn(),
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  removeAccountRateLimit: jest.fn(),
  markAccountUnauthorized: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  decrypt: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  updateCodexUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/relay/openaiImageRelayService', () => ({
  handleGenerations: jest.fn(),
  handleEdits: jest.fn()
}))

jest.mock('../src/services/relay/openaiTokenImageRelayService', () => ({
  handleGenerations: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true),
  recordUsage: jest.fn()
}))

jest.mock('../src/services/modelService', () => ({
  getAllModels: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getUsageStats: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/sseParser', () => ({
  IncrementalSSEParser: jest.fn().mockImplementation(() => ({
    feed: jest.fn(() => []),
    getRemaining: jest.fn(() => '')
  }))
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((error) => error?.message || 'error')
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => null),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))

jest.mock('../src/services/requestBodyRuleService', () => ({
  applyRules: jest.fn((body) => body)
}))

const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiImageRelayService = require('../src/services/relay/openaiImageRelayService')
const openaiTokenImageRelayService = require('../src/services/relay/openaiTokenImageRelayService')
const modelService = require('../src/services/modelService')
const openaiRoutes = require('../src/routes/openaiRoutes')
const registeredGetRoutes = mockRouter.get.mock.calls.map(([path, _middleware, handler]) => ({
  path,
  handler
}))

function createReq(overrides = {}) {
  return {
    method: 'POST',
    path: '/v1/images/generations',
    originalUrl: '/openai/v1/images/generations',
    headers: {
      'content-type': 'application/json'
    },
    body: {},
    apiKey: {
      id: 'key-1',
      name: 'Image Key',
      permissions: ['openai']
    },
    ...overrides
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.payload = payload
      return res
    }),
    end: jest.fn(() => res)
  }
  return res
}

describe('openai image routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'resp-1',
      accountType: 'openai-responses'
    })
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      name: 'Responses Image Account',
      apiKey: 'sk-responses'
    })
    openaiImageRelayService.handleGenerations.mockResolvedValue({ ok: true })
    openaiImageRelayService.handleEdits.mockResolvedValue({ ok: true })
  })

  test('routes image generations through OpenAI-Responses accounts with default model features', async () => {
    const req = createReq({ body: { prompt: 'draw a cat' } })
    const res = createRes()

    await openaiRoutes.handleImageGenerations(req, res)

    expect(req.body.model).toBe('gpt-image-2')
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      null,
      'gpt-image-2',
      expect.objectContaining({
        endpointKind: 'images',
        hasImageGeneration: true,
        imageOperation: 'generations',
        imageModel: 'gpt-image-2'
      })
    )
    expect(openaiImageRelayService.handleGenerations).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({ id: 'resp-1' }),
      req.apiKey
    )
  })

  test('routes image generations through token-mode accounts to the token image relay', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValueOnce({
      accountId: 'tok-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValueOnce({
      id: 'tok-1',
      name: 'GPT Token',
      accountId: 'chatgpt-acct-1',
      accessToken: 'enc-token',
      refreshToken: 'enc-refresh',
      isActive: 'true',
      status: 'active'
    })
    openaiAccountService.isTokenExpired.mockReturnValueOnce(false)
    openaiAccountService.decrypt.mockReturnValueOnce('decrypted-token')
    openaiTokenImageRelayService.handleGenerations.mockResolvedValueOnce({ ok: true })

    const req = createReq({ body: { prompt: 'draw a corgi' } })
    const res = createRes()

    await openaiRoutes.handleImageGenerations(req, res)

    expect(openaiTokenImageRelayService.handleGenerations).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({ id: 'tok-1' }),
      req.apiKey,
      'decrypted-token'
    )
    expect(openaiImageRelayService.handleGenerations).not.toHaveBeenCalled()
  })

  test('routes multipart image edits without parsing the request body', async () => {
    const req = createReq({
      path: '/v1/images/edits',
      originalUrl: '/openai/v1/images/edits',
      headers: { 'content-type': 'multipart/form-data; boundary=abc123' },
      body: undefined
    })
    const res = createRes()

    await openaiRoutes.handleImageEdits(req, res)

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      null,
      'gpt-image-2',
      expect.objectContaining({
        endpointKind: 'images',
        hasImageGeneration: true,
        imageOperation: 'edits',
        imageModel: 'gpt-image-2',
        openaiResponsesOnly: true
      })
    )
    expect(openaiImageRelayService.handleEdits).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({ id: 'resp-1' }),
      req.apiKey
    )
  })

  test('rejects JSON image edits before scheduling an account', async () => {
    const req = createReq({
      path: '/v1/images/edits',
      originalUrl: '/openai/v1/images/edits',
      headers: { 'content-type': 'application/json' },
      body: { model: 'gpt-image-2' }
    })
    const res = createRes()

    await openaiRoutes.handleImageEdits(req, res)

    expect(res.status).toHaveBeenCalledWith(415)
    expect(res.payload.error.code).toBe('unsupported_media_type')
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
    expect(openaiImageRelayService.handleEdits).not.toHaveBeenCalled()
  })
})

describe('openai models route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('registers /v1/models and returns configured model list', async () => {
    const configuredModels = [
      { id: 'gpt-5.4', object: 'model', created: 1710000000, owned_by: 'openai' },
      {
        id: 'claude-sonnet-4-5-20250929',
        object: 'model',
        created: 1710000000,
        owned_by: 'anthropic'
      }
    ]
    modelService.getAllModels.mockResolvedValue(configuredModels)
    const req = createReq({
      method: 'GET',
      path: '/v1/models',
      originalUrl: '/openai/v1/models'
    })
    const res = createRes()

    await openaiRoutes.handleModels(req, res)

    expect(registeredGetRoutes).toContainEqual({
      path: '/v1/models',
      handler: openaiRoutes.handleModels
    })
    expect(modelService.getAllModels).toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({
      object: 'list',
      data: configuredModels
    })
  })

  test('filters restricted models as a blacklist', async () => {
    modelService.getAllModels.mockResolvedValue([
      { id: 'gpt-5.4', object: 'model', created: 1710000000, owned_by: 'openai' },
      { id: 'gpt-5.4-pro', object: 'model', created: 1710000000, owned_by: 'openai' }
    ])
    const req = createReq({
      method: 'GET',
      path: '/v1/models',
      originalUrl: '/openai/v1/models',
      apiKey: {
        id: 'key-1',
        permissions: ['openai'],
        enableModelRestriction: true,
        restrictedModels: ['gpt-5.4-pro']
      }
    })
    const res = createRes()

    await openaiRoutes.handleModels(req, res)

    expect(res.json).toHaveBeenCalledWith({
      object: 'list',
      data: [{ id: 'gpt-5.4', object: 'model', created: 1710000000, owned_by: 'openai' }]
    })
  })
})
