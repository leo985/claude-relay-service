const crypto = require('crypto')

function normalizeSessionIdentity(value) {
  const candidate = Array.isArray(value) ? value[0] : value
  if (typeof candidate !== 'string') {
    return null
  }

  const normalized = candidate.trim()
  return normalized || null
}

function extractSessionIdentity(req = {}) {
  const headers = req.headers || {}
  const body = req.body || {}
  const candidates = [
    req._relaySessionId,
    headers['x-session-id'],
    headers.session_id,
    body.session_id,
    body.conversation_id,
    body.client_metadata?.session_id,
    body.client_metadata?.thread_id,
    body.prompt_cache_key,
    body.metadata?.session_id
  ]

  for (const candidate of candidates) {
    const identity = normalizeSessionIdentity(candidate)
    if (identity) {
      return identity
    }
  }

  return null
}

function captureSessionIdentity(req = {}) {
  req._relaySessionId = extractSessionIdentity(req)
  return req._relaySessionId
}

function buildSessionHash(apiKeyId, sessionIdentity) {
  const normalizedApiKeyId = normalizeSessionIdentity(apiKeyId)
  const normalizedSessionIdentity = normalizeSessionIdentity(sessionIdentity)
  if (!normalizedApiKeyId || !normalizedSessionIdentity) {
    return null
  }

  return crypto
    .createHash('sha256')
    .update(`${normalizedApiKeyId}:${normalizedSessionIdentity}`)
    .digest('hex')
}

module.exports = {
  buildSessionHash,
  captureSessionIdentity,
  extractSessionIdentity
}
