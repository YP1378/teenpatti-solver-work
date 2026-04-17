# ZhaJinHuaJHJ / teenpatti-solver-work

## README 永久职责

本文件**长期只承担三件事**，后续维护必须坚持，不要再把 README 写回“大而全教程”。

1. **记录需求**：持续记录用户新增、变化、废弃的需求。任何功能、架构、策略都必须能追溯到需求；需求没记清，项目就会反复返工。
2. **提供完备入口**：给新加入工程师一个“最快定位代码”的入口，避免浪费大量时间在找文件、找函数、找调用链上。
3. **沉淀防踩坑要点**：记录已经踩过的坑、失败经验和约束规则。本项目不允许在同一类错误上重复消耗开发时间。

除以上三类内容外，README 不再堆放冗长演示、重复教程或一次性说明。

## 项目当前范围

这是一个炸金花/Teen Patti 辅助项目，包含两条主线：

- **策略求解**：从 4 张或 5 张牌中选择最优 3 张，并返回结构化策略结果。
- **屏幕识牌 + 桌面助手**：从截图或屏幕中识别手牌，给出策略，并可在桌面助手里执行自动出牌。

---

## 一、需求记录

本节只记录“现在项目必须满足什么”。新增需求时，**只追加，不覆盖历史**；废弃需求要显式标注。

### R-001 核心策略求解
- 支持 `4 选 3` 和 `5 选 3`。
- 返回值必须结构化，至少包含：输入牌、保留牌、丢弃牌、牌型、中文牌型、分数、下标。
- 内部统一使用牌码格式：`As`、`Qh`、`Td`、`2s`。

### R-002 屏幕识牌
- 支持从**图片**和**当前屏幕**识别手牌。
- 支持通过手牌整体区域自动切分单牌区域。
- 支持模板识别、内置识别，以及混合识别策略。

### R-003 识别策略升级
- 当前识别策略必须是**混合策略**，而不是单一路径。
- 已接入的有效证据源：
  - 原始 `rank/suit` 模板匹配
  - 归一化后的符号模板匹配
  - `auto` 模式下的内置字模候选
  - 可选的整牌模板匹配 `templates/cards`

### R-004 模板体系
- 模板目录至少包含：
  - `screen-recognition/templates/ranks`
  - `screen-recognition/templates/suits`
  - `screen-recognition/templates/cards`（可选但推荐）
- 模板录入脚本必须可同时保存点数模板、花色模板、整牌模板。

### R-005 桌面助手
- 提供 Windows 下的 PowerShell + WinForms 小工具。
- 至少支持：框选手牌区域、设置出牌点、单次识别、录入模板、自动采集素材、自动出牌、连续挂机。

### R-006 便携运行
- 项目支持打包为便携版本。
- 目标机器可通过内置 `runtime/node/node.exe` 直接运行，不强依赖外部 Node.js。

### R-007 用户可读显示
- 面向用户的日志和 UI，不应只显示内部牌码 `As/Qh/3d`。
- 用户可见输出应显示成：`A♠`、`K♥`、`10♦`、`Q♣`、`2♠` 这类格式。
- 中文牌型必须可读，不允许乱码。

### R-008 PowerShell 兼容性
- 必须兼容 `Windows PowerShell 5.1`。
- 不能直接依赖仅在较新 PowerShell 可用的参数或行为。

### R-009 文档治理
- README 只保留“需求记录 / 代码入口 / 防踩坑”三类内容。
- 与三类职责无关的旧内容可以删除，不再累积文档债务。

### R-010 识别后端升级
- 默认识别后端必须优先尝试 `OpenCV + 现有 JS 模板/内置` 的融合识别，而不是只跑单一路径。
- 当目标机器存在 Python + `cv2` 时，默认后端应为 `auto -> hybrid-opencv`。
- 当 Python/OpenCV 不可用时，必须自动回退到原有 JavaScript 识别链路，不能让桌面助手直接失效。

---

## 二、开发入口

本节回答一个问题：**“我要改某个功能，先去哪个文件？”**

### 0. 架构分层总览
- **第 1 层：规则与评分核心**
  - `cards.js`：牌码解析、点数/花色映射、整副牌枚举。
  - `index.js`：核心牌型评分、4/5 选 3 策略、结构化诊断结果。
  - `getWinner.js`：多手牌比较与胜负判断。
