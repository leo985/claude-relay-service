const fs = require('fs')
const path = require('path')

describe('gpt-image-2 pricing config', () => {
  test('uses image-token fields consumed by CostCalculator', () => {
    const pricingPath = path.join(
      process.cwd(),
      'resources',
      'model-pricing',
      'model_prices_and_context_window.json'
    )
    const pricingData = JSON.parse(fs.readFileSync(pricingPath, 'utf8'))

    expect(pricingData['gpt-image-2']).toEqual(
      expect.objectContaining({
        litellm_provider: 'openai',
        mode: 'image_generation',
        input_cost_per_token: 0.000005,
        input_cost_per_image_token: 0.000008,
        output_cost_per_image_token: 0.00003,
        cache_read_input_token_cost: 0.00000125,
        cache_read_input_image_token_cost: 0.000002
      })
    )
  })
})
