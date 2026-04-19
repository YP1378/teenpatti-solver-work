# ZhaJinHuaJHJ / teenpatti-solver-work

## 临时清理说明（2026-04-19）

- 本次未删除任何文件。
- 已移动出项目的仅是运行/调试产物，不是源码，也不是运行必需文件。
- 已移动到桌面目录：`C:\Users\16858\Desktop\d\teenpatti-solver-work-临时调试文件`
- 当前已移走的典型文件包括：
  - `app/screen-recognition/debug-front-payload.json`
  - `app/screen-recognition/debug-loop-payload.json`
  - `app/screen-recognition/last-node-stdout.json`
  - `app/screen-recognition/last-node-stderr.log`
  - `app/screen-recognition/last-node-payload.json`
  - `app/screen-recognition/latest-hand-region.png`
  - `app/screen-recognition/latest-screen.png`
- 这些文件后续在再次识牌/挂机时仍可能被重新生成；如果再次需要清理，只移动这些运行产物，不要移动 `app` 下源码、模板、`runtime`、`node_modules`。
- 第二轮又归档了一批非核心示例/说明/包装文件，到：`C:\Users\16858\Desktop\d\teenpatti-solver-work-第二轮归档`
- 第二轮归档文件包括：
  - `app/app.js`
  - `app/getWinner.js`
  - `app/构建便携版.cmd`
  - `app/screen-recognition/HYBRID-RECOGNITION.md`
  - `app/screen-recognition/STRIP-IMPORT.md`
  - `app/screen-recognition/config.sample.json`
  - `app/screen-recognition/templates/README.md`

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
- 支持在桌面助手中同时保存并识别最多 `8` 个手牌区域。
- 多区域识别时，默认使用最多 `8` 个并发 worker / 线程同时处理，并把结果统一汇总到现有日志窗口。
- 多区域识别时，应优先走“一次截图 + 批量识别”路径，尽量减少重复截图、重复模板加载、重复后端启动；批量路径失败时才回退到 worker pool。

### R-003 识别策略升级
- 当前识别策略必须是**混合策略**，而不是单一路径。
- 已接入的有效证据源：
  - 原始 `rank/suit` 模板匹配
  - 归一化后的符号模板匹配
  - `auto` 模式下的内置字模候选
  - 可选的整牌模板匹配 `app/screen-recognition/templates/cards`

### R-004 模板体系
- 模板目录至少包含：
  - `app/screen-recognition/templates/ranks`
  - `app/screen-recognition/templates/suits`
  - `app/screen-recognition/templates/cards`（可选但推荐）
- 模板录入脚本必须可同时保存点数模板、花色模板、整牌模板。

### R-005 桌面助手
- 提供 Windows 下的 PowerShell + WinForms 小工具。
- 至少支持：框选手牌区域、设置出牌点、单次识别、自动出牌、连续挂机、可调挂机间隔。
- 多区域模式下，至少支持重复框选追加区域、重选全部区域，以及在日志窗口中逐区域展示识别结果。
- 多区域模式下，识别执行模型应是“最多 8 个并发 worker / 线程”，而不是串行逐个识别。
- UI 必须提供明确的多区域入口，至少包含：区域列表、添加区域、替换选中区域、删除选中区域、清空区域。
- 第 1 个区域必须支持正常拖框；第 2 个及后续区域默认沿用第 1 个区域尺寸，只需点击目标区域左上角即可保存。
- 点击“连续挂机 / 自动挂机”后，应立即对当前全部已保存区域一起开始识别，并把多区域结果继续汇总到现有日志窗口。
- 日志窗口应显示多区域执行摘要，至少包含：区域数、并发线程数、执行路径、总耗时，以及当前可见的 OpenCL / CUDA / CPU 线程信息。

### R-006 便携运行
- 项目支持打包为便携版本。
- 目标机器可通过内置 `app/runtime/node/node.exe` 直接运行，不强依赖外部 Node.js。

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
- 当目标机器支持时，OpenCV 后端应尽量启用 CPU 多线程优化，并优先吃到 OpenCL / CUDA 等可用加速能力；执行结果里应能看到当前加速状态。

