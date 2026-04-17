import argparse
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp"}
SUIT_FAMILY = {"h": "red", "d": "red", "s": "black", "c": "black"}
RANK_CANVAS = (72, 96)
SUIT_CANVAS = (56, 56)


def clamp01(value):
    return max(0.0, min(1.0, float(value)))


def read_text_json(path):
    with open(path, "r", encoding="utf-8-sig") as file:
        return json.load(file)


def read_image(path):
    data = np.fromfile(path, dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Failed to read image: {path}")
    return image


def normalize_rank_label(label):
    value = str(label or "").strip().upper()
    if value == "10":
        value = "T"
    return value if value in {"2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"} else None


def normalize_suit_label(label):
    value = str(label or "").strip().lower()
    aliases = {
        "s": "s",
        "spade": "s",
        "spades": "s",
        "♠": "s",
        "h": "h",
        "heart": "h",
        "hearts": "h",
        "♥": "h",
        "d": "d",
        "diamond": "d",
        "diamonds": "d",
        "♦": "d",
        "c": "c",
        "club": "c",
        "clubs": "c",
        "♣": "c",
    }
    return aliases.get(value)


def normalize_card_code(code):
    compact = str(code or "").strip().replace(" ", "")
    if len(compact) != 2:
        return None
    rank = normalize_rank_label(compact[0])
    suit = normalize_suit_label(compact[1])
    if not rank or not suit:
        return None
    return rank + suit


def ensure_region(region):
    return {
        "x": int(round(float(region["x"]))),
        "y": int(round(float(region["y"]))),
        "width": int(round(float(region["width"]))),
        "height": int(round(float(region["height"]))),
    }


def clip_region(region, image):
    height, width = image.shape[:2]
    x = max(0, min(width - 1, int(region["x"])))
    y = max(0, min(height - 1, int(region["y"])))
    w = max(1, min(width - x, int(region["width"])))
    h = max(1, min(height - y, int(region["height"])))
    return {"x": x, "y": y, "width": w, "height": h}


def crop_region(image, region):
    clipped = clip_region(region, image)
    return image[clipped["y"]:clipped["y"] + clipped["height"], clipped["x"]:clipped["x"] + clipped["width"]].copy(), clipped


def expand_region(region, image, pad_x, pad_y):
    expanded = {
        "x": region["x"] - pad_x,
        "y": region["y"] - pad_y,
        "width": region["width"] + (pad_x * 2),
        "height": region["height"] + (pad_y * 2),
    }
    return clip_region(expanded, image)


def scale_sub_region(relative_region, original_card_region, refined_card_region):
    scale_x = refined_card_region["width"] / max(1, original_card_region["width"])
    scale_y = refined_card_region["height"] / max(1, original_card_region["height"])
    return {
        "x": int(round(relative_region["x"] * scale_x)),
        "y": int(round(relative_region["y"] * scale_y)),
        "width": max(1, int(round(relative_region["width"] * scale_x))),
        "height": max(1, int(round(relative_region["height"] * scale_y))),
    }


def clean_mask(mask, close_size=2, open_size=2):
    normalized = np.where(mask > 0, 255, 0).astype(np.uint8)
    if close_size > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_size, close_size))
        normalized = cv2.morphologyEx(normalized, cv2.MORPH_CLOSE, kernel)
    if open_size > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_size, open_size))
        normalized = cv2.morphologyEx(normalized, cv2.MORPH_OPEN, kernel)
    return normalized


def estimate_color_family(image):
    if image.size == 0:
        return "black"
    blue, green, red = cv2.split(image)
    red_mask = (
        (red > 72)
        & ((red.astype(np.int16) - green.astype(np.int16)) > 18)
        & ((red.astype(np.int16) - blue.astype(np.int16)) > 10)
    )
    red_pixels = int(np.count_nonzero(red_mask))
    threshold = max(5, int(image.shape[0] * image.shape[1] * 0.01))
    return "red" if red_pixels >= threshold else "black"


