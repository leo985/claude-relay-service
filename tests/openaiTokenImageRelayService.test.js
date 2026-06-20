const { extractImageUsage, usageSummaryForRateLimits } = require('../src/utils/openaiImageUsage')

// ---- mock 依赖 ----
// relay 以 axios({...}) 形式调用，故把 axios mock 成可调用函数
jest.mock('axios', () => jest.fn())

const mockRecordUsage = jest.fn()
const mockUpdateAccountUsage = jest.fn()
const mockUpdateAccount = jest.fn()
const mockUpdateRateLimitCounters = jest.fn()
const mockMarkTempUnavailable = jest.fn()
const mockSanitize = jest.fn((data) => data)

jest.mock('../src/services/apiKeyService', () => ({
  recordUsage: mockRecordUsage.mockResolvedValue({ realCost: 0.01, ratedCost: 0.01 })
}))
jest.mock('../src/services/account/openaiAccountService', () => ({
  updateAccountUsage: mockUpdateAccountUsage,
  updateAccount: mockUpdateAccount
}))
jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  markAccountRateLimited: jest.fn().mockResolvedValue(undefined)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: mockMarkTempUnavailable.mockResolvedValue(undefined),
  parseRetryAfter: jest.fn(() => null),
  sanitizeErrorForClient: mockSanitize
}))
jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => null),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))
jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: mockUpdateRateLimitCounters
}))
jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

const axios = require('axios')
const relay = require('../src/services/relay/openaiTokenImageRelayService')