### R-012 识别性能优先
- 当前性能优化优先级高于继续堆叠新识别路径；先消除重复 I/O、重复模板预处理、重复 recognizer 初始化，再考虑更重的算法改写。
- `app/screen-recognition/index.js` 和 `app/screen-recognition/opencv-recognize.py` 内的模板/特征应允许进程内缓存，避免多区域和连续挂机时重复预处理。
- 多区域下的策略求解应复用单次识别结果，不允许在 UI 桥接层对同一批牌再次做重复求解。
- 若目标机器存在 NVIDIA GPU，优先先探测并显示 CUDA 状态；只有在 OpenCV 确认为 CUDA 编译版且收益明确时，才继续推进真正的 CUDA 图像计算改写。

### R-011 Random.org 标准素材兼容
- 支持导入 `https://www.random.org/playing-cards/` 当前使用的标准扑克牌素材，作为一套可重复生成的基准模板。
- 至少覆盖 52 张正面；推荐同时保留 2 张 Joker 和常见牌背素材，方便后续扩展或对照。
- 对 random.org 横向无间距展示的 `4 张` / `5 张` 牌列截图，默认识别链路应能稳定识别。

---

## 二、开发入口

本节回答一个问题：**“我要改某个功能，先去哪个文件？”**

当前仓库已经做过根目录收纳：**根目录只保留 `README.md` 和 `启动屏幕识牌助手.vbs` 作为常用入口**；其余项目文件集中在隐藏的 `app/` 目录。

### 0. 架构分层总览
- **第 1 层：规则与评分核心**
  - `app/cards.js`：牌码解析、点数/花色映射、整副牌枚举。
  - `app/index.js`：核心牌型评分、4/5 选 3 策略、结构化诊断结果，以及单区域/多区域识别后直接求解入口。
- **第 2 层：交互与编排入口**
  - `app/cmd-game.js`：命令行试玩入口，负责发牌、交互、展示最佳策略。
  - `app/screen-recognition/ui-recognize.js`：桌面助手与 Node 求解/识牌能力之间的桥接层，负责批量优先、失败回退到 worker pool，并回传执行摘要。
- **第 3 层：屏幕识牌引擎**
  - `app/screen-recognition/index.js`：识牌主引擎，负责区域归一化、模板加载、进程内缓存、候选融合、后端回退，以及批量识别编排。
  - `app/screen-recognition/builtin-glyphs.js`：内置字模，作为无模板或低模板覆盖时的补充证据源。
  - `app/screen-recognition/opencv-recognize.py`：Python/OpenCV 增强后端，和 JS 识别链路并行融合，并支持批量 job、模板库缓存、掩码特征预计算。
- **第 4 层：素材与模板流转**
  - `app/screen-recognition/capture-hand-region-sample.js`：按当前 UI 保存的区域自动二次截图。
  - `app/screen-recognition/import-strip-templates.py`：把横向素材条拆成 `card/rank/suit` 三类素材并去重。
- **第 5 层：Windows 助手与打包分发**
  - `app/screen-card-helper.ps1` / `app/屏幕识牌助手.ps1`：WinForms 桌面助手、自动点击、挂机控制。
  - `启动屏幕识牌助手.vbs`：隐藏 PowerShell 窗口的双击启动器。
  - `app/tools/build-portable.ps1` + `app/runtime/` + `app/dist/`：便携版打包与运行时分发。

### 0.1 关键调用链
- **命令行求解链路**：`app/cmd-game.js` → `app/index.js` → `app/cards.js`
- **桌面识牌链路**：`app/screen-card-helper.ps1` → `app/screen-recognition/ui-recognize.js` → `app/index.js` → `app/screen-recognition/index.js` → `app/screen-recognition/opencv-recognize.py`（可选）；多区域时优先一次截图后走 batch，再回退 worker pool
- **便携分发链路**：`npm run build:portable` / `app/tools/build-portable.ps1` → `app/dist/炸金花助手便携版`

