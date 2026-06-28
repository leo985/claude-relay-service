const CodexToOpenAIConverter = require('../src/services/codexToOpenAI')

function parseSSEPayload(chunk) {
  const line = chunk.split('\n').find((item) => item.startsWith('data: '))
  return JSON.parse(line.slice(6))
}

describe('CodexToOpenAIConverter error sanitization', () => {
  test('masks response.failed details in non-stream conversion', () => {
    const converter = new CodexToOpenAIConverter()

    const result = converter.convertResponse({
      id: 'resp_1',
      status: 'failed',
      error: {
        message: 'secret upstream diagnostic with account token',
        type: 'authentication_error',
        code: 'invalid_api_key'
      }
    })

    expect(JSON.stringify(result)).not.toContain('secret upstream diagnostic')
    expect(result).toEqual({
      error: {
        message: 'Upstream authentication failed',
        type: 'authentication_error',
        code: 'upstream_auth_error'
      }
    })
  })

  test('masks top-level embedded errors in non-stream conversion', () => {
    const converter = new CodexToOpenAIConverter()

    const result = converter.convertResponse({
      error: {
        message: 'internal upstream billing detail',
        type: 'billing_error',
        code: 'insufficient_quota',
        status: 402
      }
    })

    expect(JSON.stringify(result)).not.toContain('internal upstream billing detail')
    expect(result.error).toEqual({
      message: 'Upstream payment required',
      type: 'billing_error',
      code: 'upstream_payment_required'
    })
  })

  test('masks response.failed details in stream conversion', () => {
    const converter = new CodexToOpenAIConverter()
    const chunks = converter.convertStreamChunk(
      {
        type: 'response.failed',
        response: {
          status: 'failed',
          error: {
            message: 'raw provider stack trace',
            type: 'invalid_request_error',
            code: 'bad_payload'
          }
        }
      },
      'gpt-5.4',
      converter.createStreamState()
    )

    const payload = parseSSEPayload(chunks[0])
    expect(JSON.stringify(payload)).not.toContain('raw provider stack trace')
    expect(payload.error).toEqual({
      message: 'Upstream rejected the request',
      type: 'invalid_request_error',
      code: 'upstream_bad_request'
    })
  })

  test('keeps only safe reset metadata for embedded 429 errors', () => {
    const converter = new CodexToOpenAIConverter()
    const chunks = converter.convertStreamChunk(
      {
        error: {
          message: 'organization quota secret detail',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
          resets_in_seconds: 42
        }
      },
      'gpt-5.4',
      converter.createStreamState()
    )

    const payload = parseSSEPayload(chunks[0])
    expect(JSON.stringify(payload)).not.toContain('organization quota secret')
    expect(payload.error).toEqual({
      message: 'Upstream rate limit exceeded',
      type: 'rate_limit_error',
      code: 'upstream_rate_limited',
      resets_in_seconds: 42
    })
  })
})

describe('CodexToOpenAIConverter reasoning forwarding', () => {
  test('forwards reasoning_summary_text.delta as reasoning_content', () => {
    const converter = new CodexToOpenAIConverter()
    const chunks = converter.convertStreamChunk(
      { type: 'response.reasoning_summary_text.delta', delta: 'summary thought' },
      'gpt-5.4',
      converter.createStreamState()
    )

    const payload = parseSSEPayload(chunks[0])
    expect(payload.choices[0].delta.reasoning_content).toBe('summary thought')
  })

  test('forwards raw reasoning_text.delta as reasoning_content', () => {
    const converter = new CodexToOpenAIConverter()
    const chunks = converter.convertStreamChunk(
      { type: 'response.reasoning_text.delta', delta: 'raw chain of thought' },
      'gpt-5.4',
      converter.createStreamState()
    )

    expect(chunks.length).toBeGreaterThan(0)
    const payload = parseSSEPayload(chunks[0])
    expect(payload.choices[0].delta.reasoning_content).toBe('raw chain of thought')
  })

  test('treats reasoning_text.done as a signal only and emits no content', () => {
    const converter = new CodexToOpenAIConverter()
    const chunks = converter.convertStreamChunk(
      { type: 'response.reasoning_text.done', text: 'raw chain of thought' },
      'gpt-5.4',
      converter.createStreamState()
    )

    expect(chunks).toEqual([])
  })
})
