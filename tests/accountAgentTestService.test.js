jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  InvokeModelCommand: jest.fn()
}))
jest.mock('axios', () => ({
  post: jest.fn()
}))
jest.mock('../src/handlers/geminiHandlers', () => ({
  buildGeminiApiUrl: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))
jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  parseRetryAfter: jest.fn(),
  recordErrorHistory: jest.fn()
}))
jest.mock('../src/models/redis', () => ({
  incrementAccountUsage: jest.fn(),
  getClientSafe: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({ getAccount: jest.fn() }))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  getMappedModel: jest.fn((mapping, model) => {
    const match = Object.entries(mapping || {}).find(
      ([key]) => key.toLowerCase() === String(model).toLowerCase()
    )
    return match?.[1] || model
  }),
  markAccountRateLimited: jest.fn()
}))
jest.mock('../src/services/account/bedrockAccountService', () => ({
  getAccount: jest.fn(),
  markAccountRateLimited: jest.fn()
}))
jest.mock('../src/services/account/geminiAccountService', () => ({
  getAccount: jest.fn(),
  setAccountRateLimited: jest.fn()
}))
jest.mock('../src/services/account/geminiApiAccountService', () => ({
  getAccount: jest.fn(),
  setAccountRateLimited: jest.fn()
}))
jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  isTokenExpired: jest.fn(),
  refreshAccountToken: jest.fn(),
  decrypt: jest.fn((value) => value)
}))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))
jest.mock('../src/services/account/azureOpenaiAccountService', () => ({
  getAccount: jest.fn(),
  getDecryptedApiKey: jest.fn(),
  markAccountRateLimited: jest.fn()
}))
jest.mock('../src/services/account/droidAccountService', () => ({
  getAccount: jest.fn(),
  getDecryptedApiKeyEntries: jest.fn(),
  getValidAccessToken: jest.fn(),
  markAccountRateLimited: jest.fn()
}))
jest.mock('../src/services/account/ccrAccountService', () => ({
  getAccount: jest.fn(),
  getDecryptedCredentials: jest.fn(),
  markAccountRateLimited: jest.fn()
}))

jest.mock('../src/services/relay/claudeRelayService', () => ({
  testAccountConnectionSync: jest.fn()
}))
jest.mock('../src/services/relay/bedrockRelayService', () => ({
  _getBedrockClient: jest.fn()
}))
jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn()
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  markAccountRateLimited: jest.fn()
}))
jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  markAccountRateLimited: jest.fn()
}))
jest.mock('../src/services/modelService', () => ({
  getAllModels: jest.fn()
}))

const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const redis = require('../src/models/redis')
const axios = require('axios')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const azureOpenaiAccountService = require('../src/services/account/azureOpenaiAccountService')
const droidAccountService = require('../src/services/account/droidAccountService')
const ccrAccountService = require('../src/services/account/ccrAccountService')
const claudeRelayService = require('../src/services/relay/claudeRelayService')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const modelService = require('../src/services/modelService')
const accountAgentTestService = require('../src/services/accountAgentTestService')
const {
  getDefaultAgent,
  getSupportedAgents,
  normalizePlatform
} = require('../src/services/accountAgentTestService')

