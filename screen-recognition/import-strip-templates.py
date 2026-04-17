import argparse
import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".webp"}
STANDARD_RANKS = {"A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"}
STANDARD_SUITS = {"s", "h", "d", "c"}
JOKER_ALIASES = {"joker", "jk", "x", "xx", "rj", "bj"}

DEDUP_THRESHOLD = {
    "strip": 1,
    "card": 3,
    "rank": 2,
    "suit": 2,
    "special": 3,
}


def read_image(path):
    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"无法读取图片: {path}")
    return image


def ensure_dir(path):
    Path(path).mkdir(parents=True, exist_ok=True)


def parse_cards(raw_cards):
    tokens = [item for item in re.split(r"[\s,，;；|]+", str(raw_cards or "").strip()) if item]
    if not tokens:
        raise RuntimeError("请提供牌面列表，例如: 3s Kd 8c joker 9d")

    result = []
    for token in tokens:
        compact = token.strip().replace("10", "T")
        lower_compact = compact.lower()
        if lower_compact in JOKER_ALIASES:
            result.append({
                "raw": token,
                "label": "joker",
                "type": "joker",
                "rank": None,
                "suit": None,
            })
            continue

        if len(compact) != 2:
            raise RuntimeError(f"非法牌码: {token}")

        rank = compact[0].upper()
        suit = compact[1].lower()
        if rank not in STANDARD_RANKS or suit not in STANDARD_SUITS:
            raise RuntimeError(f"非法牌码: {token}")

        result.append({
            "raw": token,
            "label": rank + suit,
            "type": "standard",
            "rank": rank,
            "suit": suit,
        })

    return result


def sanitize_name(text):
    return re.sub(r"[^0-9A-Za-z_\-.]+", "_", str(text)).strip("._") or "sample"


def timestamp_text():
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def image_average_hash(image, size=8):
    if image is None or image.size == 0:
        return None
    if len(image.shape) == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image
    resized = cv2.resize(gray, (size, size), interpolation=cv2.INTER_AREA)
    average = float(resized.mean())
    bits = ["1" if int(pixel) >= average else "0" for pixel in resized.flatten()]
    return "".join(bits)


def hamming_distance(left_hash, right_hash):
    if not left_hash or not right_hash or len(left_hash) != len(right_hash):
        return 999
    return sum(1 for left_bit, right_bit in zip(left_hash, right_hash) if left_bit != right_bit)


def list_image_files(directory):
    directory = Path(directory)
    if not directory.exists():
        return []
    return sorted(path for path in directory.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS)


def find_duplicate_image_path(directory, candidate_image, max_distance):
    candidate_hash = image_average_hash(candidate_image)
    if not candidate_hash:
        return None
    best_match = None
    best_distance = None
    for existing_path in list_image_files(directory):
        try:
            existing_image = read_image(existing_path)
        except Exception:
            continue
        existing_hash = image_average_hash(existing_image)
        distance = hamming_distance(candidate_hash, existing_hash)
        if distance <= max_distance and (best_distance is None or distance < best_distance):
            best_match = existing_path
            best_distance = distance
    return best_match


def save_png_with_dedupe(image, directory, label, suffix, dedupe_key):
    duplicate_path = find_duplicate_image_path(directory, image, DEDUP_THRESHOLD[dedupe_key])
    if duplicate_path:
        return {
            "path": str(duplicate_path),
            "duplicate": True,
            "duplicateOf": str(duplicate_path),
        }

    output_path = next_variant_path(directory, label, suffix)
    save_png(image, output_path)
    return {
        "path": str(output_path),
        "duplicate": False,
        "duplicateOf": None,
    }


def copy_source_image(image_path, destination_dir, sample_name):
    ensure_dir(destination_dir)
    image = read_image(image_path)
    duplicate_path = find_duplicate_image_path(destination_dir, image, DEDUP_THRESHOLD["strip"])
    if duplicate_path:
        return duplicate_path, True, str(duplicate_path)

    extension = image_path.suffix.lower() if image_path.suffix.lower() in IMAGE_EXTENSIONS else ".png"
    target_path = Path(destination_dir) / f"{sample_name}{extension}"
    if image_path.resolve() != target_path.resolve():
        shutil.copyfile(str(image_path), str(target_path))
    return target_path, False, None


