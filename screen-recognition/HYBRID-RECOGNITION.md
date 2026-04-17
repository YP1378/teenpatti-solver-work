# Hybrid Recognition Notes

当前识别器现在会把多路证据合并起来，而不是只依赖单一路径：

- 原始 `rank/suit` 模板匹配
- 归一化后的符号模板匹配
- `auto` 模式下的内置字模候选
- 可选的整牌模板匹配（`templates/cards`）

## 为什么这样更稳

- 原始模板对“完全同款截图”最强
- 归一化符号模板对轻微偏移、边缘噪声、裁剪不准更稳
- 内置字模可以给模板不足时兜底
- 整牌模板可以在角标容易混淆时补充整牌级别证据

## 新增模板目录

- `screen-recognition/templates/cards`

整牌模板命名示例：

- `As.png`
- `Qh.png`
- `Td.png`

## 录模板

运行 `screen-recognition/bootstrap-templates.js` 时，现在会同时保存：

- 点数模板
- 花色模板
- 整牌模板

## 返回结果

识别结果里新增了这些有用信息：

- `cards[].cardMatch`
- `matchingStrategies`
- `availableModes.cardTemplate`

这样你可以更容易判断当前结果主要是靠哪一路证据打出来的。
