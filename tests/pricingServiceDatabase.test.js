jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
  database: jest.fn(),
  security: jest.fn()
}))

const mockStore = new Map()

const mockClient = {
  get: jest.fn(async (key) => mockStore.get(key) || null),
  exists: jest.fn(async (key) => (mockStore.has(key) ? 1 : 0)),
  pipeline: jest.fn(() => {
    const ops = []
    return {
      set(key, value) {
        ops.push([key, value])
        return this
      },
      async exec() {
        for (const [key, value] of ops) {
          mockStore.set(key, value)
        }
        return ops.map(() => [null, 'OK'])
      }
    }
  })
}

jest.mock('../src/models/redis', () => ({
  client: mockClient
}))

describe('PricingService database storage', () => {
  let pricingService

  beforeEach(() => {
    jest.resetModules()
    mockStore.clear()
    pricingService = require('../src/services/pricingService')
  })

  afterEach(() => {
    pricingService.cleanup()
    jest.clearAllMocks()
  })

  test('loads pricing data from Redis instead of model_pricing.json', async () => {
    mockStore.set(
      'system:model_pricing:data',
      JSON.stringify({
        'test-model': {
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002
        }
      })
    )
    mockStore.set(
      'system:model_pricing:meta',
      JSON.stringify({
        updatedAt: '2026-06-27T00:00:00.000Z',
        updatedBy: 'admin',
        source: 'manual',
        hash: 'abc',
        modelCount: 1
      })
    )

    await pricingService.loadPricingData()

    expect(pricingService.getModelPricing('test-model')).toEqual({
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002
    })
    expect(pricingService.getStatus()).toMatchObject({
      initialized: true,
      modelCount: 1,
      source: 'manual',
      updatedBy: 'admin'
    })
  })

  test('upserts one model price and persists the full pricing map to Redis', async () => {
    await pricingService.savePricingDataToDatabase(
      {
        existing: {
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000004
        }
      },
      { source: 'remote', updatedBy: 'system', hash: 'remote-hash' }
    )

    const saved = await pricingService.upsertModelPricing(
      'custom-model',
      {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000006,
        cache_read_input_token_cost: 0.0000005,
        litellm_provider: 'custom'
      },
      'tester'
    )

    expect(saved).toMatchObject({
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.000006,
      cache_read_input_token_cost: 0.0000005,
      litellm_provider: 'custom'
    })

    const persisted = JSON.parse(mockStore.get('system:model_pricing:data'))
    expect(Object.keys(persisted).sort()).toEqual(['custom-model', 'existing'])
    expect(JSON.parse(mockStore.get('system:model_pricing:meta'))).toMatchObject({
      source: 'manual',
      updatedBy: 'tester',
      modelCount: 2
    })
  })
})
