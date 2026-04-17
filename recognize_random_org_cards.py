from __future__ import annotations

import argparse
import re
import time
import urllib.request
from dataclasses import dataclass
from html import unescape
from pathlib import Path

import cv2
import numpy as np


CARD_WIDTH = 72
CARD_HEIGHT = 96
DEFAULT_TEMPLATES_DIR = Path(__file__).with_name('random_org_templates')
DRAW_52_URL = (
    'https://www.random.org/playing-cards/'
    '?cards=52&decks=1&spades=on&hearts=on&diamonds=on&clubs=on'
    '&aces=on&twos=on&threes=on&fours=on&fives=on&sixes=on&sevens=on'
    '&eights=on&nines=on&tens=on&jacks=on&queens=on&kings=on'
)
IMAGE_PATTERN = re.compile(r'<img src="([^"]+)" width="72" height="96" alt="([^"]+)"')
RANK_MAP = {
    'Ace': 'A',
    'Two': '2',
    'Three': '3',
    'Four': '4',
    'Five': '5',
    'Six': '6',
    'Seven': '7',
    'Eight': '8',
    'Nine': '9',
    'Ten': '10',
    'Jack': 'J',
    'Queen': 'Q',
    'King': 'K',
}
SUIT_MAP = {'Spades': 'S', 'Hearts': 'H', 'Diamonds': 'D', 'Clubs': 'C'}


@dataclass
class DetectedCard:
    contour: np.ndarray
    corners: np.ndarray
    warped: np.ndarray
    center_x: float


@dataclass
class RecognizedCard:
    label: str
    score: float
    card: DetectedCard


def card_code_from_name(card_name: str) -> str:
    rank_name, suit_name = card_name.split(' of ')
    return RANK_MAP[rank_name] + SUIT_MAP[suit_name]


def fetch_url(url: str, retries: int = 5) -> bytes:
    headers = {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.random.org/playing-cards/',
    }
    last_error: Exception | None = None
    for attempt in range(retries):
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.read()
        except Exception as error:
            last_error = error
            time.sleep(1 + attempt)
    raise RuntimeError(f'Failed to fetch {url}') from last_error