### 0.2 识别层职责边界
- `app/index.js` 负责“识别完成后如何求解”，以及“手牌区域如何转换成 card/rank/suit 的识别配置”。
- `app/screen-recognition/index.js` 负责“如何从图像里得到牌码候选”，不要把纯求解规则继续塞回这里。
- `app/screen-card-helper.ps1` 负责“用户操作与自动点击”，不要在这里复制一套牌型规则。
- `app/screen-recognition/templates/` 是识别证据库，`app/screen-recognition/materials/` 是素材与审核沉淀区，两者职责不要混用。

### 1. 策略求解主入口
- `app/index.js`
  - 项目总入口
  - 暴露策略 API
  - 暴露单区域识牌后直接求解 API
  - 暴露多区域批量识牌后直接求解 API
  - 手牌区域转识别配置也在这里

### 2. 手牌规则/牌型计算
- `app/cards.js`
  - 牌面基础能力

### 3. 命令行玩法/调试
- `app/cmd-game.js`
  - 命令行交互版本

### 4. 屏幕识牌引擎
- `app/screen-recognition/index.js`
  - 识牌核心文件
  - 模板加载
  - 模板缓存 / recognizer 缓存
  - 内置字模识别
  - 混合候选融合
  - 批量识别编排
  - 唯一牌码纠偏
  - 屏幕截图

### 5. UI 与识牌引擎桥接
- `app/screen-recognition/ui-recognize.js`
  - PowerShell UI 调 Node 识牌时的桥接脚本
  - 多区域时负责一次截图、优先批量识别、必要时回退到多个 worker，并把执行摘要聚合返回 UI

### 6. 模板与素材工具
- `app/tools/import-random-org-playing-cards.js`
  - 下载 `random.org` 当前实际使用的标准牌面素材
  - 自动生成 `card / rank / suit` 三类模板
  - 会额外保留原始素材和映射清单到 `app/screen-recognition/sources/random-org-playing-cards`
- `app/screen-recognition/capture-hand-region-sample.js`
  - 读取桌面助手已保存的 `ui-state.json`
  - 重新截图并自动裁出当前手牌区域
  - 自动放入 `app/screen-recognition/materials/inbox`
  - 会先做原始截图去重，避免同一手牌反复堆积
- `app/screen-recognition/import-strip-templates.py`
  - 从一张横向多牌素材图里自动分卡
  - 自动裁出整牌 / rank / suit 素材
  - 用于持续补充素材库与候选模板
  - 同标签下会做相似图去重，避免重复污染素材库

### 7. 桌面助手 UI
- `app/screen-card-helper.ps1`
  - 主开发脚本
  - WinForms 按钮、日志、状态、自动出牌逻辑都在这里
- `app/屏幕识牌助手.ps1`
  - 中文入口镜像脚本
  - 与上面脚本必须保持同步

### 8. 启动与打包
- `启动屏幕识牌助手.vbs`
  - 给用户双击启动用
- `app/tools/build-portable.ps1`
  - 打包便携版
- `app/tools/random-org-smoke-test.js`
  - 用 random.org 标准牌面合成样图并验证识别结果

### 9. 运行态、素材与产物
- `app/screen-recognition/ui-state.json`
  - 当前 UI 选择的手牌区域、牌数、出牌点
  - 多区域时保存到 `handRegions`；同时保留第 1 个区域到 `handRegion` 兼容旧链路
  - 这是“运行配置”，不是无用缓存，不要随手挪走
- `app/screen-recognition/latest-screen.png`
  - 最近一次截图
- `app/screen-recognition/latest-hand-region.png`
  - 最近一次第 1 个手牌区域预览；多区域时还会生成 `latest-hand-region-2.png` 等预览图
- `app/screen-recognition/debug-*.png` / `app/screen-recognition/last-*.json` / `app/screen-recognition/_last-ui-output.json`
  - 调试产物与最近一次运行输出
  - 可以归档搬走，不属于核心源码