def threshold_dark_mask(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, 225, 255, cv2.THRESH_BINARY_INV)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    return mask


def dedupe_boxes(boxes):
    if not boxes:
        return []
    boxes = sorted(boxes, key=lambda item: (item[0], item[1]))
    result = []
    for box in boxes:
        x, y, w, h = box
        merged = False
        for index, current in enumerate(result):
            cx, cy, cw, ch = current
            iou_x1 = max(x, cx)
            iou_y1 = max(y, cy)
            iou_x2 = min(x + w, cx + cw)
            iou_y2 = min(y + h, cy + ch)
            inter = max(0, iou_x2 - iou_x1) * max(0, iou_y2 - iou_y1)
            union = (w * h) + (cw * ch) - inter
            iou = (inter / union) if union else 0
            if iou > 0.72 or abs(x - cx) < 6 and abs(y - cy) < 6 and abs(w - cw) < 8 and abs(h - ch) < 8:
                nx1 = min(x, cx)
                ny1 = min(y, cy)
                nx2 = max(x + w, cx + cw)
                ny2 = max(y + h, cy + ch)
                result[index] = (nx1, ny1, nx2 - nx1, ny2 - ny1)
                merged = True
                break
        if not merged:
            result.append(box)
    return sorted(result, key=lambda item: item[0])


def find_card_boxes_by_contours(image, expected_count):
    mask = threshold_dark_mask(image)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    height, width = image.shape[:2]
    candidates = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = w * h
        aspect = w / max(1, h)
        if area < (width * height * 0.04):
            continue
        if h < height * 0.58:
            continue
        if w < width / max(expected_count * 1.8, 3):
            continue
        if not (0.35 <= aspect <= 0.9):
            continue
        candidates.append((x, y, w, h))
    return dedupe_boxes(candidates)


def find_card_boxes_by_projection(image, expected_count):
    mask = threshold_dark_mask(image)
    height, width = mask.shape[:2]
    column_strength = (mask > 0).sum(axis=0)
    threshold = max(3, int(height * 0.04))
    active = column_strength >= threshold

    segments = []
    start = None
    for index, flag in enumerate(active):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            segments.append((start, index - 1))
            start = None
    if start is not None:
        segments.append((start, width - 1))

    boxes = []
    for start_x, end_x in segments:
        segment_width = end_x - start_x + 1
        if segment_width < width / max(expected_count * 2.2, 4):
            continue
        region = mask[:, start_x:end_x + 1]
        ys, xs = np.where(region > 0)
        if ys.size == 0 or xs.size == 0:
            continue
        min_y = int(ys.min())
        max_y = int(ys.max())
        boxes.append((int(start_x), min_y, int(segment_width), int(max_y - min_y + 1)))
    return dedupe_boxes(boxes)


def equal_split_boxes(image, expected_count):
    height, width = image.shape[:2]
    card_width = width / expected_count
    boxes = []
    for index in range(expected_count):
        x1 = int(round(index * card_width))
        x2 = int(round((index + 1) * card_width))
        boxes.append((x1, 0, max(1, x2 - x1), height))
    return boxes


def normalize_boxes(boxes, image):
    height, width = image.shape[:2]
    result = []
    for x, y, w, h in boxes:
        x = max(0, min(width - 1, int(x)))
        y = max(0, min(height - 1, int(y)))
        w = max(1, min(width - x, int(w)))
        h = max(1, min(height - y, int(h)))
        result.append((x, y, w, h))
    return result


def pick_card_boxes(image, expected_count):
    contour_boxes = find_card_boxes_by_contours(image, expected_count)
    if len(contour_boxes) == expected_count:
        return normalize_boxes(contour_boxes, image), "contours"

    projection_boxes = find_card_boxes_by_projection(image, expected_count)
    if len(projection_boxes) == expected_count:
        return normalize_boxes(projection_boxes, image), "projection"

    return normalize_boxes(equal_split_boxes(image, expected_count), image), "equal-split"


