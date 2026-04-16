# Teen Patti Solver for Node.js

一个适合二开和嵌入其他项目的炸金花/Teen Patti 求解器。

当前这个工作副本已经补充了：

- `4张选3张` 最佳策略接口
- `5张选3张` 最佳策略接口
- 返回结构化结果，方便其他项目直接调用
- 最小可玩的中文 `CMD` 版本
- 可直接双击启动的便携版 UI
- 模板优先、内置兜底的识牌能力

## 便携版运行

如果你要把程序发到另一台 Windows 电脑上，优先使用便携版目录。

当前项目已经支持“开发机打包、目标机直接双击运行”的过渡方案：

- 内置 `runtime/node/node.exe`
- 内置 `node_modules`
- 不要求目标机额外安装 `Node.js`
- 主入口可以直接双击 `启动屏幕识牌助手.vbs`

### 开发机打包

在当前项目目录执行任意一种：

```bash
npm run build:portable
```

或者直接双击：

- `teenpatti-solver-work/构建便携版.cmd`

打包结果默认输出到：

- `teenpatti-solver-work/dist/炸金花助手便携版`

### 目标机启动

把整个 `teenpatti-solver-work/dist/炸金花助手便携版` 文件夹拷过去，然后双击：

- `teenpatti-solver-work/dist/炸金花助手便携版/启动屏幕识牌助手.vbs`

如果你想运行命令行版本，也可以用：

- `teenpatti-solver-work/dist/炸金花助手便携版/启动CMD游戏.cmd`

### 便携版说明

- 这是“过渡版本”，重点是目标机不装环境也能运行
- 当前 UI 仍然是 `PowerShell + WinForms`
- 无模板时也可以直接使用内置识别兜底
- 后面如果你继续产品化，可以再把 UI 迁到真正的桌面 `exe`

## 快速开始

```bash
npm install
```

在当前项目里直接调用：

```javascript
const solver = require("./index");

const strategy = solver.getBestStrategyForFourCards(["As", "Kd", "Qc", "Jh"]);
console.log(strategy);
```

在其他 Node.js 项目里调用：

```javascript
const path = require("path");
const solver = require(path.resolve("D:/A1/CodeProjects/ZhaJinHuaJHJ/teenpatti-solver-work"));

const strategy = solver.getBestStrategyForFourCards(["As", "Kd", "Qc", "Jh"]);
console.log(strategy);
```

## 推荐接口

如果你的目标是：

- 让其他项目直接拿到 `4选3` 的最佳结果
- 知道应该保留哪 3 张、丢弃哪 1 张
- 同时拿到牌型中文名、英文名、分数和原始下标

推荐优先用下面这组接口：

- `getBestStrategyForFourCards(cards, options)`
- `getBestStrategyForFiveCards(cards, options)`
- `getBestStrategyForCards(cards, options)`

这组接口是给“外部项目接入”准备的，返回值更稳定，也更适合业务代码直接使用。

## 屏幕识牌模块（模板优先 + 内置兜底）

如果你的 AI 不是直接拿到牌面数据，而是只能“看屏幕”，现在也可以直接调用截图识牌模块。

这个模块的目标是：

- 从游戏截图中识别 4 张手牌
- 判断每张牌的点数和花色
- 输出标准牌面编码，例如 `As`、`Td`、`9h`、`Qc`
- 识别完成后，直接接入 `4选3` 最优策略接口

### 识牌模块适合的场景

- AI 通过截图感知游戏画面
- UI 没有直接暴露手牌数据
- 牌位置固定、牌角样式固定、界面缩放基本固定

### 识牌原理

当前实现不是依赖外部安装环境的 OCR，而是两层识别：

- `模板识别`：你自己放模板图，准确率通常更高
- `内置识别`：程序自带轻量字模，不放模板也能先跑起来

默认使用：

- `recognitionMode: "auto"`
- 有模板时优先走模板识别
- 没模板时自动切到内置识别

流程是：

- 先从整张截图里裁出 4 张牌的位置
- 再从每张牌里裁出左上角的 `点数区域` 和 `花色区域`
- 对裁出的图块做灰度化、缩放、阈值二值化
- 模板模式下，再和模板图片逐像素比较，选出最接近的结果
- 内置模式下，再和程序内置的小型字模特征做比对

