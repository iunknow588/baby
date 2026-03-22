class CellFinalScorePlugin {
  constructor() {
    this.name = '07_5_单格总评分';
    this.version = '1.0.0';
    this.processNo = '07_5';
  }

  execute(params) {
    const { features, structure, similarity, config } = params || {};
    if (!features || !config) {
      throw new Error('features 和 config 参数是必需的');
    }
    const {
      calculateLayoutScore,
      calculateSizeScore,
      calculateStabilityScore,
      buildPenalties,
      levelFromScore,
      roundScore
    } = require('../07_评分插件/scoring');

    const layout = calculateLayoutScore(features, config);
    const size = calculateSizeScore(features, config);
    const stability = calculateStabilityScore(features, config);
    const total = similarity
      ? roundScore(
          config.weights.with_target.layout * layout +
          config.weights.with_target.size * size +
          config.weights.with_target.stability * stability +
          config.weights.with_target.structure * (structure ? structure.score : 0) +
          config.weights.with_target.similarity * similarity.score
        )
      : roundScore(
          config.weights.rule_only.layout * layout +
          config.weights.rule_only.size * size +
          config.weights.rule_only.stability * stability
        );

    return {
      processNo: this.processNo,
      processName: '07_5_单格总评分',
      total,
      scoreLevel: levelFromScore(total),
      subScores: {
        layout,
        size,
        stability,
        structure: structure ? structure.score : null,
        similarity: similarity ? similarity.score : null
      },
      penalties: buildPenalties(features, config, structure)
    };
  }
}

module.exports = new CellFinalScorePlugin();
