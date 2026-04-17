from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np


CARD_WIDTH = 200
CARD_HEIGHT = 300
CORNER_WIDTH = 45
CORNER_HEIGHT = 112
RANK_REGION = (0, 0, 60, 68)
SUIT_REGION = (0, 46, 60, 108)
RANK_CANVAS = (80, 120)
SUIT_CANVAS = (80, 80)


@dataclass
class DetectedCard:
    contour: np.ndarray
    corners: np.ndarray
    warped: np.ndarray
    center_x: float


def order_points(points: np.ndarray) -> np.ndarray:
    pts = points.astype(np.float32)
    sums = pts.sum(axis=1)
    diffs = np.diff(pts, axis=1).reshape(-1)

    top_left = pts[np.argmin(sums)]
    bottom_right = pts[np.argmax(sums)]
    top_right = pts[np.argmin(diffs)]
    bottom_left = pts[np.argmax(diffs)]
    return np.array([top_left, top_right, bottom_right, bottom_left], dtype=np.float32)


def warp_card(image: np.ndarray, corners: np.ndarray) -> np.ndarray:
    ordered = order_points(corners)
    dst = np.array(
        [[0, 0], [CARD_WIDTH - 1, 0], [CARD_WIDTH - 1, CARD_HEIGHT - 1], [0, CARD_HEIGHT - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(ordered, dst)
    return cv2.warpPerspective(image, matrix, (CARD_WIDTH, CARD_HEIGHT))


def box_is_contained(inner: tuple[int, int, int, int], outer: tuple[int, int, int, int], margin: int = 4) -> bool:
    inner_x, inner_y, inner_width, inner_height = inner
    outer_x, outer_y, outer_width, outer_height = outer
    return (
        inner_x >= outer_x - margin
        and inner_y >= outer_y - margin
        and inner_x + inner_width <= outer_x + outer_width + margin
        and inner_y + inner_height <= outer_y + outer_height + margin
    )


def detect_cards(image: np.ndarray) -> list[DetectedCard]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)

    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    image_area = image.shape[0] * image.shape[1]
    candidates: list[DetectedCard] = []
    seen_boxes: list[tuple[int, int, int, int]] = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < image_area * 0.04:
            continue

        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
        if len(approx) == 4:
            corners = approx.reshape(4, 2)
        else:
            rect = cv2.minAreaRect(contour)
            corners = cv2.boxPoints(rect)

        rect = cv2.minAreaRect(contour)
        width, height = rect[1]
        if width == 0 or height == 0:
            continue

        ratio = min(width, height) / max(width, height)
        if not 0.55 <= ratio <= 0.82:
            continue

        x, y, w, h = cv2.boundingRect(contour)
        if w < 60 or h < 90:
            continue
        if any(abs(x - sx) < 6 and abs(y - sy) < 6 and abs(w - sw) < 6 and abs(h - sh) < 6 for sx, sy, sw, sh in seen_boxes):
            continue
        seen_boxes.append((x, y, w, h))

        warped = warp_card(image, corners)
        center_x = float(np.mean(corners[:, 0]))
        candidates.append(DetectedCard(contour=contour, corners=corners, warped=warped, center_x=center_x))

    candidates.sort(key=lambda card: card.center_x)

    filtered_candidates: list[DetectedCard] = []
    candidate_boxes = [cv2.boundingRect(card.contour) for card in candidates]
    for index, card in enumerate(candidates):
        box = candidate_boxes[index]
        box_area = box[2] * box[3]
        is_nested = any(
            other_index != index
            and box_area < candidate_boxes[other_index][2] * candidate_boxes[other_index][3]
            and box_is_contained(box, candidate_boxes[other_index])
            for other_index in range(len(candidates))
        )
        if not is_nested:
            filtered_candidates.append(card)

    return filtered_candidates


def parse_label(label: str) -> tuple[str, str]:
    normalized = label.strip().upper()
    if len(normalized) < 2:
        raise ValueError(f"Invalid card label: {label}")

    suit = normalized[-1]
    rank = normalized[:-1]
    valid_suits = {"S", "H", "D", "C"}
    valid_ranks = {"A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"}
    if suit not in valid_suits or rank not in valid_ranks:
        raise ValueError(f"Invalid card label: {label}")
    return rank, suit


def crop_nonzero(binary: np.ndarray) -> np.ndarray:
    points = cv2.findNonZero(binary)
    if points is None:
        raise RuntimeError("No foreground pixels found in symbol crop")
    x, y, w, h = cv2.boundingRect(points)
    return binary[y : y + h, x : x + w]


def keep_rank_components(rank_region: np.ndarray) -> np.ndarray:
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(rank_region, 8)
    filtered = np.zeros_like(rank_region)
    for index in range(1, component_count):
        x, y, width, height, area = stats[index]
        if area < 20:
            continue
        if x < 12 and y < 20 and (width > 25 or height > 30):
            continue
        filtered[labels == index] = 255
    if cv2.countNonZero(filtered) == 0:
        return rank_region
    return filtered


def keep_suit_components(suit_region: np.ndarray) -> np.ndarray:
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(suit_region, 8)
    filtered = np.zeros_like(suit_region)
    for index in range(1, component_count):
        x, y, width, height, area = stats[index]
        if area < 20:
            continue
        if x < 12 and width < 8 and height > 35:
            continue
        filtered[labels == index] = 255
    if cv2.countNonZero(filtered) == 0:
        return suit_region
    return filtered


def fit_symbol_to_canvas(binary: np.ndarray, canvas_size: tuple[int, int]) -> np.ndarray:
    cropped = crop_nonzero(binary)
    canvas_width, canvas_height = canvas_size
    max_width = max(1, canvas_width - 8)
    max_height = max(1, canvas_height - 8)

    height, width = cropped.shape[:2]
    scale = min(max_width / width, max_height / height)
    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))
    resized = cv2.resize(cropped, (resized_width, resized_height), interpolation=cv2.INTER_NEAREST)

    canvas = np.zeros((canvas_height, canvas_width), dtype=np.uint8)
    x_offset = (canvas_width - resized_width) // 2
    y_offset = (canvas_height - resized_height) // 2
    canvas[y_offset : y_offset + resized_height, x_offset : x_offset + resized_width] = resized
    return canvas