这套方式在“同一个游戏 UI、同一套缩放、同一套牌面皮肤”下，模板识别通常更稳；内置识别更适合先落地、先开箱即用。

### `recognitionMode` 说明

- `auto`：默认；有模板用模板，没有模板用内置
- `template`：强制模板识别；缺模板时直接报错
- `builtin`：强制内置识别

### 相关文件

- 识牌模块：`teenpatti-solver-work/screen-recognition/index.js`
- 示例配置：`teenpatti-solver-work/screen-recognition/config.sample.json`
- 模板说明：`teenpatti-solver-work/screen-recognition/templates/README.md`

### 模板目录

把模板图片放到下面两个目录：

- `teenpatti-solver-work/screen-recognition/templates/ranks`
- `teenpatti-solver-work/screen-recognition/templates/suits`

点数模板建议命名：

- `A.png`
- `K.png`
- `Q.png`
- `J.png`
- `T.png`
- `9.png` 到 `2.png`

花色模板建议命名：

- `s.png`：黑桃
- `h.png`：红桃
- `d.png`：方块
- `c.png`：梅花

### 配置示例

复制并修改这个文件：

- `teenpatti-solver-work/screen-recognition/config.sample.json`

其中：

- `recognitionMode: "auto"` 表示模板优先、无模板自动兜底

你主要需要调整：

- `cardRegions`：4 张牌在整张截图里的位置
- `rankRegion`：每张牌左上角点数区域的位置
- `suitRegion`：每张牌左上角花色区域的位置
- `preprocess.rank / preprocess.suit`：二值化和缩放参数

### 直接识别截图中的 4 张牌

```javascript
const path = require("path");
const solver = require(path.resolve("D:/A1/CodeProjects/ZhaJinHuaJHJ/teenpatti-solver-work"));

async function main() {
  const result = await solver.recognizeFourCardsFromImage(
    {
      ...require("./screen-recognition/config.sample.json"),
      recognitionMode: "auto"
    },
    "./sample-screenshot.png"
  );

  console.log(result.cardCodes);
  console.log(result.cards);
}

main().catch(console.error);
```

返回结果大致如下：

```javascript
{
  screenshotPath: 'D:/.../sample-screenshot.png',
  cardCodes: [ 'As', 'Kd', 'Qc', 'Jh' ],
  cards: [
    {
      cardIndex: 0,
      cardIndexHuman: 1,
      code: 'As',
      rank: 'A',
      suit: 's',
      confidence: 0.96,
      rankMatch: { ... },
      suitMatch: { ... }
    }
  ],
  recognizedAt: '2026-04-16T...'
}
```

### 识别后直接求 4选3 最佳策略

如果你想一步拿到“识别结果 + 4选3 最优解”，可以直接调用：

```javascript
const path = require("path");
const solver = require(path.resolve("D:/A1/CodeProjects/ZhaJinHuaJHJ/teenpatti-solver-work"));

async function main() {
  const result = await solver.recognizeAndSolveFourCardsFromImage(
    {
      ...require("./screen-recognition/config.sample.json"),
      recognitionMode: "auto"
    },
    "./sample-screenshot.png",
    { indexBase: 1 }
  );

  console.log(result.recognized.cardCodes);
  console.log(result.strategy.bestCards);
  console.log(result.strategy.discardCards);
  console.log(result.strategy.hand.nameZh, result.strategy.hand.score);
}

main().catch(console.error);
```

### 直接截主屏并识别

如果你不想先手动保存截图，也可以让模块直接抓取主屏幕：

```javascript
const path = require("path");
const solver = require(path.resolve("D:/A1/CodeProjects/ZhaJinHuaJHJ/teenpatti-solver-work"));

async function main() {
  const result = await solver.recognizeFourCardsFromScreen(
    {
      ...require("./screen-recognition/config.sample.json"),
      recognitionMode: "auto"
    },
    { outputPath: "./latest-screen.png" }
  );

  console.log(result.cardCodes);
}

main().catch(console.error);
```

### 直接强制使用内置识别

