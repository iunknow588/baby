const path = require('path');
const hanziPlugin = require('../../插件');

function scoreByLength(message, min, max) {
  const len = String(message || '').length
  const score = Math.max(min, Math.min(max, Math.floor((len % 100) / 10) + min))
  return score
}

async function executeLocal(workflow, message) {
  if (workflow.route === 'calligraphy_scoring') {
    // 检查是否包含图像路径
    const imagePathMatch = message.match(/image:\s*(.+)/i);
    if (imagePathMatch) {
      const imagePath = imagePathMatch[1].trim();
      try {
        // 调用汉字切分插件
        const segmentationResult = await hanziPlugin.execute({
          imagePath: imagePath,
          returnBase64: true
        });

        return {
          answer: `已成功提取${segmentationResult.totalCells}个汉字方格，可用于后续评分。`,
          structuredData: {
            segmentation: segmentationResult,
            dimension: ['笔画', '结构', '章法']
          }
        };
      } catch (error) {
        return {
          answer: `汉字切分失败：${error.message}。请检查图像路径是否正确。`,
          structuredData: { error: error.message }
        };
      }
    } else {
      // 默认评分逻辑
      const score = scoreByLength(message, 70, 95)
      return {
        answer: `书法练习评分：${score}/100。建议先稳定笔画起收笔，再提升结构均衡度。`,
        structuredData: { score, dimension: ['笔画', '结构', '章法'] }
      }
    }
  }

  if (workflow.route === 'essay_scoring') {
    const score = scoreByLength(message, 68, 93)
    return {
      answer: `作文评分：${score}/100。建议加强开头立意与段落衔接，结尾增加观点回扣。`,
      structuredData: { score, dimension: ['立意', '结构', '表达'] }
    }
  }

  if (workflow.route === 'psych_support') {
    return {
      answer: '我理解你现在的压力。先做3次缓慢呼吸，然后把最困扰你的一件事拆成最小可执行步骤。',
      structuredData: { mode: 'supportive', riskLevel: 'low' }
    }
  }

  return {
    answer: '已完成本地流程处理。',
    structuredData: null
  }
}

module.exports = {
  executeLocal
}
