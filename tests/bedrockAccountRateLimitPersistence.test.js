jest.useFakeTimers()

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn()
}))
jest.mock('../src/services/relay/bedrockRelayService', () => ({}))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  clearTempUnavailable: jest.fn().mockResolvedValue(undefined),
  recordErrorHistory: jest.fn().mockResolvedValue(undefined)
}))
jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn().mockResolvedValue(undefined)
}))

const redis = require('../src/models/redis')
const bedrockAccountService = require('../src/services/account/bedrockAccountService')

describe('Bedrock account rate-limit persistence', () => {
  let client
  let storedAccount

  beforeEach(() => {
    storedAccount = {
      id: 'bedrock-1',
      name: 'Bedrock 1',
      credentialType: 'access_key',
      awsCredentials: {
        encrypted: 'encrypted-credentials',
        iv: '00112233445566778899aabbccddeeff'
      },
      disableAutoProtection: false,
      rateLimitDuration: '60',
      schedulable: true,
      isActive: true
    }
    client = {
      get: jest.fn().mockImplementation(() => Promise.resolve(JSON.stringify(storedAccount))),
      set: jest.fn().mockResolvedValue('OK')
    }
    redis.getClientSafe.mockReturnValue(client)
  })

  afterAll(() => {
    jest.useRealTimers()
  })

  it('marks an account without replacing encrypted AWS credentials', async () => {
    await bedrockAccountService.markAccountRateLimited('bedrock-1', 5)

    const persisted = JSON.parse(client.set.mock.calls[0][1])
    expect(persisted.awsCredentials).toEqual(storedAccount.awsCredentials)
    expect(persisted).toEqual(
      expect.objectContaining({
        status: 'rateLimited',
        rateLimitStatus: 'limited',
        schedulable: false,
        rateLimitDuration: '5'
      })
    )
  })

  it('resets status without replacing encrypted AWS credentials', async () => {
    storedAccount = {
      ...storedAccount,
      status: 'rateLimited',
      rateLimitStatus: 'limited',
      rateLimitedAt: '2026-01-01T00:00:00.000Z',
      rateLimitResetAt: '2026-01-01T01:00:00.000Z',
      schedulable: false,
      isActive: false
    }

    await bedrockAccountService.resetAccountStatus('bedrock-1')

    const persisted = JSON.parse(client.set.mock.calls[0][1])
    expect(persisted.awsCredentials).toEqual(storedAccount.awsCredentials)
    expect(persisted.status).toBe('active')
    expect(persisted.schedulable).toBe(true)
    expect(persisted.isActive).toBe(true)
    expect(persisted).not.toHaveProperty('rateLimitStatus')
    expect(persisted).not.toHaveProperty('rateLimitedAt')
    expect(persisted).not.toHaveProperty('rateLimitResetAt')
  })
})
