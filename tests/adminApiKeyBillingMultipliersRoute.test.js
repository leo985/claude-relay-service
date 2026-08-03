const mockRouter = {
  get: jest.fn(),
  put: jest.fn()
}

jest.mock('express', () => ({ Router: () => mockRouter }))
jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: jest.fn((_req, _res, next) => next())
}))
jest.mock('../src/services/apiKeyBillingMultiplierService', () => ({
  getConfig: jest.fn(),
  setMultiplier: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn() }))

const service = require('../src/services/apiKeyBillingMultiplierService')
require('../src/routes/admin/apiKeyBillingMultipliers')

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn((statusCode) => {
      res.statusCode = statusCode
      return res
    }),
    json: jest.fn((body) => {
      res.body = body
      return res
    })
  }
  return res
}

function getHandler(method, path) {
  const route = mockRouter[method].mock.calls.find((call) => call[0] === path)
  return route?.[2]
}

describe('admin API key billing multiplier routes', () => {
  beforeEach(() => {
    service.getConfig.mockReset()
    service.setMultiplier.mockReset()
  })

  test('returns the current API key multiplier', async () => {
    service.getConfig.mockResolvedValue({
      keyId: 'key-1',
      multiplier: 2,
      isCustom: true
    })
    const res = createResponse()

    await getHandler('get', '/api-keys/:keyId/billing-multiplier')(
      { params: { keyId: 'key-1' } },
      res
    )

    expect(service.getConfig).toHaveBeenCalledWith('key-1')
    expect(res.body).toEqual({
      success: true,
      data: expect.objectContaining({ multiplier: 2, isCustom: true })
    })
  })

  test('updates the multiplier and maps validation errors to 400', async () => {
    service.setMultiplier.mockRejectedValue(
      Object.assign(new Error('invalid multiplier'), { code: 'INVALID_BILLING_MULTIPLIER' })
    )
    const res = createResponse()

    await getHandler('put', '/api-keys/:keyId/billing-multiplier')(
      { params: { keyId: 'key-1' }, body: { multiplier: 0 } },
      res
    )

    expect(service.setMultiplier).toHaveBeenCalledWith('key-1', 0)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body).toEqual({ success: false, error: 'invalid multiplier' })
  })
})
