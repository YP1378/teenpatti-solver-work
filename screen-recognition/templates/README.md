# 模板目录说明

把截图识牌所需的模板图片放到下面两个目录：

- `screen-recognition/templates/ranks`
- `screen-recognition/templates/suits`

## 点数模板命名

文件名去掉扩展名后，直接作为识别标签。

建议使用：

- `A.png`
- `K.png`
- `Q.png`
- `J.png`
- `T.png`
- `9.png` 到 `2.png`

## 花色模板命名

建议使用：

- `s.png`：黑桃
- `h.png`：红桃
- `d.png`：方块
- `c.png`：梅花

## 模板制作建议

- 直接从游戏截图里裁切，不要手画
- 模板与目标截图必须使用同一套 UI、同一缩放比例
- `rank` 和 `suit` 只裁牌角区域，不要把整张牌裁进去
- 尽量保持背景干净，减少阴影和发光效果
- 如果识别不准，先微调 `config.sample.json` 里的区域和阈值
