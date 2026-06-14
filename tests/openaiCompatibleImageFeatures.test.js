const {
  accountSupportsRequestFeatures,
  detectEndpointKindFromPath,
  endpointSupportsKind,
  getOpenAIImageModelRank,
  getRequestFeaturesFromBody,
  getRequestFeaturesForImages
} = require('../src/utils/openaiCompatible')

describe('openaiCompatible image features', () => {
  test('detects Images API endpoints without adding providerEndpoint=images', () => {
    expect(detectEndpointKindFromPath('/v1/images/generations')).toBe('images')
    expect(detectEndpointKindFromPath('/images/edits')).toBe('images')
    expect(endpointSupportsKind('responses', 'images')).toBe(true)
    expect(endpointSupportsKind('passthrough', 'images')).toBe(true)
    expect(endpointSupportsKind('chat_completions', 'images')).toBe(false)
  })

  test('detects Responses image_generation tool as image generation capability', () => {
    const features = getRequestFeaturesFromBody(
      {
        model: 'gpt-5.5',
        input: 'draw a city',
        tools: [{ type: 'image_generation' }]
      },
      'responses'
    )

    expect(features.hasTools).toBe(true)
    expect(features.hasImageGeneration).toBe(true)
    expect(
      accountSupportsRequestFeatures(
        { providerEndpoint: 'responses', supportsTools: true, supportsImageGeneration: false },
        features
      )
    ).toEqual({ ok: false, reason: 'image_generation_not_supported' })
  })

  test('builds explicit features for Images API requests', () => {
    expect(
      getRequestFeaturesForImages({ model: 'gpt-image-2' }, { operation: 'edits' })
    ).toMatchObject({
      endpointKind: 'images',
      hasImageGeneration: true,
      imageOperation: 'edits',
      imageModel: 'gpt-image-2',
      openaiResponsesOnly: true
    })
  })

  test('ranks image models separately from text boundModel', () => {
    expect(
      getOpenAIImageModelRank(
        { boundModel: 'gpt-5.5', imageBoundModel: 'gpt-image-2', imageModelAliases: [] },
        'gpt-image-2'
      )
    ).toBe(3)
    expect(
      getOpenAIImageModelRank(
        { boundModel: 'gpt-5.5', imageBoundModel: '', imageModelAliases: ['draw'] },
        'draw'
      )
    ).toBe(2)
  })
})