def build_mask_variants(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    blue, green, red = cv2.split(image)
    red_mask = (
        (red > 72)
        & ((red.astype(np.int16) - green.astype(np.int16)) > 18)
        & ((red.astype(np.int16) - blue.astype(np.int16)) > 10)
    ).astype(np.uint8) * 255
    _, otsu_mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    dark_cutoff = int(min(170, max(90, float(np.mean(gray)) * 0.92)))
    dark_mask = np.where(gray < dark_cutoff, 255, 0).astype(np.uint8)
    adaptive_mask = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 11, 2)
    white_bg_mask = ((hsv[:, :, 1] < 90) & (hsv[:, :, 2] > 130)).astype(np.uint8) * 255
    combined = cv2.bitwise_or(dark_mask, red_mask)
    combined = cv2.bitwise_and(combined, cv2.bitwise_not(cv2.bitwise_not(white_bg_mask) & cv2.bitwise_not(combined)))

    return [
        ("combined", clean_mask(combined, 2, 2)),
        ("otsu", clean_mask(otsu_mask, 2, 2)),
        ("adaptive", clean_mask(adaptive_mask, 2, 2)),
        ("dark", clean_mask(dark_mask, 2, 2)),
        ("red", clean_mask(red_mask, 2, 1)),
    ]


def find_union_bbox(mask, symbol_type):
    if mask.size == 0 or np.count_nonzero(mask) == 0:
        return None
    components = cv2.connectedComponentsWithStats(mask, 8)
    count, _, stats, _ = components
    height, width = mask.shape[:2]
    boxes = []
    min_area = max(3, int(width * height * 0.008))
    max_area = int(width * height * 0.9)
    for index in range(1, count):
        x, y, w, h, area = stats[index]
        if area < min_area or area > max_area:
            continue
        if symbol_type == "rank":
            if h < max(4, int(height * 0.18)):
                continue
            if y > int(height * 0.72):
                continue
        else:
            if h < max(4, int(height * 0.14)):
                continue
        boxes.append((x, y, w, h, area))
    if not boxes:
        ys, xs = np.where(mask > 0)
        if xs.size == 0 or ys.size == 0:
            return None
        return int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)
    min_x = min(item[0] for item in boxes)
    min_y = min(item[1] for item in boxes)
    max_x = max(item[0] + item[2] for item in boxes)
    max_y = max(item[1] + item[3] for item in boxes)
    return int(min_x), int(min_y), int(max_x - min_x), int(max_y - min_y)


def fit_mask_to_canvas(mask, canvas_size):
    canvas_width, canvas_height = canvas_size
    ys, xs = np.where(mask > 0)
    if xs.size == 0 or ys.size == 0:
        return np.zeros((canvas_height, canvas_width), dtype=np.uint8)
    cropped = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    target_width = max(1, canvas_width - 8)
    target_height = max(1, canvas_height - 8)
    scale = min(target_width / cropped.shape[1], target_height / cropped.shape[0])
    resized_width = max(1, int(round(cropped.shape[1] * scale)))
    resized_height = max(1, int(round(cropped.shape[0] * scale)))
    resized = cv2.resize(cropped, (resized_width, resized_height), interpolation=cv2.INTER_AREA)
    _, resized = cv2.threshold(resized, 127, 255, cv2.THRESH_BINARY)
    canvas = np.zeros((canvas_height, canvas_width), dtype=np.uint8)
    offset_x = (canvas_width - resized_width) // 2
    offset_y = (canvas_height - resized_height) // 2
    canvas[offset_y:offset_y + resized_height, offset_x:offset_x + resized_width] = resized
    return canvas


