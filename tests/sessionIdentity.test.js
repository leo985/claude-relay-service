const crypto = require('crypto')
const {
  buildSessionHash,
  captureSessionIdentity,
  extractSessionIdentity
} = require('../src/utils/sessionIdentity')

describe('sessionIdentity', () => {
  test.each([
    [{ headers: { 'x-session-id': 'x-session' } }, 'x-session'],
    [{ headers: { session_id: 'header-session' } }, 'header-session'],
    [{ body: { session_id: 'body-session' } }, 'body-session'],
    [{ body: { conversation_id: 'conversation' } }, 'conversation'],
    [{ body: { prompt_cache_key: 'cache-key' } }, 'cache-key'],
    [{ body: { metadata: { session_id: 'metadata-session' } } }, 'metadata-session']
  ])('extracts an explicit session identity from supported request fields', (req, expected) => {
    expect(extractSessionIdentity(req)).toBe(expected)
  })

  test('prefers a captured pre-conversion identity over the mutated request body', () => {
    const req = { headers: {}, body: { conversation_id: 'original-conversation' } }

    expect(captureSessionIdentity(req)).toBe('original-conversation')
    req.body = { prompt_cache_key: 'converted-cache-key' }

    expect(extractSessionIdentity(req)).toBe('original-conversation')
  })

  test('builds a stable API-key-namespaced hash', () => {
    const expected = crypto.createHash('sha256').update('key-a:conversation-a').digest('hex')

    expect(buildSessionHash('key-a', 'conversation-a')).toBe(expected)
    expect(buildSessionHash('key-a', 'conversation-a')).toBe(expected)
  })

  test('isolates conversations and API keys in sticky mappings', () => {
    const first = buildSessionHash('key-a', 'conversation-a')

    expect(buildSessionHash('key-a', 'conversation-b')).not.toBe(first)
    expect(buildSessionHash('key-b', 'conversation-a')).not.toBe(first)
  })

  test('does not create an unnamespaced sticky hash', () => {
    expect(buildSessionHash(null, 'conversation-a')).toBeNull()
    expect(buildSessionHash('key-a', null)).toBeNull()
  })

  test('does not infer session identity from shared prompts or the OpenAI user field', () => {
    expect(
      extractSessionIdentity({
        body: {
          user: 'shared-user',
          instructions: 'shared system prompt',
          messages: [{ role: 'user', content: 'first message' }]
        }
      })
    ).toBeNull()
  })
})