```javascript
const path = require("path");
const solver = require(path.resolve("D:/A1/CodeProjects/ZhaJinHuaJHJ/teenpatti-solver-work"));

async function main() {
  const result = await solver.recognizeAndSolveHandRegionFromScreen(
    { x: 820, y: 900, width: 420, height: 130 },
    {
      cardCount: 4,
      recognitionMode: "builtin",
      outputPath: "./latest-screen.png",
      indexBase: 1
    }
  );

  console.log(result.recognized.recognitionMode);
  console.log(result.recognized.cardCodes);
  console.log(result.strategy.bestCards);
}

main().catch(console.error);
```

### 对外接口列表

- `createScreenCardRecognizer(config)`：创建可复用识牌器，适合高频调用
- `capturePrimaryScreen(outputPath)`：抓取主屏截图到文件
- `recognizeCardsFromImage(config, screenshotPath)`：识别任意数量配置好的牌位
- `recognizeFourCardsFromImage(config, screenshotPath)`：识别 4 张手牌
- `recognizeCardsFromScreen(config, options)`：先抓主屏，再识牌
- `recognizeFourCardsFromScreen(config, options)`：先抓主屏，再识别 4 张手牌
- `recognizeAndSolveFourCardsFromImage(config, screenshotPath, options)`：识牌后直接算 4选3 最优解
- `recognizeAndSolveFourCardsFromScreen(config, options)`：截屏、识牌、算 4选3 最优解一条龙

## 极简屏幕识牌 UI

为了方便你直接在游戏时使用，我还加了一个 Windows 下的极简小界面。

特点：

- 默认出现在屏幕左下角
- 比最初版本多留了一些空间，方便测试时看日志
- 依然尽量不挡住游戏画面
- 可以切换 `4张选3张` / `5张选3张`
- 有按钮可以直接框选手牌整体区域
- 可以单独设置“出牌按钮”的点击坐标
- 可以勾选“自动出牌”，识别后自动点击最佳 3 张，再点击出牌按钮
- 框选完成后，可以一键识别当前屏幕
- 内置 `录入模板` 按钮，能把当前这手真实牌面直接写进模板目录
- 可以通过顶部的 `连续挂机` 切换控件进入连续多局模式
- 连续模式下会持续重新识别当前局牌面，牌面不变时不会重复点击
- 缺少前置条件时会直接弹窗提示，而不是静默失败
- 识别后会显示详细日志，方便你判断：
  - 数字识别对不对
  - 花色识别对不对
  - 候选模板是不是合理
  - `4选3` / `5选3` 选出来的策略是不是最优
  - 当前是走 `模板` 还是 `内置` 识别
  - 是否触发了重复牌自动纠偏
  - 当前框选区域预览图保存在哪里

### 启动方式

直接双击：

- `teenpatti-solver-work/启动屏幕识牌助手.vbs`

或者手动运行：

- `teenpatti-solver-work/屏幕识牌助手.ps1`
- `teenpatti-solver-work/screen-card-helper.ps1`

或者在终端里运行：

```bash
npm run screen-ui
```

### 使用步骤

1. 先准备好模板图片
   - 如果你已经有模板，就放到 `screen-recognition/templates/ranks` 和 `screen-recognition/templates/suits`
   - 如果还没有模板，也可以直接先启动，用内置识别兜底
2. 双击启动 `启动屏幕识牌助手.vbs`
3. 在界面里先选择模式：`4张选3张` 或 `5张选3张`
4. 点击 `框选手牌区域`
5. 弹窗提示后，在 2 秒内切回游戏窗口
6. 在屏幕上拖动鼠标，框住“整排手牌区域”
   - 如果是 `4张选3张`，就框住 4 张牌整体
   - 如果是 `5张选3张`，就框住 5 张牌整体
7. 如果识别不准，先点一次 `识别`，再查看日志里的 `预览` 图片路径
8. 如果你知道当前实际牌面，可以点 `录入模板`，输入例如 `As Qh Jd 3d`
9. 点击 `出牌点`，在屏幕上点一下“出牌/确认”按钮的位置
10. 如果要自动执行，勾选 `自动出牌`
11. 单次测试时，点击 `识别`
12. 连续多局时，打开顶部的 `连续挂机`
13. 小界面会显示：
   - 识别到的整组牌
   - 每张牌的数字、花色、综合置信度
   - 点数候选和花色候选
   - 建议保留的三张
   - 建议丢弃的牌
   - 组合排名日志
   - 当前最优牌型与分数
   - 最近几次挂机识别/出牌记录