def contour_similarity(candidate_mask, template_mask):
    candidate_contours, _ = cv2.findContours(candidate_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    template_contours, _ = cv2.findContours(template_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not candidate_contours or not template_contours:
        return 0.0
    candidate_contour = max(candidate_contours, key=cv2.contourArea)
    template_contour = max(template_contours, key=cv2.contourArea)
    distance = cv2.matchShapes(candidate_contour, template_contour, cv2.CONTOURS_MATCH_I1, 0.0)
    return clamp01(1.0 / (1.0 + (distance * 4.0)))


def projection_similarity(candidate_mask, template_mask, axis):
    candidate = (candidate_mask > 0).astype(np.float32)
    template = (template_mask > 0).astype(np.float32)
    if axis == 0:
        candidate_projection = candidate.mean(axis=0)
        template_projection = template.mean(axis=0)
    else:
        candidate_projection = candidate.mean(axis=1)
        template_projection = template.mean(axis=1)
    return clamp01(1.0 - float(np.mean(np.abs(candidate_projection - template_projection))))


def mask_similarity(candidate_mask, template_mask):
    candidate = candidate_mask > 0
    template = template_mask > 0
    intersection = float(np.logical_and(candidate, template).sum())
    union = float(np.logical_or(candidate, template).sum())
    candidate_area = float(candidate.sum())
    template_area = float(template.sum())
    if candidate_area <= 0.0 or template_area <= 0.0:
        return 0.0
    dice = (2.0 * intersection) / max(1.0, candidate_area + template_area)
    iou = intersection / max(1.0, union)
    projection_x = projection_similarity(candidate_mask, template_mask, 0)
    projection_y = projection_similarity(candidate_mask, template_mask, 1)
    shape = contour_similarity(candidate_mask, template_mask)
    return clamp01((dice * 0.38) + (iou * 0.24) + (projection_x * 0.16) + (projection_y * 0.16) + (shape * 0.06))


def template_entry(path, label, symbol_type, source):
    image = read_image(path)
    variants = build_mask_variants(image)
    best_mask = None
    best_pixels = -1
    for _, variant_mask in variants:
        bbox = find_union_bbox(variant_mask, symbol_type)
        if not bbox:
            continue
        x, y, w, h = bbox
        tight_mask = variant_mask[y:y + h, x:x + w]
        foreground_pixels = int(np.count_nonzero(tight_mask))
        if foreground_pixels > best_pixels:
            best_mask = tight_mask
            best_pixels = foreground_pixels
    if best_mask is None or best_pixels <= 0:
        return None
    canvas = fit_mask_to_canvas(best_mask, RANK_CANVAS if symbol_type == "rank" else SUIT_CANVAS)
    return {
        "label": label,
        "family": SUIT_FAMILY.get(label) if symbol_type == "suit" else None,
        "source": source,
        "mask": canvas,
    }


def list_template_files(directory):
    if not directory or not os.path.isdir(directory):
        return []
    return sorted(
        str(path)
        for path in Path(directory).iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    )


def load_templates(directory, symbol_type, source):
    templates = []
    for file_path in list_template_files(directory):
        stem = Path(file_path).stem.split("__", 1)[0]
        label = normalize_rank_label(stem) if symbol_type == "rank" else normalize_suit_label(stem)
        if not label:
            continue
        entry = template_entry(file_path, label, symbol_type, source)
        if entry:
            templates.append(entry)
    return templates


def refine_card_region(image, region):
    card_image, clipped = crop_region(image, region)
    hsv = cv2.cvtColor(card_image, cv2.COLOR_BGR2HSV)
    white_mask = ((hsv[:, :, 1] < 80) & (hsv[:, :, 2] > 150)).astype(np.uint8) * 255
    white_mask = clean_mask(white_mask, 3, 2)
    bbox = find_union_bbox(white_mask, "card")
    if not bbox:
        return clipped
    x, y, w, h = bbox
    if w < int(clipped["width"] * 0.55) or h < int(clipped["height"] * 0.55):
        return clipped
    refined = {
        "x": clipped["x"] + max(0, x - 1),
        "y": clipped["y"] + max(0, y - 1),
        "width": min(clipped["width"] - max(0, x - 1), min(clipped["width"], w + 2)),
        "height": min(clipped["height"] - max(0, y - 1), min(clipped["height"], h + 2)),
    }
    return clip_region(refined, image)


def build_symbol_candidates(card_image, base_region, symbol_type, family_hint):
    pad_x = max(3, int(round(base_region["width"] * 0.55)))
    pad_y = max(3, int(round(base_region["height"] * 0.35)))
    search_region = expand_region(base_region, card_image, pad_x, pad_y)
    search_image, absolute_search = crop_region(card_image, search_region)
    candidates = []
    seen = set()
    for variant_name, variant_mask in build_mask_variants(search_image):
        if variant_name == "red" and family_hint == "black" and np.count_nonzero(variant_mask) < 5:
            continue
        bbox = find_union_bbox(variant_mask, symbol_type)
        if not bbox:
            continue
        x, y, w, h = bbox
        tight_mask = variant_mask[y:y + h, x:x + w]
        foreground = int(np.count_nonzero(tight_mask))
        if foreground < 4:
            continue
        signature = (x, y, w, h, foreground)
        if signature in seen:
            continue
        seen.add(signature)
        candidates.append({
            "variant": variant_name,
            "mask": fit_mask_to_canvas(tight_mask, RANK_CANVAS if symbol_type == "rank" else SUIT_CANVAS),
            "bbox": {
                "x": absolute_search["x"] + x,
                "y": absolute_search["y"] + y,
                "width": w,
                "height": h,
            },
            "foreground": foreground,
        })
    if not candidates:
        fallback_gray = cv2.cvtColor(search_image, cv2.COLOR_BGR2GRAY)
        _, fallback_mask = cv2.threshold(fallback_gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        bbox = find_union_bbox(fallback_mask, symbol_type)
        if bbox:
            x, y, w, h = bbox
            tight_mask = fallback_mask[y:y + h, x:x + w]
            candidates.append({
                "variant": "fallback",
                "mask": fit_mask_to_canvas(tight_mask, RANK_CANVAS if symbol_type == "rank" else SUIT_CANVAS),
                "bbox": {
                    "x": absolute_search["x"] + x,
                    "y": absolute_search["y"] + y,
                    "width": w,
                    "height": h,
                },
                "foreground": int(np.count_nonzero(tight_mask)),
            })
    return candidates


def match_symbol(candidates, templates, symbol_type, family_hint):
    scores = {}
    for candidate in candidates:
        for template in templates:
            score = mask_similarity(candidate["mask"], template["mask"])
            if symbol_type == "suit":
                if family_hint and template["family"] == family_hint:
                    score += 0.08
                elif family_hint and template["family"] and template["family"] != family_hint:
                    score *= 0.70
            if template["source"] == "user-template":
                score += 0.04
            elif template["source"] == "builtin-font-template":
                score += 0.02
            if candidate["variant"] == "combined":
                score += 0.02
            score = clamp01(score)
            existing = scores.get(template["label"])
            candidate_result = {
                "label": template["label"],
                "distance": round(1.0 - score, 4),
                "confidence": round(score, 4),
                "source": f"python-opencv-{symbol_type}-{template['source']}",
                "bbox": candidate["bbox"],
            }
            if not existing or candidate_result["confidence"] > existing["confidence"]:
                scores[template["label"]] = candidate_result
    ordered = sorted(scores.values(), key=lambda item: item["confidence"], reverse=True)
    if not ordered:
        return {
            "label": None,
            "distance": 1.0,
            "confidence": 0.0,
            "source": f"python-opencv-{symbol_type}",
            "candidates": [],
        }
    best = ordered[0]
    return {
        "label": best["label"],
        "distance": best["distance"],
        "confidence": best["confidence"],
        "source": best["source"],
        "candidates": [
            {
                "label": item["label"],
                "distance": item["distance"],
                "confidence": item["confidence"],
                "source": item["source"],
            }
            for item in ordered[:6]
        ],
        "bbox": best["bbox"],
    }


def recognize_card(screenshot, config, templates, card_region, card_index):
    refined_card_region = refine_card_region(screenshot, card_region)
    card_image, absolute_card_region = crop_region(screenshot, refined_card_region)
    rank_relative = scale_sub_region(config["rankRegion"], card_region, refined_card_region)
    suit_relative = scale_sub_region(config["suitRegion"], card_region, refined_card_region)
    color_region = {
        "x": min(rank_relative["x"], suit_relative["x"]),
        "y": min(rank_relative["y"], suit_relative["y"]),
        "width": max(rank_relative["x"] + rank_relative["width"], suit_relative["x"] + suit_relative["width"]) - min(rank_relative["x"], suit_relative["x"]),
        "height": max(rank_relative["y"] + rank_relative["height"], suit_relative["y"] + suit_relative["height"]) - min(rank_relative["y"], suit_relative["y"]),
    }
    color_crop_image, _ = crop_region(card_image, expand_region(color_region, card_image, 3, 3))
    family_hint = estimate_color_family(color_crop_image)

    rank_candidates = build_symbol_candidates(card_image, rank_relative, "rank", family_hint)
    suit_candidates = build_symbol_candidates(card_image, suit_relative, "suit", family_hint)
    rank_match = match_symbol(rank_candidates, templates["rank"], "rank", family_hint)
    suit_match = match_symbol(suit_candidates, templates["suit"], "suit", family_hint)

    rank_label = normalize_rank_label(rank_match["label"])
    suit_label = normalize_suit_label(suit_match["label"])
    code = (rank_label + suit_label) if rank_label and suit_label else None
    if not code:
        raise RuntimeError(f"Failed to recognize card {card_index + 1}.")

    return {
        "cardIndex": int(card_index),
        "cardIndexHuman": int(card_index + 1),
        "code": code,
        "rank": rank_label,
        "suit": suit_label,
        "confidence": round(min(rank_match["confidence"], suit_match["confidence"]), 4),
        "cardRegion": absolute_card_region,
        "rankRegion": ensure_region({
            "x": absolute_card_region["x"] + (rank_match.get("bbox") or {
                "x": rank_relative["x"],
                "y": rank_relative["y"],
                "width": rank_relative["width"],
                "height": rank_relative["height"],
            })["x"],
            "y": absolute_card_region["y"] + (rank_match.get("bbox") or {
                "x": rank_relative["x"],
                "y": rank_relative["y"],
                "width": rank_relative["width"],
                "height": rank_relative["height"],
            })["y"],
            "width": (rank_match.get("bbox") or {
                "x": rank_relative["x"],
                "y": rank_relative["y"],
                "width": rank_relative["width"],
                "height": rank_relative["height"],
            })["width"],
            "height": (rank_match.get("bbox") or {
                "x": rank_relative["x"],
                "y": rank_relative["y"],
                "width": rank_relative["width"],
                "height": rank_relative["height"],
            })["height"],
        }),
        "suitRegion": ensure_region({
            "x": absolute_card_region["x"] + (suit_match.get("bbox") or {
                "x": suit_relative["x"],
                "y": suit_relative["y"],
                "width": suit_relative["width"],
                "height": suit_relative["height"],
            })["x"],
            "y": absolute_card_region["y"] + (suit_match.get("bbox") or {
                "x": suit_relative["x"],
                "y": suit_relative["y"],
                "width": suit_relative["width"],
                "height": suit_relative["height"],
            })["y"],
            "width": (suit_match.get("bbox") or {
                "x": suit_relative["x"],
                "y": suit_relative["y"],
                "width": suit_relative["width"],
                "height": suit_relative["height"],
            })["width"],
            "height": (suit_match.get("bbox") or {
                "x": suit_relative["x"],
                "y": suit_relative["y"],
                "width": suit_relative["width"],
                "height": suit_relative["height"],
            })["height"],
        }),
        "rankMatch": {
            "label": rank_label,
            "distance": rank_match["distance"],
            "confidence": rank_match["confidence"],
            "source": rank_match["source"],
            "candidates": rank_match["candidates"],
            "selectedLabel": rank_label,
            "selectedDistance": rank_match["distance"],
            "selectedConfidence": rank_match["confidence"],
        },
        "suitMatch": {
            "label": suit_label,
            "distance": suit_match["distance"],
            "confidence": suit_match["confidence"],
            "source": suit_match["source"],
            "candidates": suit_match["candidates"],
            "selectedLabel": suit_label,
            "selectedDistance": suit_match["distance"],
            "selectedConfidence": suit_match["confidence"],
        },
    }


def build_template_banks(config):
    builtin_root = config.get("builtinFontTemplateRoot")
    rank_templates = []
    suit_templates = []
    rank_templates.extend(load_templates(config.get("rankTemplatesDir"), "rank", "user-template"))
    suit_templates.extend(load_templates(config.get("suitTemplatesDir"), "suit", "user-template"))
    if builtin_root:
        rank_templates.extend(load_templates(os.path.join(builtin_root, "ranks"), "rank", "builtin-font-template"))
        suit_templates.extend(load_templates(os.path.join(builtin_root, "suits"), "suit", "builtin-font-template"))
    if not rank_templates:
        raise RuntimeError("No rank templates available for OpenCV recognition.")
    if not suit_templates:
        raise RuntimeError("No suit templates available for OpenCV recognition.")
    return {"rank": rank_templates, "suit": suit_templates}


def recognize_payload(payload):
    config = payload["config"]
    screenshot = read_image(payload["screenshotPath"])
    templates = build_template_banks(config)
    cards = []
    for index, card_region in enumerate(config["cardRegions"]):
        cards.append(recognize_card(screenshot, config, templates, ensure_region(card_region), index))
    return {
        "cards": cards,
        "recognitionMode": "python-opencv",
        "availableModes": {
            "pythonOpenCv": True,
            "template": len(templates["rank"]) > 0 and len(templates["suit"]) > 0,
            "builtin": True,
            "cardTemplate": os.path.isdir(config.get("cardTemplatesDir") or "") and len(list_template_files(config.get("cardTemplatesDir"))) > 0,
        },
        "matchingStrategies": {
            "componentNormalization": True,
            "colorAwareMask": True,
            "userTemplate": any(item["source"] == "user-template" for item in templates["rank"] + templates["suit"]),
            "builtinFontTemplate": any(item["source"] == "builtin-font-template" for item in templates["rank"] + templates["suit"]),
            "spatialRefine": True,
            "contourAssist": True,
        },
        "fallbackReason": None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()
    payload = read_text_json(args.payload)
    result = recognize_payload(payload)
    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
