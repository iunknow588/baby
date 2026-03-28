const { aggregatePageScoring } = require('../07_评分插件/application/page_scoring_aggregation_service');

class PageScoringAggregatePlugin {
  constructor() {
    this.name = '07_0_页面评分汇总';
    this.version = '1.0.0';
  }

  async execute(params) {
    return aggregatePageScoring(params);
  }
}

module.exports = new PageScoringAggregatePlugin();
