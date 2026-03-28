# 05 汉字切分插件

这是一个用于Coze平台的汉字切分插件，专门用于书法评分中的汉字图像提取。

## 功能

- 从A4白纸扫描图像中提取10x7的方格
- 自动检测网格线位置，而不是简单整图均分
- 会先检测并裁出整页中的网格区域，适应大留白和拍照偏移
- 返回70个保留方格内空白的汉字图像矩阵，便于后续评分
- 返回每个格子的页内坐标与内容框元数据
- 支持输出为base64字符串或Buffer

## 使用方法

### 1. 安装依赖

```bash
npm install
npm test
```

### 2. 在Coze系统中使用

通过CLI调用书法评分工作流，并提供图像路径：

```bash
node /home/lc/luckee_dao/baby/coze/cli.js run --message "书法评分 image:/path/to/your/a4_image.png"
```

### 3. 直接使用插件

```javascript
const hanziPlugin = require('./插件');

const result = await hanziPlugin.execute({
  imagePath: '/path/to/image.png',
  returnBase64: true,  // 返回base64字符串
  outputDir: './output', // 可选：保存切分结果
  trimContent: false,
  cropToGrid: true
});

console.log(result.matrix); // 7x10的汉字图像矩阵
console.log(result.cells[0]); // 第一个方格的页内坐标和内容框
```

## API

### execute(params)

- `params.imagePath` (string, required): 输入图像路径
- `params.returnBase64` (boolean, optional): 是否返回base64，默认true
- `params.outputDir` (string, optional): 输出目录，用于保存切分结果
- `params.gridRows` (number, optional): 方格行数，默认7
- `params.gridCols` (number, optional): 方格列数，默认10
- `params.trimContent` (boolean, optional): 是否继续裁到汉字内容区域，默认false
- `params.cropToGrid` (boolean, optional): 是否先裁出整页中的网格区域，默认true

返回：
```javascript
{
  gridRows: 7,
  gridCols: 10,
  totalCells: 70,
  gridBounds: { left, top, width, height },
  cells: [
    {
      row: 0,
      col: 0,
      pageBox: { left, top, width, height },
      contentBox: { left, top, width, height }
    }
  ],
  matrix: Array[7][10] // 每个元素为base64字符串或Buffer
}
```

说明：

- 直接调用 `05_切分插件` 时，默认按 `7x10` 处理
- 若需要根据纸张实际结构自动修正网格规格，请通过 `00_流水线插件` 调用

## 依赖

- sharp: 图像处理库

## 注意事项

- 输入图像应为A4纸扫描件，包含10x7的方格布局
- 图像分辨率建议至少300 DPI
- 方格应清晰可见，背景为白色
- 默认会保留方格内空白，供评分插件使用文字相对方格的位置关系
- 当前版本更适合扫描件或轻微倾斜拍照，尚未实现透视矫正
