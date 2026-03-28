import json
import os
import sys
import traceback
import inspect

import numpy as np


def load_manifest(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def ensure_bgr_image(image):
    import cv2

    if image is None:
        return None
    if len(image.shape) == 3 and image.shape[2] == 4:
        alpha = image[:, :, 3:4].astype("float32") / 255.0
        bgr = image[:, :, :3].astype("float32")
        white = 255.0 * (1.0 - alpha)
        return (bgr * alpha + white).clip(0, 255).astype("uint8")
    if len(image.shape) == 2:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    return image


def create_ocr(config):
    from paddleocr import PaddleOCR

    params = inspect.signature(PaddleOCR).parameters
    kwargs = {}

    if "lang" in params:
        kwargs["lang"] = config.get("lang", "ch")
    if "use_angle_cls" in params:
        kwargs["use_angle_cls"] = bool(config.get("use_angle_cls", True))
    elif "use_textline_orientation" in params:
        kwargs["use_textline_orientation"] = bool(config.get("use_angle_cls", True))
    if "show_log" in params:
        kwargs["show_log"] = bool(config.get("show_log", False))

    return PaddleOCR(**kwargs)


def extract_best_text(result):
    if not result:
        return None, 0.0
    if isinstance(result, (list, tuple)) and len(result) >= 2 and isinstance(result[0], str):
        return (str(result[0]).strip() or None), float(result[1] if len(result) > 1 else 0.0)
    first = result[0] if isinstance(result, list) and result else None
    if not first:
        return None, 0.0
    if isinstance(first, (list, tuple)) and len(first) >= 2 and isinstance(first[0], str):
        return (str(first[0]).strip() or None), float(first[1] if len(first) > 1 else 0.0)
    if isinstance(first, dict):
        rec_texts = first.get("rec_texts") or []
        rec_scores = first.get("rec_scores") or []
        if rec_texts:
            return (str(rec_texts[0]).strip() or None), float(rec_scores[0] if rec_scores else 0.0)
    if isinstance(first, list) and first:
        entry = first[0]
        if isinstance(entry, list) and len(entry) >= 2 and isinstance(entry[1], (list, tuple)) and len(entry[1]) >= 2:
            text = str(entry[1][0]).strip() or None
            score = float(entry[1][1])
            return text, score
    return None, 0.0


def is_cjk_char(value):
    if not value or len(value) != 1:
        return False
    code = ord(value)
    return (
        0x3400 <= code <= 0x4DBF or
        0x4E00 <= code <= 0x9FFF or
        0xF900 <= code <= 0xFAFF
    )


def is_ascii_alnum_char(value):
    return bool(value) and len(value) == 1 and value.isascii() and value.isalnum()


def normalize_recognized_text(text):
    if text is None:
        return None
    stripped = str(text).strip()
    if not stripped:
        return None
    return stripped[0] if len(stripped) == 1 else stripped


def to_gray(image):
    import cv2

    if image is None:
        return None
    if len(image.shape) == 2:
        return image
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def crop_to_content(gray, threshold=245):
    import cv2

    if gray is None:
        return None
    _, binary = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY_INV)
    points = cv2.findNonZero(binary)
    if points is None:
        return gray
    x, y, w, h = cv2.boundingRect(points)
    margin = max(2, int(round(min(gray.shape[:2]) * 0.04)))
    left = max(0, x - margin)
    top = max(0, y - margin)
    right = min(gray.shape[1], x + w + margin)
    bottom = min(gray.shape[0], y + h + margin)
    return gray[top:bottom, left:right]


def normalize_to_canvas(gray, target_size):
    import cv2

    if gray is None:
        return None
    src_h, src_w = gray.shape[:2]
    if src_h <= 0 or src_w <= 0:
        return gray
    canvas = np.full((target_size, target_size), 255, dtype="uint8")
    inner_size = max(8, int(round(target_size * 0.8)))
    scale = min(inner_size / float(src_w), inner_size / float(src_h))
    resized_w = max(1, int(round(src_w * scale)))
    resized_h = max(1, int(round(src_h * scale)))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    resized = cv2.resize(gray, (resized_w, resized_h), interpolation=interpolation)
    offset_x = (target_size - resized_w) // 2
    offset_y = (target_size - resized_h) // 2
    canvas[offset_y:offset_y + resized_h, offset_x:offset_x + resized_w] = resized
    return canvas


