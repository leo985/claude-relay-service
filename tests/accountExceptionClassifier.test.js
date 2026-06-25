const {
  classifyCurrentAccountStatus,
  classifyErrorEvent,
  normalizeAccountType
} = require('../src/utils/accountExceptionClassifier')

describe('accountExceptionClassifier', () => {
  test.each([
    [{ statusCode: 401 }, 'auth_error'],
    [{ statusCode: 403 }, 'auth_error'],
    [{ statusCode: 429 }, 'rate_limit'],
    [{ statusCode: 503 }, 'service_unavailable'],
    [{ statusCode: 529 }, 'overload'],
    [{ statusCode: 504 }, 'timeout'],
    [{ statusCode: 500 }, 'server_error'],
    [{ statusCode: 502 }, 'server_error'],
    [{ errorType: 'token_refresh_failed' }, 'auth_error'],
    [{ errorType: 'quota_exceeded' }, 'quota_exceeded'],
    [{ errorType: 'unknown_provider_error' }, 'unknown_error']
  ])('classifies error event %j as %s', (event, category) => {
    expect(classifyErrorEvent(event)).toBe(category)
  })

  test('normalizes platform names to error-history account types', () => {
    expect(normalizeAccountType('claude')).toBe('claude-official')
    expect(normalizeAccountType('claude-console')).toBe('claude-console')
    expect(normalizeAccountType('ccr')).toBe('ccr')
    expect(normalizeAccountType('azure_openai')).toBe('azure-openai')
  })

  test('returns blocked current status with primary reason priority', () => {
    const status = classifyCurrentAccountStatus({
      status: 'quota_exceeded',
      isActive: false
    })

    expect(status).toMatchObject({
      isBlocked: true,
      primaryCategory: 'quota_exceeded',
      label: '配额不足'
    })
    expect(status.reasons).toEqual(expect.arrayContaining(['账号配额不足或已触发配额停调']))
  })

  test('uses temp-unavailable error type for current primary category', () => {
    const status = classifyCurrentAccountStatus({
      tempUnavailable: {
        statusCode: 429,
        errorType: 'rate_limit',
        expiresAt: '2026-06-23T12:00:00.000Z'
      }
    })

    expect(status).toMatchObject({
      isBlocked: true,
      primaryCategory: 'rate_limit',
      label: '限流中',
      recoverAt: '2026-06-23T12:00:00.000Z'
    })
  })
})