def extract_corner_binary(card_image: np.ndarray) -> np.ndarray:
    resized = cv2.resize(card_image, (CARD_WIDTH, CARD_HEIGHT), interpolation=cv2.INTER_AREA)
    corner = resized[0:CORNER_HEIGHT, 0:CORNER_WIDTH]
    gray = cv2.cvtColor(corner, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    kernel = np.ones((2, 2), dtype=np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=1)
    binary[0:6, :] = 0
    binary[:, 0:6] = 0
    return binary


def extract_rank_and_suit(card_image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    corner_binary = extract_corner_binary(card_image)

    rank_region = corner_binary[0:52, :]
    suit_region = corner_binary[40:CORNER_HEIGHT, :]

    rank_region = keep_rank_components(rank_region)
    suit_region = keep_suit_components(suit_region)

    rank_symbol = fit_symbol_to_canvas(rank_region, RANK_CANVAS)
    suit_symbol = fit_symbol_to_canvas(suit_region, SUIT_CANVAS)
    return rank_symbol, suit_symbol


def score_symbol(candidate: np.ndarray, template: np.ndarray) -> float:
    diff = cv2.absdiff(candidate, template)
    return float(np.mean(diff))


def load_symbol_templates(templates_dir: Path, canvas_size: tuple[int, int]) -> dict[str, np.ndarray]:
    templates: dict[str, np.ndarray] = {}
    for path in sorted(templates_dir.glob("*.png")):
        image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if image is None:
            continue
        if image.shape != (canvas_size[1], canvas_size[0]):
            image = cv2.resize(image, canvas_size, interpolation=cv2.INTER_NEAREST)
        templates[path.stem.upper()] = image
    return templates


def load_templates(templates_root: Path) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    rank_templates = load_symbol_templates(templates_root / "ranks", RANK_CANVAS)
    suit_templates = load_symbol_templates(templates_root / "suits", SUIT_CANVAS)
    if not rank_templates:
        raise FileNotFoundError(f"No rank template images found in {templates_root / 'ranks'}")
    if not suit_templates:
        raise FileNotFoundError(f"No suit template images found in {templates_root / 'suits'}")
    return rank_templates, suit_templates


def match_symbol(symbol: np.ndarray, templates: dict[str, np.ndarray]) -> tuple[str, float]:
    best_label = ""
    best_score = float("inf")
    for label, template in templates.items():
        score = score_symbol(symbol, template)
        if score < best_score:
            best_label = label
            best_score = score
    return best_label, best_score


def recognize_cards(
    cards: Iterable[DetectedCard],
    rank_templates: dict[str, np.ndarray],
    suit_templates: dict[str, np.ndarray],
) -> list[tuple[str, float]]:
    results: list[tuple[str, float]] = []
    for card in cards:
        rank_symbol, suit_symbol = extract_rank_and_suit(card.warped)
        rank_label, rank_score = match_symbol(rank_symbol, rank_templates)
        suit_label, suit_score = match_symbol(suit_symbol, suit_templates)
        results.append((f"{rank_label}{suit_label}", rank_score + suit_score))
    return results


def save_template(cards: list[DetectedCard], card_index: int, label: str, templates_root: Path) -> list[Path]:
    if card_index < 0 or card_index >= len(cards):
        raise IndexError(f"Card index {card_index} out of range; detected {len(cards)} cards")

    rank_label, suit_label = parse_label(label)
    rank_symbol, suit_symbol = extract_rank_and_suit(cards[card_index].warped)

    rank_dir = templates_root / "ranks"
    suit_dir = templates_root / "suits"
    cards_dir = templates_root / "cards"
    rank_dir.mkdir(parents=True, exist_ok=True)
    suit_dir.mkdir(parents=True, exist_ok=True)
    cards_dir.mkdir(parents=True, exist_ok=True)

    rank_path = rank_dir / f"{rank_label}.png"
    suit_path = suit_dir / f"{suit_label}.png"
    card_path = cards_dir / f"{label.upper()}.png"
    cv2.imwrite(str(rank_path), rank_symbol)
    cv2.imwrite(str(suit_path), suit_symbol)
    cv2.imwrite(str(card_path), cards[card_index].warped)
    return [rank_path, suit_path, card_path]


def draw_debug(image: np.ndarray, cards: list[DetectedCard], labels: list[str]) -> np.ndarray:
    debug = image.copy()
    for card, label in zip(cards, labels):
        corners = order_points(card.corners).astype(int)
        cv2.polylines(debug, [corners], True, (0, 255, 0), 2)
        anchor = tuple(corners[0])
        cv2.putText(debug, label, (anchor[0], max(24, anchor[1] - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 120, 255), 2)
    return debug


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Lightweight playing-card recognizer for fixed-style screenshots.")
    parser.add_argument("image", help="Path to the screenshot image")
    parser.add_argument("--templates-dir", default="templates", help="Directory that contains rank/suit template images")
    parser.add_argument("--save-card-index", type=int, help="Save one detected card as templates by index")
    parser.add_argument("--label", help="Card label when using --save-card-index, for example 7H or JS")
    parser.add_argument("--debug-out", help="Optional path to save an annotated debug image")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    image_path = Path(args.image)
    templates_dir = Path(args.templates_dir)

    image = cv2.imread(str(image_path))
    if image is None:
        raise FileNotFoundError(f"Unable to read image: {image_path}")

    cards = detect_cards(image)
    if not cards:
        raise RuntimeError("No cards detected in the screenshot")

    if args.save_card_index is not None:
        if not args.label:
            raise ValueError("--label is required when using --save-card-index")
        output_paths = save_template(cards, args.save_card_index, args.label, templates_dir)
        for output_path in output_paths:
            print(f"Saved template: {output_path}")
        return

    rank_templates, suit_templates = load_templates(templates_dir)
    results = recognize_cards(cards, rank_templates, suit_templates)
    labels = [label for label, _ in results]
    print(" ".join(labels))

    if args.debug_out:
        debug_image = draw_debug(image, cards, labels)
        cv2.imwrite(args.debug_out, debug_image)
        print(f"Debug image saved to: {args.debug_out}")


if __name__ == "__main__":
    main()