### 适合怎样的框选方式

建议你框的是：

- 整排手牌横向排列的区域
- 尽量让每张牌的左上角点数和花色都在框里
- 不需要框得特别大，能覆盖所有手牌的可见部分即可

如果手牌之间有一定重叠也没关系，只要每张牌左上角还能看到，通常都能识别。

### 推荐排错顺序

如果你点了 `识别` 之后结果不对，建议按下面顺序排查：

1. 先看日志里的 `预览` 图片路径，确认框到的真的是牌区
2. 如果预览图就是手牌，但牌面识别还是不准，点 `录入模板`
3. 在输入框里填入当前真实牌面，例如 `As Qh Jd 3d`
4. 再点一次 `识别`

这一步会把当前牌面的真实数字和花色，直接裁成模板写入：

- `screen-recognition/templates/ranks`
- `screen-recognition/templates/suits`

同一标签支持多个模板变体，例如：

- `d.png`
- `d__1.png`
- `d__2.png`

这些都会被当成同一个花色标签 `d` 参与匹配，所以很适合慢慢积累你这款游戏自己的牌面模板。

### UI 相关文件

- 启动入口：`teenpatti-solver-work/启动屏幕识牌助手.vbs`
- 主界面：`teenpatti-solver-work/屏幕识牌助手.ps1`
- 英文文件名副本：`teenpatti-solver-work/screen-card-helper.ps1`
- UI 调用的桥接脚本：`teenpatti-solver-work/screen-recognition/ui-recognize.js`
- 模板录入脚本：`teenpatti-solver-work/screen-recognition/bootstrap-templates.js`

### UI 背后调用的高层接口

这个小界面最终调用的是：

- `buildCardRecognitionConfigFromHandRegion(handRegion, cardCount, options)`
- `recognizeAndSolveHandRegionFromScreen(handRegion, options)`
- `getStrategyDiagnosticsForCards(cards, options)`

自动出牌部分会根据最优策略，额外生成“点击计划”：

- 依次点击最佳 3 张牌的中心点
- 最后点击你设置好的“出牌点”

连续挂机模式还会额外做一层防重复逻辑：

- 如果当前牌面和上一轮已经处理过的牌面相同，就不会重复点击
- 只有检测到新牌面时，才会重新识别并重新出牌

所以如果你后面不想用这个小界面，也可以在别的项目里直接调用同一套逻辑。

### 注意事项

- 这套识别依赖固定 UI，适合同一款游戏、同一套分辨率和缩放
- 如果游戏窗口移动了、缩放变了、牌面皮肤变了，就要重新调配置或模板
- 如果识别不准，优先看 `latest-hand-region.png` 这类预览图，先确认是否真的框到了牌区
- 第二步再用 `录入模板` 从真实截图里积累模板
- 第三步再调 `rankRegion`、`suitRegion`、`threshold`、`contrast`、`invert`
- 模板一定要从真实截图裁出来，不要自己手工画

## 四选三最佳策略接口

### 接口名称

```javascript
solver.getBestStrategyForFourCards(cards, options)
```

### 参数

- `cards`：长度必须为 `4` 的数组
- `options.indexBase`：返回下标的起始值，可选
  - 默认是 `0`
  - 传 `{ indexBase: 1 }` 时，下标从 `1` 开始，更适合 UI 层直接展示

### 输入格式

牌面必须使用两位编码：

- `As`：黑桃 A
- `Td`：方块 10
- `9h`：红桃 9
- `Qc`：梅花 Q

大小写都可以，例如：

- `as`
- `TD`
- `qC`

接口内部会自动规范成标准格式。

### 调用示例

```javascript
const solver = require("./index");

const strategy = solver.getBestStrategyForFourCards(
  ["As", "Kd", "Qc", "Jh"],
  { indexBase: 1 }
);

console.log(strategy);
```

### 返回示例

