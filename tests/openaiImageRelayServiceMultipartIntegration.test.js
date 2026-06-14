/**
 * End-to-end integration test for openaiImageRelayService.handleEdits.
 *
 * Spins up two real HTTP servers:
 *   1. relayServer (Express app) — calls handleEdits with real Express req/res,
 *      exactly like production.
 *   2. upstreamServer (raw Node http.Server) — captures the multipart bytes
 *      the relay pipes through axios.
 *
 * The test driver uses http.request to send a real multipart POST to the
 * relay server, exercising the real socket + axios stream pipe path.
 *
 * Does NOT mock axios or headerFilter.
 */
const http = require('http')
const express = require('express')
const { URL } = require('url')

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 10000
  }),
  { virtual: true }
)

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  updateAccountUsage: jest.fn(),
  updateUsageQuota: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordImageUsage: jest.fn().mockResolvedValue({ realCost: 0, ratedCost: 0 })
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  markAccountRateLimited: jest.fn(),
  _deleteSessionMapping: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(),
  parseRetryAfter: jest.fn(() => null),
  sanitizeErrorForClient: jest.fn((e) => e)
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => ({ requestId: 'integration-1' }))
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

const openaiImageRelayService = require('../src/services/relay/openaiImageRelayService')
const accountService = require('../src/services/account/openaiResponsesAccountService')

let relayApp
let relayServer
let relayPort
let upstreamServer
let upstreamPort
let upstreamCapture
let upstreamHandler

beforeAll((done) => {
  upstreamServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      upstreamCapture = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks)
      }
      if (upstreamHandler) {
        upstreamHandler(req, res, upstreamCapture)
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          model: 'gpt-image-2',
          data: [{ b64_json: 'BASE64DATA' }],
          usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 }
        })
      )
    })
  })

  relayApp = express()
  relayApp.post('/openai/v1/images/edits', (req, res) => {
    openaiImageRelayService.handleEdits(
      req,
      res,
      { id: 'acct-1', name: 'image-account' },
      { id: 'key-1' }
    )
  })

  upstreamServer.listen(0, '127.0.0.1', () => {
    upstreamPort = upstreamServer.address().port
    relayServer = relayApp.listen(0, '127.0.0.1', () => {
      relayPort = relayServer.address().port
      done()
    })
  })
})

afterAll((done) => {
  relayServer.close(() => upstreamServer.close(done))
})

beforeEach(() => {
  jest.clearAllMocks()
  upstreamCapture = null
  upstreamHandler = null
  accountService.getAccount.mockResolvedValue({
    id: 'acct-1',
    name: 'image-account',
    apiKey: 'sk-upstream',
    baseApi: `http://127.0.0.1:${upstreamPort}`,
    imageBoundModel: '',
    customHeaders: {},
    userAgent: '',
    dailyQuota: '0'
  })
  accountService.updateAccount.mockResolvedValue()
  accountService.updateAccountUsage.mockResolvedValue()
  accountService.updateUsageQuota.mockResolvedValue()
})

function postMultipartToRelay({ boundary, fields, file }) {
  return new Promise((resolve, reject) => {
    const parts = []
    for (const [name, value] of Object.entries(fields)) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        )
      )
    }
    if (file) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
        )
      )
      parts.push(file.content)
      parts.push(Buffer.from('\r\n'))
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`))
    const body = Buffer.concat(parts)

    const relayUrl = new URL(`http://127.0.0.1:${relayPort}/openai/v1/images/edits`)
    const clientReq = http.request(
      {
        method: 'POST',
        host: relayUrl.hostname,
        port: relayUrl.port,
        path: relayUrl.pathname,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length)
        }
      },
      (clientRes) => {
        const chunks = []
        clientRes.on('data', (c) => chunks.push(c))
        clientRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let payload = null
          try {
            payload = JSON.parse(raw)
          } catch {
            payload = raw
          }
          resolve({ status: clientRes.statusCode, payload, sentBody: body })
        })
      }
    )
    clientReq.on('error', reject)
    clientReq.write(body)
    clientReq.end()
  })
}

describe('openaiImageRelayService.handleEdits end-to-end streaming (real sockets + Express)', () => {
  test('pipes multipart body byte-for-byte to upstream via real axios', async () => {
    const boundary = '----TestBoundary1234'
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe])

    const { status, payload, sentBody } = await postMultipartToRelay({
      boundary,
      fields: { model: 'gpt-image-2', prompt: 'Make it sunset' },
      file: { name: 'image', filename: 'input.png', contentType: 'image/png', content: pngBytes }
    })

    expect(status).toBe(200)
    expect(payload).toEqual(
      expect.objectContaining({
        model: 'gpt-image-2',
        data: [{ b64_json: 'BASE64DATA' }]
      })
    )

    expect(upstreamCapture).not.toBeNull()
    expect(upstreamCapture.method).toBe('POST')
    expect(upstreamCapture.url).toBe('/v1/images/edits')
    expect(upstreamCapture.headers['content-type']).toBe(
      `multipart/form-data; boundary=${boundary}`
    )
    expect(upstreamCapture.headers['authorization']).toBe('Bearer sk-upstream')
    expect(upstreamCapture.headers['content-length']).toBeUndefined()
    // Client's original Host header is stripped by filterForOpenAI; axios then
    // sets its own Host for the upstream (HTTP/1.1 requires it). Verify it
    // points at the upstream, not the relay.
    expect(upstreamCapture.headers['host']).toBe(`127.0.0.1:${upstreamPort}`)
    // The critical C1 assertion: byte-for-byte body equality after going through
    // express.json middleware + axios `data: req` stream pipe.
    expect(upstreamCapture.body.equals(sentBody)).toBe(true)
  })

  test('binary content with all 256 byte values survives unchanged', async () => {
    const boundary = '----BinBoundary5678'
    const binBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))

    const { status, sentBody } = await postMultipartToRelay({
      boundary,
      fields: { prompt: 'invert colors' },
      file: {
        name: 'image',
        filename: 'all-bytes.bin',
        contentType: 'application/octet-stream',
        content: binBytes
      }
    })

    expect(status).toBe(200)
    expect(upstreamCapture.body.equals(sentBody)).toBe(true)
  })

  test('relays upstream 4xx error body to client', async () => {
    upstreamHandler = (_req, res) => {
      res.statusCode = 422
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: { message: 'bad image', type: 'invalid_image' } }))
    }

    const { status, payload } = await postMultipartToRelay({
      boundary: '----ErrBoundary9999',
      fields: { prompt: 'x' }
    })

    expect(status).toBe(422)
    expect(payload).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ message: 'bad image' }) })
    )
  })
})