def crop_image(image, box):
    x, y, w, h = box
    return image[y:y + h, x:x + w].copy()


def save_png(image, path):
    ensure_dir(Path(path).parent)
    success, encoded = cv2.imencode(".png", image)
    if not success:
        raise RuntimeError(f"保存 PNG 失败: {path}")
    encoded.tofile(str(path))


def fixed_corner_regions(card_image):
    height, width = card_image.shape[:2]
    rank_box = (
        int(round(width * 0.02)),
        int(round(height * 0.02)),
        max(8, int(round(width * 0.30))),
        max(12, int(round(height * 0.26))),
    )
    suit_box = (
        int(round(width * 0.03)),
        int(round(height * 0.20)),
        max(8, int(round(width * 0.28))),
        max(10, int(round(height * 0.22))),
    )
    return rank_box, suit_box


def tight_crop_symbol(image):
    mask = threshold_dark_mask(image)
    ys, xs = np.where(mask > 0)
    if xs.size == 0 or ys.size == 0:
        return image
    min_x = max(0, int(xs.min()) - 1)
    min_y = max(0, int(ys.min()) - 1)
    max_x = min(image.shape[1], int(xs.max()) + 2)
    max_y = min(image.shape[0], int(ys.max()) + 2)
    return image[min_y:max_y, min_x:max_x].copy()


def next_variant_path(directory, label, suffix):
    ensure_dir(directory)
    plain = Path(directory) / f"{label}__{suffix}.png"
    if not plain.exists():
        return plain
    index = 1
    while True:
        path = Path(directory) / f"{label}__{suffix}_{index}.png"
        if not path.exists():
            return path
        index += 1