- **第 2 层：交互与编排入口**
  - `cmd-game.js`：命令行试玩入口，负责发牌、交互、展示最佳策略。
  - `app.js`：最小 API 示例，用来演示求解器的基本调用方式。
  - `screen-recognition/ui-recognize.js`：桌面助手与 Node 求解/识牌能力之间的桥接层。
- **第 3 层：屏幕识牌引擎**
  - `screen-recognition/index.js`：识牌主引擎，负责区域归一化、模板加载、候选融合、后端回退。
  - `screen-recognition/builtin-glyphs.js`：内置字模，作为无模板或低模板覆盖时的补充证据源。
  - `screen-recognition/opencv-recognize.py`：Python/OpenCV 增强后端，和 JS 识别链路并行融合。
- **第 4 层：素材与模板流转**
  - `screen-recognition/bootstrap-templates.js`：基于人工确认牌面快速录入模板。
  - `screen-recognition/capture-hand-region-sample.js`：按当前 UI 保存的区域自动二次截图。
  - `screen-recognition/auto-collect-material-sample.js`：自动连拍、择优、投票纠偏、自修直入库。
  - `screen-recognition/import-strip-templates.py`：把横向素材条拆成 `card/rank/suit` 三类素材并去重。
- **第 5 层：Windows 助手与打包分发**
  - `screen-card-helper.ps1` / `屏幕识牌助手.ps1`：WinForms 桌面助手、自动点击、挂机控制。
  - `启动屏幕识牌助手.vbs`：隐藏 PowerShell 窗口的双击启动器。
  - `tools/build-portable.ps1` + `runtime/` + `dist/`：便携版打包与运行时分发。

### 0.1 关键调用链
- **命令行求解链路**：`cmd-game.js` → `index.js` → `cards.js` / `getWinner.js`
- **桌面识牌链路**：`screen-card-helper.ps1` → `screen-recognition/ui-recognize.js` → `index.js` → `screen-recognition/index.js` → `opencv-recognize.py`（可选）
- **自动采集链路**：`screen-card-helper.ps1` 或 `npm run collect:auto` → `screen-recognition/auto-collect-material-sample.js` → `screen-recognition/import-strip-templates.py` → `materials/` 与 `templates/`
- **便携分发链路**：`构建便携版.cmd` → `tools/build-portable.ps1` → `dist/炸金花助手便携版`

### 0.2 识别层职责边界
- `index.js` 负责“识别完成后如何求解”，以及“手牌区域如何转换成 card/rank/suit 的识别配置”。
- `screen-recognition/index.js` 负责“如何从图像里得到牌码候选”，不要把纯求解规则继续塞回这里。
- `screen-card-helper.ps1` 负责“用户操作与自动点击”，不要在这里复制一套牌型规则。
- `templates/` 是识别证据库，`materials/` 是素材与审核沉淀区，两者职责不要混用。

### 1. 策略求解主入口
- `index.js`
  - 项目总入口
  - 暴露策略 API
  - 暴露识牌后直接求解 API
  - 手牌区域转识别配置也在这里

### 2. 手牌规则/牌型计算
- `cards.js`
  - 牌面基础能力
- `getWinner.js`
  - 比牌/胜负相关逻辑

### 3. 命令行玩法/调试
- `cmd-game.js`
  - 命令行交互版本

### 4. 屏幕识牌引擎
- `screen-recognition/index.js`
  - 识牌核心文件
  - 模板加载
  - 内置字模识别
  - 混合候选融合
  - 唯一牌码纠偏
  - 屏幕截图

### 5. UI 与识牌引擎桥接
- `screen-recognition/ui-recognize.js`
  - PowerShell UI 调 Node 识牌时的桥接脚本

### 6. 模板录入
- `screen-recognition/bootstrap-templates.js`
  - 从当前屏幕抓牌并写入模板目录
  - 现在会同时保存 `rank/suit/card` 模板
