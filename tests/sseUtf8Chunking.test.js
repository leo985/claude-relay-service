const { PassThrough } = require('stream')
const { IncrementalSSEParser } = require('../src/utils/sseParser')

describe('SSE UTF-8 chunk boundaries', () => {
  const frame = 'event: content_block_delta\ndata: {"text":"汉字🙂"}\n\n'
  const bytes = Buffer.from(frame)

  test('incremental parser preserves every character when bytes split at any offset', () => {
    for (let offset = 1; offset < bytes.length; offset++) {
      const parser = new IncrementalSSEParser()
      const events = [
        ...parser.feed(bytes.subarray(0, offset)),
        ...parser.feed(bytes.subarray(offset))
      ]
      expect(events).toEqual([
        { type: 'event', name: 'content_block_delta' },
        { type: 'data', data: { text: '汉字🙂' } }
      ])
    }
  })

  test('UTF-8 encoded stream forwards intact SSE text across byte boundaries', async () => {
    const offset = bytes.indexOf(Buffer.from('汉')) + 1
    const upstream = new PassThrough()
    upstream.setEncoding('utf8')
    let forwarded = ''
    upstream.on('data', (chunk) => {
      forwarded += chunk
    })
    const ended = new Promise((resolve) => upstream.on('end', resolve))
    upstream.write(bytes.subarray(0, offset))
    upstream.end(bytes.subarray(offset))
    await ended
    expect(forwarded).toBe(frame)
  })
})
