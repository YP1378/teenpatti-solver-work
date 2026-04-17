# Screen Recognition Templates

Place recognition templates in these folders:

- `screen-recognition/templates/ranks`
- `screen-recognition/templates/suits`
- `screen-recognition/templates/cards` (optional, recommended)

## Rank templates

Use file names such as:

- `A.png`
- `K.png`
- `Q.png`
- `J.png`
- `T.png`
- `9.png` down to `2.png`

## Suit templates

Use file names such as:

- `s.png` for spades
- `h.png` for hearts
- `d.png` for diamonds
- `c.png` for clubs

## Whole-card templates

These are optional, but they improve recognition by adding full-card evidence on top of rank/suit evidence.

Use file names such as:

- `As.png`
- `Qh.png`
- `Td.png`
- `7c.png`

## Tips

- Crop templates directly from the real game screenshot whenever possible
- Keep the same UI scale, card skin, and display scaling as the live target
- Keep backgrounds clean and avoid glow/shadow when capturing templates
- If recognition drifts, first adjust `screen-recognition/config.sample.json`
- `screen-recognition/bootstrap-templates.js` now saves rank, suit, and whole-card templates together