- `screen-recognition/capture-hand-region-sample.js`
  - 读取桌面助手已保存的 `ui-state.json`
  - 重新截图并自动裁出当前手牌区域
  - 自动放入 `screen-recognition/materials/inbox`
  - 会先做原始截图去重，避免同一手牌反复堆积
- `screen-recognition/auto-collect-material-sample.js`
  - 一次完成：智能连拍、自动择优、候选投票纠偏、自修后直接入库/待审核落盘
  - 低置信度样本进入 `screen-recognition/materials/manifests/*.pending.json`
  - 原始截图阶段和导入阶段都会做去重
  - 当多次识别结果足够一致时，会自动同步到 `templates`
  - 其中 `collectMaterialSample / buildConsensusRepair / runImportStrip` 已抽成程序内建能力，可被其他入口直接复用
- `screen-recognition/import-strip-templates.py`
  - 从一张横向多牌素材图里自动分卡
  - 自动裁出整牌 / rank / suit 素材
  - 用于持续补充素材库与候选模板
  - 同标签下会做相似图去重，避免重复污染素材库

### 7. 桌面助手 UI
- `screen-card-helper.ps1`
  - 主开发脚本
  - WinForms 按钮、日志、状态、自动采集素材、自动出牌逻辑都在这里
- `屏幕识牌助手.ps1`
  - 中文入口镜像脚本
  - 与上面脚本必须保持同步

### 8. 启动与打包
- `启动屏幕识牌助手.vbs`
  - 给用户双击启动用
- `tools/build-portable.ps1`
  - 打包便携版
- `构建便携版.cmd`
  - 打包入口命令

### 9. 运行态、素材与产物
- `screen-recognition/ui-state.json`
  - 当前 UI 选择的手牌区域、牌数、出牌点
  - 这是“运行配置”，不是无用缓存，不要随手挪走
- `screen-recognition/latest-screen.png`
  - 最近一次截图
- `screen-recognition/latest-hand-region.png`
  - 最近一次手牌区域预览
- `screen-recognition/debug-*.png` / `screen-recognition/last-*.json` / `screen-recognition/_last-ui-output.json`
  - 调试产物与最近一次运行输出
  - 可以归档搬走，不属于核心源码
- `screen-recognition/materials/inbox/*.png`
  - 自动采集阶段的原始截图缓存
  - 属于可归档的中间产物，不是最终模板
- `screen-recognition/materials/manifests/*.pending.json`
  - 自动采集后置信度不足的待审核样本清单
- `dist/`
  - 便携版构建产物
  - 不是开发入口，可以整体搬走，需要时重新打包生成

### 10. 需求到代码的快速映射

如果你要改……请先看这里：

- **改牌型中文 / 策略返回结构** → `index.js`
- **改识牌策略融合** → `screen-recognition/index.js`
- **改模板录入行为** → `screen-recognition/bootstrap-templates.js`
- **按当前已框选区域自动二次截图** → `screen-recognition/capture-hand-region-sample.js`
- **导入横向多牌素材图** → `screen-recognition/import-strip-templates.py`
- **改 UI 上的按钮/日志/中文文案** → `screen-card-helper.ps1` 和 `屏幕识牌助手.ps1`
- **改手牌区域切分逻辑** → `index.js` 里的手牌区域配置构造
- **改自动出牌点击流程** → `screen-card-helper.ps1` 和 `屏幕识牌助手.ps1`
- **改便携版打包** → `tools/build-portable.ps1`

### 11. 最小常用命令

- 安装依赖：`npm install`
- 启动桌面助手：`npm run screen-ui`
- 按当前已框选区域二次截图并保存样本：`npm run capture:hand-sample`
- 自动采集素材（智能连拍 + 候选投票纠偏 + 自修直入库/待审核）：`npm run collect:auto`
- 打包便携版：`npm run build:portable`

---

## 三、开发失败后的防踩坑要点（Harness）

本节是项目级约束。**踩过一次的坑，不允许第二次再踩。**

### H-001 不要只改一份 PowerShell UI 脚本
- `screen-card-helper.ps1` 和 `屏幕识牌助手.ps1` 是镜像关系。
- 任何 UI 行为、日志格式、兼容性修复，都必须同步两份。

