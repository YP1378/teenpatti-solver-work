# Strip Import

用于把“单张图片里横向排开的多张牌”自动切成素材库文件。

适用场景：

- 你持续提供 4 张 / 5 张 / 更多张的牌面截图
- 目标是补充 `card / rank / suit` 素材
- 不希望每次手工裁图

## 目录约定

- 原图保存到 `screen-recognition/materials/strips`
- 整牌素材保存到 `screen-recognition/materials/cards/<牌码>`
- 点数素材保存到 `screen-recognition/materials/ranks/<点数>`
- 花色素材保存到 `screen-recognition/materials/suits/<花色>`
- manifest 保存到 `screen-recognition/materials/manifests`
- joker 等特殊牌保存到 `screen-recognition/materials/specials/<标签>`

## 用法

```powershell
python .\screen-recognition\import-strip-templates.py \
  --image .\screen-recognition\materials\inbox\sample.png \
  --cards "3s Kd 8c joker 9d"
```

如果要把裁好的结果直接同步进当前识别模板目录：

```powershell
python .\screen-recognition\import-strip-templates.py \
  --image .\screen-recognition\materials\inbox\sample.png \
  --cards "3s Kd 8c joker 9d" \
  --sync-templates
```

## 说明

- `joker` 会只保存整牌素材，不写入当前 `rank/suit` 模板
- 自动分卡优先用 contour / projection，失败才退回等分切图
- 当前脚本更适合“白底、横向排开、卡牌边框清晰”的素材图
- 同标签下会自动做相似图去重，避免把几乎相同的 `card / rank / suit` 素材反复写入库

## 自动采集

如果已经在桌面助手里框好了区域，可以直接运行：

```powershell
npm run collect:auto
```

行为规则：

- 总是先二次截图，把当前手牌区域保存到 `screen-recognition/materials/inbox`
- 如果识别置信度足够高，则自动导入素材库
- 如果识别置信度不够高，则自动写入 `materials/manifests/*.pending.json`，等待后续人工确认