def bootstrap_random_org_templates(templates_dir: Path) -> int:
    templates_dir.mkdir(parents=True, exist_ok=True)
    html = fetch_url(DRAW_52_URL).decode('utf-8', errors='replace')
    matches = IMAGE_PATTERN.findall(html)
    if len(matches) < 52:
        raise RuntimeError(f'Expected 52 card images, found {len(matches)}')

    unique_count = 0
    for src, alt in matches:
        label = card_code_from_name(unescape(alt))
        output_path = templates_dir / f'{label}.png'
        if output_path.exists():
            continue
        image_url = 'https://www.random.org/playing-cards/' + src
        output_path.write_bytes(fetch_url(image_url))
        unique_count += 1
    return unique_count


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
    destination = np.array(
        [[0, 0], [CARD_WIDTH - 1, 0], [CARD_WIDTH - 1, CARD_HEIGHT - 1], [0, CARD_HEIGHT - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(ordered, destination)
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
        if area < image_area * 0.02:
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
        if w < 40 or h < 60:
            continue
        if any(abs(x - sx) < 6 and abs(y - sy) < 6 and abs(w - sw) < 6 and abs(h - sh) < 6 for sx, sy, sw, sh in seen_boxes):
            continue
        seen_boxes.append((x, y, w, h))

        warped = warp_card(image, corners)
        center_x = float(np.mean(corners[:, 0]))
        candidates.append(DetectedCard(contour=contour, corners=corners, warped=warped, center_x=center_x))

    candidates.sort(key=lambda card: card.center_x)
    candidate_boxes = [cv2.boundingRect(card.contour) for card in candidates]
    filtered: list[DetectedCard] = []
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
            filtered.append(card)
    return filtered


def load_templates(templates_dir: Path) -> dict[str, np.ndarray]:
    templates: dict[str, np.ndarray] = {}
    for path in sorted(templates_dir.glob('*.png')):
        image = cv2.imread(str(path))
        if image is None:
            continue
        templates[path.stem.upper()] = image
    if not templates:
        raise FileNotFoundError(f'No templates found in {templates_dir}')
    return templates


def card_score(card_image: np.ndarray, template_image: np.ndarray) -> float:
    card_resized = cv2.resize(card_image, (CARD_WIDTH, CARD_HEIGHT), interpolation=cv2.INTER_AREA)
    card_inner = card_resized[2:CARD_HEIGHT - 2, 2:CARD_WIDTH - 2]
    template_inner = template_image[2:CARD_HEIGHT - 2, 2:CARD_WIDTH - 2]

    color_score = float(np.mean(cv2.absdiff(card_inner, template_inner)))
    card_gray = cv2.cvtColor(card_inner, cv2.COLOR_BGR2GRAY)
    template_gray = cv2.cvtColor(template_inner, cv2.COLOR_BGR2GRAY)
    gray_score = float(np.mean(cv2.absdiff(card_gray, template_gray)))
    return 0.7 * color_score + 0.3 * gray_score


def recognize_cards(cards: list[DetectedCard], templates: dict[str, np.ndarray]) -> list[RecognizedCard]:
    recognized: list[RecognizedCard] = []
    for card in cards:
        best_label = ''
        best_score = float('inf')
        for label, template_image in templates.items():
            score = card_score(card.warped, template_image)
            if score < best_score:
                best_score = score
                best_label = label
        recognized.append(RecognizedCard(label=best_label, score=best_score, card=card))
    return recognized


def draw_debug(image: np.ndarray, results: list[RecognizedCard]) -> np.ndarray:
    debug = image.copy()
    for result in results:
        corners = order_points(result.card.corners).astype(int)
        cv2.polylines(debug, [corners], True, (0, 255, 0), 2)
        anchor = tuple(corners[0])
        text = f'{result.label} {result.score:.1f}'
        cv2.putText(debug, text, (anchor[0], max(24, anchor[1] - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 120, 255), 2)
    return debug


def solve(image_path: str, templates_dir: str = str(DEFAULT_TEMPLATES_DIR)) -> list[str]:
    templates = load_templates(Path(templates_dir))
    image = cv2.imread(image_path)
    if image is None:
        raise FileNotFoundError(f'Unable to read image: {image_path}')
    cards = detect_cards(image)
    if not cards:
        raise RuntimeError('No cards detected in the screenshot')
    results = recognize_cards(cards, templates)
    return [result.label for result in results]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Recognize RANDOM.ORG playing-card screenshots using exact template matching.')
    parser.add_argument('image', nargs='?', help='Path to the screenshot image')
    parser.add_argument('--templates-dir', default=str(DEFAULT_TEMPLATES_DIR), help='Directory containing 52 card templates')
    parser.add_argument('--bootstrap-templates', action='store_true', help='Download the full RANDOM.ORG 52-card template set')
    parser.add_argument('--debug-out', help='Optional path to save an annotated image')
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    templates_dir = Path(args.templates_dir)

    if args.bootstrap_templates:
        downloaded = bootstrap_random_org_templates(templates_dir)
        print(f'Templates ready in {templates_dir} ({downloaded} new downloads)')
        if not args.image:
            return

    if not args.image:
        raise ValueError('image is required unless only using --bootstrap-templates')

    templates = load_templates(templates_dir)
    image = cv2.imread(args.image)
    if image is None:
        raise FileNotFoundError(f'Unable to read image: {args.image}')

    cards = detect_cards(image)
    if not cards:
        raise RuntimeError('No cards detected in the screenshot')

    results = recognize_cards(cards, templates)
    print(' '.join(result.label for result in results))

    if args.debug_out:
        debug_image = draw_debug(image, results)
        cv2.imwrite(args.debug_out, debug_image)
        print(f'Debug image saved to: {args.debug_out}')


if __name__ == '__main__':
    main()