### H-002 必须兼容 PowerShell 5.1
- 已确认 `Windows PowerShell 5.1` 的 `ConvertFrom-Json` **不支持** `-Depth`。
- 后续如果要解析 JSON，必须继续沿用兼容写法，不能直接把 `-Depth` 写死。

### H-003 不要把示例配置当成实时配置
- `screen-recognition/config.sample.json` 是样例。
- 桌面助手实际运行时，优先使用 `screen-recognition/ui-state.json` 和手牌区域构造逻辑。
- 调试识别偏差时，不要先怀疑算法，先确认你看的到底是“样例配置”还是“实时区域”。

### H-004 内部牌码与用户显示不是一回事
- 代码内部统一使用 `As/Qh/Td/2s`。
- 用户界面和日志统一显示 `A♠/Q♥/10♦/2♠`。
- 不要为了 UI 好看去破坏内部数据格式，否则会连锁影响求解、模板命名、识别候选和去重逻辑。

### H-005 中文文案和 README 必须保持 UTF-8
- 本项目历史上出现过中文乱码。
- 修改用户可见中文时，必须确认文件编码正常，避免再次引入乱码。

### H-006 整牌模板是可选增强，不是硬依赖
- `screen-recognition/templates/cards` 没有模板时，程序也必须能正常识别。
- 有整牌模板时，才启用整牌证据参与决策。

### H-007 改手牌区域构造时，不要丢参数透传
- 手牌区域构造逻辑不仅要传 `rank/suit`，也要传 `cardTemplatesDir` 等增强参数。
- 以前出现过“功能已实现，但配置没透传，导致功能实际未生效”的问题。

### H-008 识别策略改动后，至少检查三件事
- 当前样图能否正常输出牌面
- `matchingStrategies` 和 `availableModes` 是否符合预期
- 没有整牌模板时是否仍能正常工作

### H-009 调试识牌先看预览图和日志
- 先看 `latest-screen.png`、`latest-hand-region.png`
- 再看日志里的牌面、置信度、纠偏信息
- 不要跳过证据直接改阈值或重写算法

### H-010 不要直接改 `dist`
- `dist` 是打包产物，不是主开发入口。
- 功能修复应改源码，再重新打包。

### H-011 OpenCV 后端是增强，不是破坏性替换
- `screen-recognition/opencv-recognize.py` 是新增增强后端，目的是提升识别率，不是取代现有 JS 逻辑后把回退链路删掉。
- 改识别策略时，必须同时检查三种状态：`javascript`、`python-opencv`、`auto/hybrid-opencv`。
- 如果未来目标机器缺少 Python 或 `cv2`，程序仍必须能退回旧链路继续工作。

### H-012 自动采集链路必须先去重，再决定是否入库
- `materials/inbox` 里的原始手牌截图不能无限堆积重复图。
- `capture-hand-region-sample.js` 与 `auto-collect-material-sample.js` 的原始截图阶段都要做去重。
- `import-strip-templates.py` 负责素材级去重；不要只做后半段去重，导致前半段原图目录持续膨胀。

### H-013 自动采集优先选“最稳的一帧”，不要只截一张就决定
- 当前 `auto-collect-material-sample.js` 默认会连续截图 3 次，并自动选择综合置信度最高的一次。
- 目的不是堆更多图片，而是绕开翻牌动画、发光特效、半遮挡这些瞬态干扰。
- 后续如果继续改自动采集，优先保留“多次采集 -> 自动择优 -> 再入库”的链路，不要退回单帧决策。

### H-014 自动采集允许“自修直入库”，但必须基于多次一致性和候选投票
- 当前 `auto-collect-material-sample.js` 不再只依赖单次识别结果，而会综合多次截图的候选标签做投票纠偏。
- 只有当多次识别足够一致时，才允许自动直入库，并可顺手同步到 `templates`。
- 如果未来继续增强这条链路，核心原则是“多次一致性优先”，不要退回“低置信度也盲目直接写模板”。

---

## 维护规则

后续任何人修改 README，必须遵守：

- 新需求 → 追加到“需求记录”
- 新功能入口 → 更新“开发入口”
- 新踩坑经验 → 追加到“Harness”
- 与这三类无关的内容，不要继续往 README 塞

如果做不到这点，README 会再次失去作为项目总入口的价值。
