const {
  createUsageRecordCostFields,
  resolveUsageRecordCosts,
  scaleCostBreakdown
} = require('../src/utils/usageRecordCost')

describe('usage record cost helpers', () => {
  test('stores real, rated, and hidden-multiplier costs without changing legacy cost semantics', () => {
    const fields = createUsageRecordCostFields({
      realCost: 1,
      ratedCost: 1.5,
      billableCost: 3.75,
      costBreakdown: { input: 0.4, output: 0.6, total: 1 }
    })

    expect(fields).toMatchObject({
      cost: 1.5,
      realCost: 1,
      ratedCost: 1.5,
      billableCost: 3.75,
      ratedCostBreakdown: { input: 0.6, output: 0.9, total: 1.5 },
      billableCostBreakdown: { input: 1.5, output: 2.25, total: 3.75 }
    })
  })

  test('uses the persisted billable amount and falls back to legacy cost when absent', () => {
    expect(
      resolveUsageRecordCosts({ realCost: 1, cost: 1.5, ratedCost: 1.5, billableCost: 3.75 })
    ).toEqual({ realCost: 1, ratedCost: 1.5, billableCost: 3.75 })
    expect(resolveUsageRecordCosts({ realCost: 1, cost: 1.5 })).toEqual({
      realCost: 1,
      ratedCost: 1.5,
      billableCost: 1.5
    })
  })

  test('keeps an exact target total when scaling a breakdown', () => {
    expect(scaleCostBreakdown({ input: 0.1, output: 0.2, total: 0.3 }, 0.3, 0.75)).toEqual({
      input: 0.25,
      output: 0.5,
      total: 0.75
    })
  })
})