- `app/dist/`
  - 便携版构建产物
  - 不是开发入口，可以整体搬走，需要时重新打包生成

### 10. 需求到代码的快速映射

如果你要改……请先看这里：

- **改牌型中文 / 策略返回结构** → `app/index.js`
- **改识牌策略融合** → `app/screen-recognition/index.js`
- **改多区域批量识别 / 缓存策略 / 后端调度** → `app/screen-recognition/index.js`、`app/screen-recognition/ui-recognize.js`
- **改 Python/OpenCV 批处理 / 模板缓存 / 掩码匹配** → `app/screen-recognition/opencv-recognize.py`
- **改挂机间隔输入框/UI 按钮布局** → `app/screen-card-helper.ps1` 和 `app/屏幕识牌助手.ps1`
- **导入 random.org 标准牌面并生成模板** → `app/tools/import-random-org-playing-cards.js`
- **按当前已框选区域自动二次截图** → `app/screen-recognition/capture-hand-region-sample.js`
- **导入横向多牌素材图** → `app/screen-recognition/import-strip-templates.py`
- **验证 random.org 标准牌面识别** → `app/tools/random-org-smoke-test.js`
- **改 UI 上的按钮/日志/中文文案** → `app/screen-card-helper.ps1` 和 `app/屏幕识牌助手.ps1`
- **改手牌区域切分逻辑** → `app/index.js` 里的手牌区域配置构造
- **改自动出牌点击流程** → `app/screen-card-helper.ps1` 和 `app/屏幕识牌助手.ps1`
- **改便携版打包** → `app/tools/build-portable.ps1`

### 11. 最小常用命令

- 先进入工程目录：`cd app`
- 安装依赖：在 `app` 目录执行 `npm install`
- 导入 random.org 标准模板：在 `app` 目录执行 `npm run import:randomorg`
- 验证 random.org 标准模板识别：在 `app` 目录执行 `npm run smoke:randomorg`
- 启动桌面助手：在 `app` 目录执行 `npm run screen-ui`
- 按当前已框选区域二次截图并保存样本：在 `app` 目录执行 `npm run capture:hand-sample`
- 打包便携版：在 `app` 目录执行 `npm run build:portable`

---

## 三、开发失败后的防踩坑要点（Harness）

本节是项目级约束。**踩过一次的坑，不允许第二次再踩。**

### H-001 不要只改一份 PowerShell UI 脚本
- `app/screen-card-helper.ps1` 和 `app/屏幕识牌助手.ps1` 是镜像关系。
- 任何 UI 行为、日志格式、兼容性修复，都必须同步两份。

### H-002 必须兼容 PowerShell 5.1
- 已确认 `Windows PowerShell 5.1` 的 `ConvertFrom-Json` **不支持** `-Depth`。
- 后续如果要解析 JSON，必须继续沿用兼容写法，不能直接把 `-Depth` 写死。

### H-003 不要把示例配置当成实时配置
- `app/screen-recognition/config.sample.json` 已归档到桌面第二轮归档目录；当前运行态以 `app/screen-recognition/ui-state.json` 为准。
- 桌面助手实际运行时，优先使用 `app/screen-recognition/ui-state.json` 和手牌区域构造逻辑。
- 多区域运行态以 `handRegions` 为准；`handRegion` 只是给旧链路保留的第 1 个区域兼容字段。
- 调试识别偏差时，不要先怀疑算法，先确认你看的到底是“样例配置”还是“实时区域”。

### H-004 内部牌码与用户显示不是一回事
- 代码内部统一使用 `As/Qh/Td/2s`。
- 用户界面和日志统一显示 `A♠/Q♥/10♦/2♠`。
- 不要为了 UI 好看去破坏内部数据格式，否则会连锁影响求解、模板命名、识别候选和去重逻辑。

### H-005 中文文案和 README 必须保持 UTF-8
- 本项目历史上出现过中文乱码。
- 修改用户可见中文时，必须确认文件编码正常，避免再次引入乱码。