```javascript
{
  mode: '4_choose_3',
  inputCards: [ 'As', 'Kd', 'Qc', 'Jh' ],
  bestCards: [ 'As', 'Kd', 'Qc' ],
  bestCardIndexes: [ 1, 2, 3 ],
  discardCards: [ 'Jh' ],
  discardIndexes: [ 4 ],
  hand: {
    name: 'Sequence',
    nameZh: '顺子',
    desc: 'Sequence of A High',
    descZh: '顺子 A 高',
    score: 3141312
  }
}
```

### 返回字段说明

- `mode`：当前模式，例如 `4_choose_3`
- `inputCards`：原始输入牌组
- `bestCards`：建议保留的最佳 3 张牌
- `bestCardIndexes`：最佳 3 张牌在原始数组中的位置
- `discardCards`：建议丢弃的牌
- `discardIndexes`：建议丢弃牌在原始数组中的位置
- `hand.name`：英文牌型名
- `hand.nameZh`：中文牌型名
- `hand.desc`：英文说明
- `hand.descZh`：中文说明
- `hand.score`：牌型分数，越大越强

### 最常见用法

只拿“应该保留哪 3 张”：

```javascript
const strategy = solver.getBestStrategyForFourCards(["As", "Kd", "Qc", "Jh"]);
console.log(strategy.bestCards);
```

只拿“应该丢掉哪一张”：

```javascript
const strategy = solver.getBestStrategyForFourCards(["As", "Kd", "Qc", "Jh"]);
console.log(strategy.discardCards[0]);
```

只拿“推荐保留的下标”：

```javascript
const strategy = solver.getBestStrategyForFourCards(
  ["As", "Kd", "Qc", "Jh"],
  { indexBase: 1 }
);

console.log(strategy.bestCardIndexes);
```

只拿“最终牌型和分数”：

```javascript
const strategy = solver.getBestStrategyForFourCards(["As", "Kd", "Qc", "Jh"]);

console.log(strategy.hand.nameZh);
console.log(strategy.hand.score);
```

## 五选三最佳策略接口

```javascript
const strategy = solver.getBestStrategyForFiveCards(["As", "Kd", "Qc", "Jh", "Tc"]);
console.log(strategy);
```

这个接口的返回结构与 `getBestStrategyForFourCards` 一致，只是输入牌数变成 `5` 张。

## 通用接口

如果你后面还要扩规则，建议直接接这个通用版本：

```javascript
const strategy = solver.getBestStrategyForCards(["As", "Kd", "Qc", "Jh", "Tc"]);
console.log(strategy);
```

适合后续扩展成：

- `4选3`
- `5选3`
- 更多张里选最佳 `3` 张

## 输入校验与异常处理

新接口会主动校验输入，并在输入不合法时直接抛出异常。

会校验的内容包括：

- 是否传入数组
- 牌数是否正确
- 是否存在重复牌
- 牌面编码是否合法

示例：

```javascript
try {
  const strategy = solver.getBestStrategyForFourCards(["As", "As", "Qc", "Jh"]);
  console.log(strategy);
} catch (error) {
  console.error(error.message);
}
```

## 兼容旧接口

如果你已经在用旧接口，它们仍然可以继续使用：

- `pickBestThreeFromFour(cards)`：返回最佳 3 张组合与剩余牌
- `pickBestThreeFromFive(cards)`：返回最佳 3 张组合与剩余牌
- `pickBestThree(cards)`：通用组合搜索
- `scoreHandsFour(cards)`：只返回 4 选 3 后的最优牌型结果
- `scoreHandsFive(cards)`：只返回 5 选 3 后的最优牌型结果

但是如果是“其他项目直接接入”，更建议用上面的 `getBestStrategyFor*` 系列接口。

## 命令行试玩

启动方式一：

```bash
npm run cmd
```

启动方式二：Windows 双击：

`启动CMD游戏.cmd`

进入后可以：

- 选择 `4张选3张` 或 `5张选3张`
- 选择电脑数量
- 自己选 3 张牌
- 或直接回车，让程序自动帮你选择最优解

## 牌型说明

当前使用的牌型顺序为：

- `豹子`
- `同花顺`
- `顺子`
- `同花`
- `对子`
- `散牌`

## 许可证

仓库 `package.json` 中声明许可证为 `ISC`。
