# RANDOM.ORG 扑克牌识别

这是当前项目里最快、最稳的一条路线：

- 适配 `RANDOM.ORG` 的扑克牌截图
- 不训练模型
- 不做 OCR
- 不需要手工做 52 张模板
- 直接使用网站原始牌面图片做整牌匹配

## 为什么这条路线更快

你现在拿到的截图，牌面样式来自 `RANDOM.ORG` 固定素材。

既然素材是固定的，最省事的方法不是训练模型，而是：

1. 直接拿到网站的 52 张原始牌面图
2. 在截图里找到每张牌
3. 拉正到统一大小
4. 和原始牌面逐张比较
5. 输出从左到右的结果，例如 `KD 8D 4S 2S`

## 主脚本

```bash
python recognize_random_org_cards.py 图片.png
```

例如：

```bash
python recognize_random_org_cards.py image.png
```

## 调试图

```bash
python recognize_random_org_cards.py image.png --debug-out debug.png
```

## 模板目录

默认模板目录是：

```text
random_org_templates/
```

当前项目里已经放入了完整的 52 张模板图，所以一般不用你再下载。

## 重新拉取模板

如果你想自己重新从网站拉一次模板：

```bash
python recognize_random_org_cards.py --bootstrap-templates
```

或者一边拉模板一边跑图：

```bash
python recognize_random_org_cards.py image.png --bootstrap-templates
```

## 适用范围

这套方法非常适合：

- 截图来自 `RANDOM.ORG`
- 牌面样式固定不变
- 图片里有 4 到 5 张牌
- 牌基本正放，没有严重遮挡

## 结果格式

输出是从左到右的简写：

- `S` = 黑桃
- `H` = 红桃
- `D` = 方块
- `C` = 梅花

例如：

- `KD` = 方块 K
- `JC` = 梅花 J
- `9S` = 黑桃 9

## 备注

项目里之前那个 `recognize_cards.py` 是通用实验版，走的是模板切角路线。

如果你的作业截图确实来自 `RANDOM.ORG`，优先用：

```text
recognize_random_org_cards.py
```