### H-006 整牌模板是可选增强，不是硬依赖
- `app/screen-recognition/templates/cards` 没有模板时，程序也必须能正常识别。
- 有整牌模板时，才启用整牌证据参与决策。

### H-007 改手牌区域构造时，不要丢参数透传
- 手牌区域构造逻辑不仅要传 `rank/suit`，也要传 `cardTemplatesDir` 等增强参数。
- 以前出现过“功能已实现，但配置没透传，导致功能实际未生效”的问题。

### H-008 识别策略改动后，至少检查三件事
- 当前样图能否正常输出牌面
- `matchingStrategies` 和 `availableModes` 是否符合预期
- 没有整牌模板时是否仍能正常工作

### H-009 调试识牌先看预览图和日志
- 先看 `app/screen-recognition/latest-screen.png`、`app/screen-recognition/latest-hand-region.png`
- 再看日志里的牌面、置信度、纠偏信息
- 不要跳过证据直接改阈值或重写算法

### H-010 不要直接改 `dist`
- `dist` 是打包产物，不是主开发入口。
- 功能修复应改源码，再重新打包。

### H-011 OpenCV 后端是增强，不是破坏性替换
- `app/screen-recognition/opencv-recognize.py` 是新增增强后端，目的是提升识别率，不是取代现有 JS 逻辑后把回退链路删掉。
- 改识别策略时，必须同时检查三种状态：`javascript`、`python-opencv`、`auto/hybrid-opencv`。
- 如果未来目标机器缺少 Python 或 `cv2`，程序仍必须能退回旧链路继续工作。

### H-012 多区域性能优化先看“是否重复做事”
- 如果一轮识别里已经有同一张截图、同一套模板、同一组手牌，不要再重复截图、重复读模板、重复建 recognizer、重复求解。
- 性能优化优先先查“是不是同一批工作做了两遍”，再考虑调阈值或重写算法。

### H-013 批量链路优先，worker pool 只是回退
- 多区域模式的首选路径应是 batch；worker pool 的职责是兜底，而不是重新退回“每区域单独起一套重流程”。
- 改 `ui-recognize.js` 或后端调度时，必须确认 batch 失败才会触发回退，不能把默认路径悄悄改回慢路径。

### H-014 当前桌面助手的最大剩余启动开销在进程边界
- 目前 PowerShell UI 仍是按次启动 `node ... screen-recognition/ui-recognize.js`。
- 如果后续继续追求连续挂机和高频识别性能，优先考虑“常驻识别服务/守护进程”，而不是只在单次识别函数里继续做微优化。

### H-015 random.org 标准牌面不要手工抠模板
- random.org 这一套标准牌面优先通过 `app/tools/import-random-org-playing-cards.js` 整套下载并生成模板，不要再手工一张张截。
- 如果 random.org 未来更新了牌面样式，先整体刷新标准模板并重跑 `app/tools/random-org-smoke-test.js`，再考虑调阈值或改算法。

### H-016 WinForms 选框事件不要再用 `GetNewClosure()`
- 本项目已实测：在当前 PowerShell + WinForms 选框弹层里，把 `MouseDown/MouseMove/MouseUp/Shown` 这类事件处理器包成 `.GetNewClosure()` 会出现事件不触发，直接导致“点了加区域但无法框选”。
- 区域框选与点位拾取这类交互，统一直接使用 WinForms 事件里的 `$this` / `$_`，并用 `DialogResult` 明确区分“成功选择”和“取消选择”。
- 修这条链路时，必须同时验证三件事：第 1 个区域能拖框、第 2 个区域能按同尺寸定位、保存后 UI 计数会立即从 `0/8` 变成 `1/8`。

---

## 维护规则

后续任何人修改 README，必须遵守：

- 新需求 → 追加到“需求记录”
- 新功能入口 → 更新“开发入口”
- 新踩坑经验 → 追加到“Harness”
- 与这三类无关的内容，不要继续往 README 塞

如果做不到这点，README 会再次失去作为项目总入口的价值。
