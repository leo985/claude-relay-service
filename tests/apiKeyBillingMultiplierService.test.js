jest.mock('../src/models/redis', () => ({}))

const { ApiKeyBillingMultiplierService } = require('../src/services/apiKeyBillingMultiplierService')

function createService(overrides = {}) {
  const client = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(1),
    ...overrides
  }
  const service = new ApiKeyBillingMultiplierService({
    redis: { getClientSafe: () => client }
  })
  return { client, service }
}

describe('ApiKeyBillingMultiplierService', () => {
  test('returns 1x by default and caches the key lookup', async () => {
    const { client, service } = createService()

    await expect(service.getMultiplier('key-1')).resolves.toBe(1)
    await expect(service.getMultiplier('key-1')).resolves.toBe(1)

    expect(client.get).toHaveBeenCalledTimes(1)
    expect(client.get).toHaveBeenCalledWith('api_key_billing_multiplier:key-1')
  })

  test('stores a custom multiplier and resets 1x by deleting only the override', async () => {
    const { client, service } = createService()

    await expect(service.setMultiplier('key-2', 2.5)).resolves.toMatchObject({
      keyId: 'key-2',
      multiplier: 2.5,
      isCustom: true
    })
    expect(client.exists).toHaveBeenCalledWith('apikey:key-2')
    expect(client.set).toHaveBeenCalledWith('api_key_billing_multiplier:key-2', '2.5')

    await service.setMultiplier('key-2', 1)
    expect(client.del).toHaveBeenCalledWith('api_key_billing_multiplier:key-2')
  })

  test('rejects invalid IDs and out-of-range multipliers', async () => {
    const { service } = createService()

    await expect(service.setMultiplier('', 2)).rejects.toMatchObject({
      code: 'INVALID_API_KEY_ID'
    })
    await expect(service.setMultiplier('key-3', 0)).rejects.toMatchObject({
      code: 'INVALID_BILLING_MULTIPLIER'
    })
  })

  test('rejects missing API keys before saving', async () => {
    const { service } = createService({ exists: jest.fn().mockResolvedValue(0) })

    await expect(service.setMultiplier('missing', 2)).rejects.toMatchObject({
      code: 'API_KEY_NOT_FOUND'
    })
  })
})
