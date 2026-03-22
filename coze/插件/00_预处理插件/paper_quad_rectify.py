#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def order_points(points):
    pts = np.asarray(points, dtype=np.float32)
    sums = pts.sum(axis=1)
    diffs = pts[:, 0] - pts[:, 1]
    return np.array([
        pts[np.argmin(sums)],
        pts[np.argmax(diffs)],
        pts[np.argmax(sums)],
        pts[np.argmin(diffs)]
    ], dtype=np.float32)


def side_lengths(points):
    pts = order_points(points).astype(np.float64)
    width_top = np.linalg.norm(pts[1] - pts[0])
    width_bottom = np.linalg.norm(pts[2] - pts[3])
    height_right = np.linalg.norm(pts[2] - pts[1])
    height_left = np.linalg.norm(pts[3] - pts[0])
    return width_top, width_bottom, height_right, height_left


def find_perspective_coeffs(src, dst):
    matrix = []
    vector = []
    for (x_src, y_src), (x_dst, y_dst) in zip(src, dst):
        matrix.append([x_dst, y_dst, 1, 0, 0, 0, -x_src * x_dst, -x_src * y_dst])
        matrix.append([0, 0, 0, x_dst, y_dst, 1, -y_src * x_dst, -y_src * y_dst])
        vector.append(x_src)
        vector.append(y_src)
    coeffs = np.linalg.solve(np.asarray(matrix, dtype=np.float64), np.asarray(vector, dtype=np.float64))
    return coeffs.tolist()


def rectify_paper(image_path, corners, output_path):
    image = Image.open(image_path).convert("RGB")
    ordered = order_points(corners)
    width_top, width_bottom, height_right, height_left = side_lengths(ordered)
    target_width = max(1, int(round((width_top + width_bottom) / 2.0)))
    target_height = max(1, int(round((height_left + height_right) / 2.0)))

    destination = np.array([
        [0, 0],
        [target_width - 1, 0],
        [target_width - 1, target_height - 1],
        [0, target_height - 1]
    ], dtype=np.float32)
    coeffs = find_perspective_coeffs(ordered, destination)
    warped = image.transform(
        (target_width, target_height),
        Image.Transform.PERSPECTIVE,
        coeffs,
        Image.Resampling.BICUBIC
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    warped.save(output_path)
    return {
        "orderedCorners": ordered.tolist(),
        "targetWidth": target_width,
        "targetHeight": target_height,
        "sourceTopWidth": float(width_top),
        "sourceBottomWidth": float(width_bottom),
        "sourceLeftHeight": float(height_left),
        "sourceRightHeight": float(height_right)
    }


def main():
    parser = argparse.ArgumentParser(description="Rectify paper quadrilateral into a rectangle.")
    parser.add_argument("--image", required=True)
    parser.add_argument("--corners-json", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--meta-output", default="")
    args = parser.parse_args()

    corners = json.loads(args.corners_json)
    if not isinstance(corners, list) or len(corners) != 4:
      raise ValueError("corners-json 必须是四个点的数组")

    meta = rectify_paper(Path(args.image), corners, Path(args.output))
    if args.meta_output:
        meta_path = Path(args.meta_output)
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
