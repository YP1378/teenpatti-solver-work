模板目录说明：

- `templates/ranks/`：点数模板，共 13 类
- `templates/suits/`：花色模板，共 4 类
- `templates/cards/`：整牌截图，仅用于留档和调试

推荐保存方式：

```bash
python recognize_cards.py 图片.png --save-card-index 0 --label 7H
python recognize_cards.py 图片.png --save-card-index 1 --label JS
```

执行后会自动生成：

- `templates/ranks/7.png`
- `templates/suits/H.png`
- `templates/cards/7H.png`

花色缩写：

- `S` = Spades 黑桃
- `H` = Hearts 红桃
- `D` = Diamonds 方块
- `C` = Clubs 梅花