describe('accountAgentTestService', () => {
  const storedResults = {}
  let storedBatchResult = null
  const redisClient = {
    hset: jest.fn(async (_key, field, value) => {
      storedResults[field] = value
    }),
    hgetall: jest.fn(async () => ({ ...storedResults })),
    set: jest.fn(async (_key, value) => {
      storedBatchResult = value
    }),
    get: jest.fn(async () => storedBatchResult)
  }

  beforeEach(() => {
    jest.clearAllMocks()
    Object.keys(storedResults).forEach((key) => delete storedResults[key])
    storedBatchResult = null
    redis.incrementAccountUsage.mockResolvedValue(undefined)
    redis.getClientSafe.mockReturnValue(redisClient)
    upstreamErrorHelper.parseRetryAfter.mockReturnValue(null)
    upstreamErrorHelper.recordErrorHistory.mockResolvedValue(undefined)
    unifiedOpenAIScheduler.markAccountRateLimited.mockResolvedValue({ success: true })
    modelService.getAllModels.mockResolvedValue([
      { id: 'claude-sonnet-4-5-20250929', owned_by: 'anthropic' },
      { id: 'gemini-2.5-flash', owned_by: 'google' },
      { id: 'gpt-5', owned_by: 'openai' }
    ])
    axios.post.mockResolvedValue({ status: 200, data: {}, headers: {} })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('exposes Codex and Claude Code for Anthropic passthrough accounts', () => {
    expect(getSupportedAgents('openai-responses', { providerEndpoint: 'passthrough' })).toEqual([
      'codex',
      'claude-code'
    ])
    expect(getDefaultAgent('openai-responses', { providerEndpoint: 'passthrough' })).toBe(
      'claude-code'
    )
  })

  it('limits Responses-protocol accounts to Codex simulation', () => {
    expect(getSupportedAgents('openai-responses', { providerEndpoint: 'responses' })).toEqual([
      'codex'
    ])
    expect(normalizePlatform('azure_openai')).toBe('azure-openai')
  })

  it('allows Droid credentials to be tested through Droid, Codex, and Claude Code', () => {
    expect(getSupportedAgents('droid')).toEqual(['droid', 'codex', 'claude-code'])
  })

  it('uses the Azure endpoint and Responses payload when simulating Codex', async () => {
    azureOpenaiAccountService.getDecryptedApiKey.mockResolvedValue('azure-secret')

    await accountAgentTestService._testAzureOpenAI({
      account: {
        id: 'azure-1',
        azureEndpoint: 'https://example.openai.azure.com/',
        deploymentName: 'gpt-5-deployment',
        apiVersion: '2025-04-01-preview'
      },
      model: 'gpt-5',
      prompt: 'OK',
      maxTokens: 32
    })

    expect(axios.post).toHaveBeenCalledWith(
      'https://example.openai.azure.com/openai/responses?api-version=2025-04-01-preview',
      expect.objectContaining({
        model: 'gpt-5-deployment',
        instructions: expect.stringContaining('Codex'),
        max_output_tokens: 32,
        stream: false
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'api-key': 'azure-secret',
          'User-Agent': expect.stringContaining('codex_cli_rs')
        })
      })
    )
  })

  it('uses the configured CCR API URL instead of the Anthropic default', async () => {
    ccrAccountService.getDecryptedCredentials.mockResolvedValue({ apiKey: 'ccr-secret' })

    await accountAgentTestService._testCcr({
      account: { apiUrl: 'https://ccr.example/v1/messages' },
      accountId: 'ccr-1',
      model: 'claude-test',
      prompt: 'OK',
      maxTokens: 32
    })

    expect(axios.post).toHaveBeenCalledWith(
      'https://ccr.example/v1/messages',
      expect.objectContaining({ model: 'claude-test' }),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'ccr-secret' })
      })
    )
  })

  it('tests Droid API-key accounts through the Factory Responses endpoint for Codex', async () => {
    droidAccountService.getDecryptedApiKeyEntries.mockResolvedValue([
      { id: 'key-1', key: 'factory-secret', status: 'active' }
    ])

    await accountAgentTestService._testDroid({
      account: { authenticationMethod: 'api_key' },
      accountId: 'droid-1',
      agent: 'codex',
      model: 'gpt-5',
      prompt: 'OK',
      maxTokens: 32
    })

    expect(axios.post).toHaveBeenCalledWith(
      'https://api.factory.ai/api/llm/o/v1/responses',
      expect.objectContaining({ model: 'gpt-5', stream: false }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer factory-secret',
          'x-factory-client': 'cli',
          'x-api-provider': 'azure_openai'
        })
      })
    )
  })

  it('preserves the 429 status when the Claude sync tester reports it in the error text', async () => {
    claudeRelayService.testAccountConnectionSync.mockResolvedValue({
      success: false,
      error: 'Claude API error: 429'
    })
    claudeAccountService.getAccount.mockResolvedValue({ rateLimitStatus: 'limited' })

    await expect(
      accountAgentTestService._testClaude({ accountId: 'claude-1', model: 'claude-test' })
    ).resolves.toEqual(
      expect.objectContaining({
        statusCode: 429,
        rateLimitHandled: true
      })
    )
  })

  it('marks a protected account as rate limited after a 429 test response', async () => {
    const account = {
      id: 'responses-1',
      name: 'Responses 1',
      providerEndpoint: 'responses',
      boundModel: 'gpt-5',
      disableAutoProtection: 'false'
    }
    jest.spyOn(accountAgentTestService, '_loadAccount').mockResolvedValue(account)
    jest.spyOn(accountAgentTestService, '_runTest').mockResolvedValue({
      statusCode: 429,
      data: {
        error: {
          message: 'rate limited',
          resets_in_seconds: 120
        }
      }
    })

    const result = await accountAgentTestService.testAccount({
      platform: 'openai-responses',
      accountId: account.id,
      agent: 'codex'
    })

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        statusCode: 429,
        rateLimitedMarked: true
      })
    )
    expect(unifiedOpenAIScheduler.markAccountRateLimited).toHaveBeenCalledWith(
      account.id,
      'openai-responses',
      null,
      120
    )
  })

  it('reports why a 429 was not marked when auto protection is disabled', async () => {
    const account = {
      id: 'responses-2',
      name: 'Responses 2',
      providerEndpoint: 'responses',
      disableAutoProtection: 'true'
    }
    jest.spyOn(accountAgentTestService, '_loadAccount').mockResolvedValue(account)
    jest.spyOn(accountAgentTestService, '_runTest').mockResolvedValue({
      statusCode: 429,
      data: { error: { message: 'rate limited' } }
    })

    const result = await accountAgentTestService.testAccount({
      platform: 'openai-responses',
      accountId: account.id,
      agent: 'codex'
    })

    expect(result.rateLimitedMarked).toBe(false)
    expect(result.rateLimitMarkReason).toBe('auto_protection_disabled')
    expect(unifiedOpenAIScheduler.markAccountRateLimited).not.toHaveBeenCalled()
  })

  it('does not mark a second time when the relay already handled the 429', async () => {
    const account = {
      id: 'responses-3',
      name: 'Responses 3',
      providerEndpoint: 'responses',
      disableAutoProtection: 'false'
    }
    jest.spyOn(accountAgentTestService, '_loadAccount').mockResolvedValue(account)
    jest.spyOn(accountAgentTestService, '_runTest').mockResolvedValue({
      statusCode: 429,
      data: { error: { message: 'rate limited' } },
      rateLimitHandled: true
    })

    const result = await accountAgentTestService.testAccount({
      platform: 'openai-responses',
      accountId: account.id,
      agent: 'codex'
    })

    expect(result.rateLimitedMarked).toBe(true)
    expect(unifiedOpenAIScheduler.markAccountRateLimited).not.toHaveBeenCalled()
  })

  it('keeps the upstream 429 result when writing the limit state fails', async () => {
    const account = {
      id: 'responses-4',
      name: 'Responses 4',
      providerEndpoint: 'responses',
      disableAutoProtection: 'false'
    }
    jest.spyOn(accountAgentTestService, '_loadAccount').mockResolvedValue(account)
    jest.spyOn(accountAgentTestService, '_runTest').mockResolvedValue({
      statusCode: 429,
      data: { error: { message: 'rate limited' } }
    })
    unifiedOpenAIScheduler.markAccountRateLimited.mockRejectedValueOnce(
      new Error('Redis unavailable')
    )

    const result = await accountAgentTestService.testAccount({
      platform: 'openai-responses',
      accountId: account.id,
      agent: 'codex'
    })

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        statusCode: 429,
        rateLimitedMarked: false,
        rateLimitMarkReason: 'mark_failed'
      })
    )
  })

  it('returns account test models from the currently exposed model list', async () => {
    modelService.getAllModels.mockResolvedValue([
      { id: 'gpt-current', owned_by: 'openai' },
      { id: 'glm-current', owned_by: 'volc' },
      { id: 'claude-current', owned_by: 'anthropic' },
      { id: 'gemini-current', owned_by: 'google' }
    ])
    jest.spyOn(accountAgentTestService, '_loadAccount').mockResolvedValue({
      id: 'responses-5',
      name: 'Responses 5',
      providerEndpoint: 'responses'
    })

    const capabilities = await accountAgentTestService.getCapabilities(
      'openai-responses',
      'responses-5'
    )

    expect(capabilities.modelsByAgent.codex).toEqual([
      expect.objectContaining({ value: 'gpt-current' }),
      expect.objectContaining({ value: 'glm-current' })
    ])
    expect(capabilities.modelsByAgent.codex).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'claude-current' })])
    )
  })

  it('uses exposed Claude Console mapping keys as its test models', async () => {
    modelService.getAllModels.mockResolvedValue([
      { id: 'glm-5.1', owned_by: 'Bigmodel' },
      { id: 'gpt-5.5', owned_by: 'openai' }
    ])
    jest.spyOn(accountAgentTestService, '_loadAccount').mockResolvedValue({
      id: 'console-1',
      name: 'Console 1',
      supportedModels: {
        'GLM-5.1': 'astron-code-latest',
        'GLM-5.2': 'astron-code-latest'
      }
    })

    const capabilities = await accountAgentTestService.getCapabilities(
      'claude-console',
      'console-1'
    )

    expect(capabilities.modelsByAgent['claude-code']).toEqual([
      expect.objectContaining({ value: 'GLM-5.1' })
    ])
    expect(capabilities.defaultModelByAgent['claude-code']).toBe('GLM-5.1')
  })

  it('maps a Claude Console test model before sending it upstream', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { content: [{ text: 'OK' }] }, headers: {} })

    await accountAgentTestService._testClaudeConsole({
      account: {
        apiUrl: 'https://console.example/anthropic',
        apiKey: 'console-secret',
        supportedModels: { 'GLM-5.1': 'astron-code-latest' }
      },
      model: 'glm-5.1',
      prompt: 'OK',
      maxTokens: 32
    })

    expect(axios.post).toHaveBeenCalledWith(
      'https://console.example/anthropic/v1/messages',
      expect.objectContaining({ model: 'astron-code-latest' }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer console-secret' })
      })
    )
  })

  it('decrypts an OpenAI OAuth access token before testing the Codex endpoint', async () => {
    openaiAccountService.isTokenExpired.mockReturnValue(false)
    openaiAccountService.decrypt.mockReturnValue('decrypted-token')
    axios.post.mockResolvedValue({ status: 200, data: { output_text: 'OK' }, headers: {} })

    await accountAgentTestService._testOpenAI({
      account: {
        id: 'openai-1',
        accessToken: 'encrypted-token',
        accountId: 'chatgpt-account-1'
      },
      accountId: 'openai-1',
      model: 'gpt-5.5',
      prompt: 'OK',
      maxTokens: 32
    })

    expect(openaiAccountService.decrypt).toHaveBeenCalledWith('encrypted-token')
    expect(axios.post).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/responses',
      expect.not.objectContaining({ max_output_tokens: expect.anything() }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer decrypted-token',
          'chatgpt-account-id': 'chatgpt-account-1'
        })
      })
    )
    expect(axios.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ model: 'gpt-5.5', stream: true })
    )
  })

  it('batch tests every compatible agent for each account', async () => {
    const progressEvents = []
    jest
      .spyOn(accountAgentTestService, 'listAllTestableAccounts')
      .mockResolvedValue([
        { platform: 'openai-responses', accountId: 'responses-6', accountName: 'Responses 6' }
      ])
    jest.spyOn(accountAgentTestService, '_loadAccount').mockResolvedValue({
      id: 'responses-6',
      name: 'Responses 6',
      providerEndpoint: 'passthrough'
    })
    jest.spyOn(accountAgentTestService, '_runTest').mockResolvedValue({
      statusCode: 200,
      data: { output_text: 'OK' }
    })

    const result = await accountAgentTestService.testAccountsBatch({
      concurrency: 1,
      onProgress: (event) => progressEvents.push(event)
    })

    expect(result).toEqual(
      expect.objectContaining({
        accountCount: 1,
        testCount: 2,
        successCount: 2,
        failedCount: 0
      })
    )
    expect(result.results[0].tests.map((item) => item.agent).sort()).toEqual([
      'claude-code',
      'codex'
    ])
    expect(redis.incrementAccountUsage).toHaveBeenCalledTimes(2)
    expect(progressEvents[0]).toEqual(
      expect.objectContaining({ type: 'prepared', accountCount: 1, testCount: 2 })
    )
    expect(progressEvents.filter((event) => event.type === 'started')).toHaveLength(2)
    expect(progressEvents.filter((event) => event.type === 'completed')).toHaveLength(2)

    const latest = await accountAgentTestService.getLatestResults()
    expect(latest).toHaveLength(1)
    expect(latest[0]).toEqual(
      expect.objectContaining({
        platform: 'openai-responses',
        accountId: 'responses-6',
        tests: expect.arrayContaining([
          expect.objectContaining({ agent: 'codex', success: true }),
          expect.objectContaining({ agent: 'claude-code', success: true })
        ])
      })
    )
    expect(await accountAgentTestService.getLatestBatchResult()).toEqual(
      expect.objectContaining({
        accountCount: 1,
        testCount: 2,
        successCount: 2,
        failedCount: 0
      })
    )
  })

  it('skips manually stopped accounts even when explicitly included in a batch', async () => {
    jest.spyOn(accountAgentTestService, '_loadAccount').mockResolvedValue({
      id: 'responses-stopped',
      name: 'Stopped Responses',
      providerEndpoint: 'responses',
      schedulable: 'false'
    })
    const runTest = jest.spyOn(accountAgentTestService, '_runTest')

    const result = await accountAgentTestService.testAccountsBatch({
      accounts: [{ platform: 'openai-responses', accountId: 'responses-stopped' }]
    })

    expect(result).toEqual(
      expect.objectContaining({
        accountCount: 0,
        testCount: 0,
        results: []
      })
    )
    expect(runTest).not.toHaveBeenCalled()
  })

  it('runs a batch test as a queryable background job with real progress', async () => {
    jest
      .spyOn(accountAgentTestService, 'listAllTestableAccounts')
      .mockResolvedValue([
        { platform: 'openai-responses', accountId: 'responses-job', accountName: 'Job Account' }
      ])
    jest.spyOn(accountAgentTestService, '_loadAccount').mockResolvedValue({
      id: 'responses-job',
      name: 'Job Account',
      providerEndpoint: 'responses'
    })
    jest.spyOn(accountAgentTestService, '_runTest').mockResolvedValue({
      statusCode: 200,
      data: { output_text: 'OK' }
    })

    const started = accountAgentTestService.startBatchTestJob({ concurrency: 1 })
    expect(started).toEqual(
      expect.objectContaining({
        status: 'running',
        phase: 'discovering',
        progressPercent: 0
      })
    )

    let completed
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      completed = accountAgentTestService.getBatchTestJob(started.id)
      if (completed.status === 'completed') break
    }

    expect(completed).toEqual(
      expect.objectContaining({
        status: 'completed',
        accountCount: 1,
        testCount: 1,
        completedCount: 1,
        successCount: 1,
        progressPercent: 100
      })
    )
    expect(completed.results[0].tests[0]).toEqual(
      expect.objectContaining({ accountId: 'responses-job', success: true })
    )
  })
})
