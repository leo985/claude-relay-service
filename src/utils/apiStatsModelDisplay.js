const VALID_API_STATS_MODEL_DISPLAY_MODES = ['raw', 'masked', 'hidden']

function normalizeApiStatsModelDisplayMode(value = 'raw', fallback = 'raw') {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const fallbackMode = VALID_API_STATS_MODEL_DISPLAY_MODES.includes(fallback) ? fallback : 'raw'
  return VALID_API_STATS_MODEL_DISPLAY_MODES.includes(mode) ? mode : fallbackMode
}

function isApiStatsModelNameHidden(mode) {
  return normalizeApiStatsModelDisplayMode(mode) !== 'raw'
}

function getMaskedModelName(mode, index) {
  const normalizedMode = normalizeApiStatsModelDisplayMode(mode)
  if (normalizedMode === 'masked') {
    return `Model #${index + 1}`
  }
  if (normalizedMode === 'hidden') {
    return 'Hidden model'
  }
  return null
}

function sanitizeModelStatsForDisplay(modelStats = [], mode = 'raw') {
  const normalizedMode = normalizeApiStatsModelDisplayMode(mode)

  return (Array.isArray(modelStats) ? modelStats : []).map((stat, index) => {
    const nextStat = { ...stat, modelDisplayMode: normalizedMode }

    if (normalizedMode === 'raw') {
      nextStat.model = stat?.model || 'unknown'
      nextStat.modelNameHidden = false
      return nextStat
    }

    nextStat.model = getMaskedModelName(normalizedMode, index)
    nextStat.modelNameHidden = true
    return nextStat
  })
}

module.exports = {
  VALID_API_STATS_MODEL_DISPLAY_MODES,
  normalizeApiStatsModelDisplayMode,
  isApiStatsModelNameHidden,
  sanitizeModelStatsForDisplay
}