def import_strip(image_path, cards, materials_root, template_root=None, sync_templates=False, sample_name=None):
    image_path = Path(image_path).resolve()
    if not image_path.exists():
        raise RuntimeError(f"图片不存在: {image_path}")

    image = read_image(image_path)
    sample_name = sanitize_name(sample_name or f"{timestamp_text()}__{'_'.join(card['label'] for card in cards)}")
    materials_root = Path(materials_root).resolve()
    strip_dir = materials_root / "strips"
    manifest_dir = materials_root / "manifests"
    cards_dir = materials_root / "cards"
    ranks_dir = materials_root / "ranks"
    suits_dir = materials_root / "suits"
    specials_dir = materials_root / "specials"

    saved_strip_path, strip_is_duplicate, strip_duplicate_of = copy_source_image(image_path, strip_dir, sample_name)
    boxes, detection_mode = pick_card_boxes(image, len(cards))

    manifest = {
        "sampleName": sample_name,
        "sourceImage": str(image_path),
        "savedStripPath": str(saved_strip_path),
        "stripDuplicate": strip_is_duplicate,
        "stripDuplicateOf": strip_duplicate_of,
        "detectionMode": detection_mode,
        "cardCount": len(cards),
        "cards": [],
        "warnings": [],
    }

    template_root_path = Path(template_root).resolve() if template_root else None

    for index, card in enumerate(cards):
        box = boxes[index]
        card_image = crop_image(image, box)
        card_out_dir = cards_dir / card["label"]
        card_path = next_variant_path(card_out_dir, card["label"], sample_name + "__card")
        save_png(card_image, card_path)

        entry = {
            "index": index + 1,
            "label": card["label"],
            "type": card["type"],
            "bbox": {"x": box[0], "y": box[1], "width": box[2], "height": box[3]},
            "savedCardPath": None,
            "cardDuplicate": False,
            "cardDuplicateOf": None,
            "savedRankPath": None,
            "savedSuitPath": None,
            "syncedTemplatePaths": {},
        }

        card_save_result = save_png_with_dedupe(card_image, card_out_dir, card["label"], sample_name + "__card", "card")
        entry["savedCardPath"] = card_save_result["path"]
        entry["cardDuplicate"] = card_save_result["duplicate"]
        entry["cardDuplicateOf"] = card_save_result["duplicateOf"]

        if card["type"] == "standard":
            rank_box, suit_box = fixed_corner_regions(card_image)
            rank_raw = crop_image(card_image, rank_box)
            suit_raw = crop_image(card_image, suit_box)
            rank_image = tight_crop_symbol(rank_raw)
            suit_image = tight_crop_symbol(suit_raw)

            rank_save_result = save_png_with_dedupe(rank_image, ranks_dir / card["rank"], card["rank"], sample_name + "__rank", "rank")
            suit_save_result = save_png_with_dedupe(suit_image, suits_dir / card["suit"], card["suit"], sample_name + "__suit", "suit")
            entry["savedRankPath"] = rank_save_result["path"]
            entry["savedSuitPath"] = suit_save_result["path"]
            entry["rankDuplicate"] = rank_save_result["duplicate"]
            entry["rankDuplicateOf"] = rank_save_result["duplicateOf"]
            entry["suitDuplicate"] = suit_save_result["duplicate"]
            entry["suitDuplicateOf"] = suit_save_result["duplicateOf"]

            if sync_templates and template_root_path:
                sync_rank_result = save_png_with_dedupe(rank_image, template_root_path / "ranks", card["rank"], sample_name, "rank")
                sync_suit_result = save_png_with_dedupe(suit_image, template_root_path / "suits", card["suit"], sample_name, "suit")
                sync_card_result = save_png_with_dedupe(card_image, template_root_path / "cards", card["label"], sample_name, "card")
                entry["syncedTemplatePaths"] = {
                    "rank": sync_rank_result["path"],
                    "suit": sync_suit_result["path"],
                    "card": sync_card_result["path"],
                }
        else:
            special_save_result = save_png_with_dedupe(card_image, specials_dir / card["label"], card["label"], sample_name + "__card", "special")
            entry["specialPath"] = special_save_result["path"]
            entry["specialDuplicate"] = special_save_result["duplicate"]
            entry["specialDuplicateOf"] = special_save_result["duplicateOf"]
            manifest["warnings"].append(f"第 {index + 1} 张是 joker，仅保存整牌素材，不写入 rank/suit 模板。")

        manifest["cards"].append(entry)

    ensure_dir(manifest_dir)
    manifest_path = manifest_dir / f"{sample_name}.json"
    with open(manifest_path, "w", encoding="utf-8") as file:
        json.dump(manifest, file, ensure_ascii=False, indent=2)
    manifest["manifestPath"] = str(manifest_path)
    return manifest


def main():
    parser = argparse.ArgumentParser(description="导入五连牌/多连牌素材图，并自动裁剪为 card/rank/suit 素材。")
    parser.add_argument("--image", required=True, help="输入整图路径")
    parser.add_argument("--cards", required=True, help="牌面列表，例如: 3s Kd 8c joker 9d")
    parser.add_argument("--materials-root", default="./screen-recognition/materials", help="素材库根目录")
    parser.add_argument("--template-root", default="./screen-recognition/templates", help="模板目录根路径")
    parser.add_argument("--sample-name", default=None, help="样本名；默认自动生成")
    parser.add_argument("--sync-templates", action="store_true", help="同时写入 templates/ranks|suits|cards")
    parser.add_argument("--json-out", default=None, help="可选，输出 JSON 文件路径")
    args = parser.parse_args()

    cards = parse_cards(args.cards)
    manifest = import_strip(
        image_path=args.image,
        cards=cards,
        materials_root=args.materials_root,
        template_root=args.template_root,
        sync_templates=bool(args.sync_templates),
        sample_name=args.sample_name,
    )

    output_text = json.dumps(manifest, ensure_ascii=False, indent=2)
    if args.json_out:
        json_out_path = Path(args.json_out).resolve()
        ensure_dir(json_out_path.parent)
        json_out_path.write_text(output_text, encoding="utf-8")
    print(output_text)


if __name__ == "__main__":
    main()
