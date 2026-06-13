const {
  normalizeApiStatsModelDisplayMode,
  sanitizeModelStatsForDisplay
} = require('../src/utils/apiStatsModelDisplay')

describe('apiStatsModelDisplay', () => {
  test('normalizes invalid display modes to raw', () => {
    expect(normalizeApiStatsModelDisplayMode('masked')).toBe('masked')
    expect(normalizeApiStatsModelDisplayMode(' HIDDEN ')).toBe('hidden')
    expect(normalizeApiStatsModelDisplayMode('invalid')).toBe('raw')
    expect(normalizeApiStatsModelDisplayMode()).toBe('raw')
  })

  test('keeps raw model names by default', () => {
    const [stat] = sanitizeModelStatsForDisplay([{ model: 'gpt-4.1', requests: 2 }], 'raw')

    expect(stat).toEqual({
      model: 'gpt-4.1',
      requests: 2,
      modelDisplayMode: 'raw',
      modelNameHidden: false
    })
  })

  test('masks model names without mutating other statistics', () => {
    const stats = sanitizeModelStatsForDisplay(
      [
        { model: 'deepseek-chat', service: 'codex', requests: 3, allTokens: 10 },
        { model: 'claude-sonnet-4', service: 'claude', requests: 1, allTokens: 5 }
      ],
      'masked'
    )

    expect(stats).toEqual([
      {
        model: 'Model #1',
        service: 'codex',
        requests: 3,
        allTokens: 10,
        modelDisplayMode: 'masked',
        modelNameHidden: true
      },
      {
        model: 'Model #2',
        service: 'claude',
        requests: 1,
        allTokens: 5,
        modelDisplayMode: 'masked',
        modelNameHidden: true
      }
    ])
  })

  test('hides every model name in hidden mode', () => {
    const stats = sanitizeModelStatsForDisplay([{ model: 'secret-upstream-model' }], 'hidden')

    expect(stats[0]).toEqual({
      model: 'Hidden model',
      modelDisplayMode: 'hidden',
      modelNameHidden: true
    })
  })
})
