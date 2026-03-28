const { scoreSegmentation } = require('./application/page_scoring_service');
const { renderAnnotatedPage } = require('./adapters/page_annotation');

class HanziScoringPlugin {
  constructor() {
    this.name = '07_单格评分';
    this.version = '1.0.0';
  }

  async execute(params) {
    const scoringResult = await scoreSegmentation(params);

    if (params.imagePath && (params.outputAnnotatedPath || params.outputSummaryPath)) {
      const annotationResult = await renderAnnotatedPage({
        imagePath: params.imagePath,
        scoringResult,
        outputImagePath: params.outputAnnotatedPath,
        outputSummaryPath: params.outputSummaryPath,
        options: params.options || {}
      });

      return {
        ...scoringResult,
        annotation: annotationResult
      };
    }

    return scoringResult;
  }
}

module.exports = new HanziScoringPlugin();
