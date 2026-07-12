const PREFIXED_ACCOUNT_TYPES = {
  claude: {
    'console:': 'claude-console',
    'ccr:': 'ccr'
  },
  gemini: {
    'api:': 'gemini-api'
  },
  openai: {
    'responses:': 'openai-responses'
  },
  droid: {}
}

const DEFAULT_ACCOUNT_TYPES = {
  claude: 'claude-official',
  gemini: 'gemini',
  openai: 'openai',
  droid: null
}

const normalizePreferredAccountRef = (value, platform) => {
  if (!value || typeof value !== 'string') {
    return null
  }

  const raw = value.trim()
  if (!raw || raw.startsWith('group:')) {
    return null
  }

  const prefixes = PREFIXED_ACCOUNT_TYPES[platform] || {}
  for (const [prefix, accountType] of Object.entries(prefixes)) {
    if (raw.startsWith(prefix)) {
      const accountId = raw.slice(prefix.length)
      return accountId ? { raw, accountId, accountType } : null
    }
  }

  return {
    raw,
    accountId: raw,
    accountType: DEFAULT_ACCOUNT_TYPES[platform] || null
  }
}

const getAccountComparableId = (account) => account?.accountId || account?.id || null

const isPreferredAccountMatch = (account, preferredRef) => {
  if (!account || !preferredRef) {
    return false
  }

  if (getAccountComparableId(account) !== preferredRef.accountId) {
    return false
  }

  if (!preferredRef.accountType) {
    return true
  }

  const accountType = account.accountType || account.platform || null
  return !accountType || accountType === preferredRef.accountType
}

const pickPreferredAccount = (accounts, preferredValue, platform) => {
  const preferredRef = normalizePreferredAccountRef(preferredValue, platform)
  if (!preferredRef || !Array.isArray(accounts)) {
    return null
  }

  return accounts.find((account) => isPreferredAccountMatch(account, preferredRef)) || null
}

module.exports = {
  normalizePreferredAccountRef,
  isPreferredAccountMatch,
  pickPreferredAccount
}