def build_variants(image, preprocess_config):
    import cv2

    if image is None:
        return []

    gray = to_gray(image)
    variants = []

    if not preprocess_config.get("enabled", True):
        return [{"name": "original-bgr", "image": ensure_bgr_image(image)}]

    working = gray
    if preprocess_config.get("crop_to_content", True):
        working = crop_to_content(working)
    target_size = int(preprocess_config.get("target_size", 96) or 96)
    normalized = normalize_to_canvas(working, target_size)

    if preprocess_config.get("try_original", True):
        variants.append({
            "name": "normalized-gray",
            "image": ensure_bgr_image(normalized),
        })

    if preprocess_config.get("binarize", True) and preprocess_config.get("try_otsu", True):
        _, otsu = cv2.threshold(normalized, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        variants.append({
            "name": "normalized-otsu",
            "image": ensure_bgr_image(otsu),
        })

    variants.append({
        "name": "original-bgr",
        "image": ensure_bgr_image(image),
    })
    return variants


def score_candidate(candidate, target_char):
    text = candidate.get("text")
    confidence = float(candidate.get("confidence") or 0.0)
    if not text:
        return -1.0
    bonus = 0.0
    if target_char and text == target_char:
        bonus += 0.35
    length_penalty = max(0, len(text.strip()) - 1) * 0.12
    return confidence + bonus - length_penalty


def accept_candidate_text(text, confidence, target_char, config):
    normalized = normalize_recognized_text(text)
    if not normalized:
        return None

    recognition_config = config.get("recognition") or {}
    reject_non_cjk_ascii = recognition_config.get("reject_non_cjk_ascii", True)

    if len(normalized) > 1:
        if target_char and target_char in normalized:
            return target_char
        return None

    if not target_char:
        if reject_non_cjk_ascii and is_ascii_alnum_char(normalized) and confidence < 0.92:
            return None
        return normalized

    target_char = str(target_char).strip() or None
    if not target_char:
        return normalized
    if normalized == target_char:
        return normalized

    if is_cjk_char(target_char):
        if reject_non_cjk_ascii and is_ascii_alnum_char(normalized):
            return None
        if not is_cjk_char(normalized) and confidence < 0.95:
            return None
        if confidence < 0.45:
            return None

    return normalized


def run_ocr_pass(ocr, image, config, mode_name):
    recognition_config = config.get("recognition") or {}
    use_angle_cls = bool(config.get("use_angle_cls", True))
    if mode_name == "rec-only":
        try:
            raw = ocr.ocr(image, det=False, rec=True, cls=use_angle_cls)
        except TypeError:
            raw = ocr.ocr(image, cls=use_angle_cls)
    else:
        raw = ocr.ocr(image, cls=use_angle_cls)
    return raw


def recognize_best_variant(ocr, image, target_char, config):
    variants = build_variants(image, config.get("preprocess") or {})
    candidates = []
    recognition_config = config.get("recognition") or {}
    modes = ["rec-only", "det+rec"] if recognition_config.get("single_char_mode", True) and recognition_config.get("prefer_rec_only", True) else ["det+rec"]
    if recognition_config.get("single_char_mode", True) and "rec-only" not in modes:
        modes.append("rec-only")

    for variant in variants:
        for mode_name in modes:
            try:
                raw = run_ocr_pass(ocr, variant["image"], config, mode_name)
                text, confidence = extract_best_text(raw)
                accepted_text = accept_candidate_text(text, float(confidence or 0.0), target_char, config)
                candidates.append({
                    "variant": variant["name"],
                    "mode": mode_name,
                    "text": accepted_text,
                    "raw_text": normalize_recognized_text(text),
                    "confidence": float(confidence or 0.0),
                })
            except Exception as exc:
                candidates.append({
                    "variant": variant["name"],
                    "mode": mode_name,
                    "text": None,
                    "raw_text": None,
                    "confidence": 0.0,
                    "error": str(exc),
                })

    best = None
    best_score = -1.0
    for candidate in candidates:
        candidate_score = score_candidate(candidate, target_char)
        if candidate_score > best_score:
            best = candidate
            best_score = candidate_score

    return best or {"variant": None, "text": None, "confidence": 0.0}, candidates


def main():
    if len(sys.argv) < 2:
        raise SystemExit("manifest path is required")

    manifest_path = sys.argv[1]
    manifest = load_manifest(manifest_path)
    config = manifest.get("config", {})
    confidence_threshold = float(config.get("confidence_threshold", 0.5))
    ocr = create_ocr(config)

    import cv2

    results = []
    for item in manifest.get("cells", []):
        image_path = item.get("image_path")
        cell_id = item.get("cell_id")
        row = item.get("row")
        col = item.get("col")
        target_char = item.get("target_char")

        if not image_path or not os.path.exists(image_path):
            results.append({
                "cell_id": cell_id,
                "row": row,
                "col": col,
                "target_char": target_char,
                "recognized_char": None,
                "confidence": 0.0,
                "status": "missing-image",
            })
            continue

        image = cv2.imread(image_path, cv2.IMREAD_UNCHANGED)
        image = ensure_bgr_image(image)
        if image is None:
            results.append({
                "cell_id": cell_id,
                "row": row,
                "col": col,
                "target_char": target_char,
                "recognized_char": None,
                "confidence": 0.0,
                "status": "decode-failed",
            })
            continue

        try:
            best, candidates = recognize_best_variant(ocr, image, target_char, config)
            text = best.get("text")
            confidence = float(best.get("confidence") or 0.0)
            accepted = text if text and confidence >= confidence_threshold else None
            results.append({
                "cell_id": cell_id,
                "row": row,
                "col": col,
                "target_char": target_char,
                "recognized_char": accepted,
                "raw_text": text,
                "confidence": confidence,
                "variant": best.get("variant"),
                "mode": best.get("mode"),
                "candidates": candidates,
                "status": "recognized" if accepted else "low-confidence",
            })
        except Exception as exc:
            results.append({
                "cell_id": cell_id,
                "row": row,
                "col": col,
                "target_char": target_char,
                "recognized_char": None,
                "confidence": 0.0,
                "status": "ocr-error",
                "error": str(exc),
            })

    payload = {
        "supported": True,
        "engine": "PaddleOCR",
        "config": {
            "lang": config.get("lang", "ch"),
            "use_angle_cls": bool(config.get("use_angle_cls", True)),
            "confidence_threshold": confidence_threshold,
            "preprocess": config.get("preprocess", {}),
            "recognition": config.get("recognition", {}),
        },
        "runtime": {
            "python_executable": sys.executable,
            "python_version": sys.version.split()[0],
            "python_no_user_site": os.environ.get("PYTHONNOUSERSITE") == "1",
        },
        "results": results,
    }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({
            "supported": False,
            "engine": "PaddleOCR",
            "error": str(exc),
            "runtime": {
                "python_executable": sys.executable,
                "python_version": sys.version.split()[0],
                "python_no_user_site": os.environ.get("PYTHONNOUSERSITE") == "1",
            },
            "traceback": traceback.format_exc(),
        }, ensure_ascii=False))
        raise