// 构造一条可读的 SSE 流，模拟 codex/responses 的 response.completed 事件
function createSseStream(events) {
  const { Readable } = require('stream')
  const payload = events
    .map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`)
    .join('')
  const stream = new Readable({ read() {} })
  process.nextTick(() => {
    stream.push(payload)
    stream.push(null)
  })
  return stream
}

function createReq(overrides = {}) {
  const handlers = {}
  return Object.assign(
    {
      method: 'POST',
      body: { prompt: 'a corgi' },
      apiKey: { id: 'key-1', name: 'k' },
      headers: {},
      once: jest.fn((evt, cb) => {
        handlers[evt] = cb
      }),
      removeListener: jest.fn()
    },
    overrides
  )
}

function createRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    status: jest.fn(function (code) {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.payload = payload
      return res
    }),
    end: jest.fn(() => res),
    once: jest.fn(),
    removeListener: jest.fn(),
    writableEnded: false
  }
  return res
}

const account = {
  id: 'tok-1',
  name: 'GPT Token',
  accountId: 'chatgpt-acct-1',
  proxy: null,
  disableAutoProtection: 'false'
}

describe('OpenAITokenImageRelayService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('parses SSE stream and returns standard {data:[{b64_json}]} + records usage as openai', async () => {
    const completed = {
      type: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          model: 'gpt-5.4',
          usage: { input_tokens: 12, output_tokens: 1024 },
          output: [{ type: 'image_generation', b64_json: 'BASE64DATA' }]
        }
      }
    }
    axios.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: createSseStream([completed])
    })

    const req = createReq()
    const res = createRes()

    await relay.handleGenerations(req, res, account, req.apiKey, 'decrypted-token')

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      created: expect.any(Number),
      data: [{ b64_json: 'BASE64DATA' }]
    })
    // accountType 必须是 'openai'，模型 gpt-5.4
    expect(mockRecordUsage).toHaveBeenCalledWith(
      'key-1',
      12,
      1024,
      0,
      0,
      'gpt-5.4',
      'tok-1',
      'openai',
      null,
      null
    )
    expect(mockUpdateAccountUsage).toHaveBeenCalledWith('tok-1', expect.any(Number))
  })

  test('rejects n>1 with 400 (MVP supports only n=1)', async () => {
    const req = createReq({ body: { prompt: 'a corgi', n: 3 } })
    const res = createRes()

    await relay.handleGenerations(req, res, account, req.apiKey, 'decrypted-token')

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalled()
    expect(res.payload.error.code).toBe('unsupported_n')
    expect(axios).not.toHaveBeenCalled()
  })

  test('rejects stream=true with the standard image streaming error', async () => {
    const req = createReq({ body: { prompt: 'a corgi', stream: true } })
    const res = createRes()

    await relay.handleGenerations(req, res, account, req.apiKey, 'decrypted-token')

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.payload.error.code).toBe('image_stream_not_supported')
    expect(axios).not.toHaveBeenCalled()
  })

  test('rejects missing prompt with 400', async () => {
    const req = createReq({ body: {} })
    const res = createRes()

    await relay.handleGenerations(req, res, account, req.apiKey, 'decrypted-token')

    expect(res.status).toHaveBeenCalledWith(400)
    expect(axios).not.toHaveBeenCalled()
  })

  test('returns 502 when stream completes without an image item', async () => {
    const completed = {
      type: 'response.completed',
      data: {
        type: 'response.completed',
        response: { model: 'gpt-5.4', usage: { input_tokens: 5, output_tokens: 0 }, output: [] }
      }
    }
    axios.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: createSseStream([completed])
    })

    const req = createReq()
    const res = createRes()

    await relay.handleGenerations(req, res, account, req.apiKey, 'decrypted-token')

    expect(res.status).toHaveBeenCalledWith(502)
    expect(res.payload.error.code).toBe('no_image_returned')
  })

  test('maps size/quality onto the image_generation tool and forces model gpt-5.4', async () => {
    const completed = {
      type: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          model: 'gpt-5.4',
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [{ type: 'image_generation', b64_json: 'X' }]
        }
      }
    }
    axios.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: createSseStream([completed])
    })

    const req = createReq({ body: { prompt: 'a corgi', size: '1024x1024', quality: 'high' } })
    const res = createRes()

    await relay.handleGenerations(req, res, account, req.apiKey, 'decrypted-token')

    const sentBody = axios.mock.calls[0][0].data
    expect(sentBody.model).toBe('gpt-5.4')
    expect(sentBody.stream).toBe(true)
    expect(sentBody.instructions).toBeTruthy()
    expect(Array.isArray(sentBody.input)).toBe(true)
    expect(sentBody.tools[0]).toMatchObject({
      type: 'image_generation',
      size: '1024x1024',
      quality: 'high'
    })
  })

  test('marks account temp-unavailable on 429 and forwards sanitized error', async () => {
    const { Readable } = require('stream')
    const errStream = new Readable({ read() {} })
    process.nextTick(() => {
      errStream.push(JSON.stringify({ error: { message: 'rate limited' } }))
      errStream.push(null)
    })
    axios.mockResolvedValueOnce({ status: 429, headers: {}, data: errStream })

    const req = createReq()
    const res = createRes()

    await relay.handleGenerations(req, res, account, req.apiKey, 'decrypted-token')

    expect(res.status).toHaveBeenCalledWith(429)
    expect(mockMarkTempUnavailable).toHaveBeenCalledWith('tok-1', 'openai', 429, null)
  })
})

describe('openaiImageUsage shared util', () => {
  test('extractImageUsage parses image token details', () => {
    const usage = extractImageUsage({
      input_tokens: 100,
      output_tokens: 50,
      input_tokens_details: { text_tokens: 100 },
      output_tokens_details: { image_tokens: 50 }
    })
    expect(usage.inputTextTokens).toBe(100)
    expect(usage.outputImageTokens).toBe(50)
    expect(usage.kind).toBe('image')
  })

  test('usageSummaryForRateLimits sums tokens', () => {
    const summary = usageSummaryForRateLimits({
      inputTextTokens: 100,
      inputImageTokens: 0,
      outputImageTokens: 50,
      cacheReadTextTokens: 10,
      cacheReadImageTokens: 0
    })
    expect(summary.totalTokens).toBe(160)
    expect(summary.cacheReadTokens).toBe(10)
  })
})
