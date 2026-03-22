#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def order_points(points):
    pts = np.asarray(points, dtype=np.float32)
    s = pts.sum(axis=1)
    d = pts[:, 0] - pts[:, 1]
    return np.array([
        pts[np.argmin(s)],
        pts[np.argmax(d)],
        pts[np.argmax(s)],
        pts[np.argmin(d)]
    ], dtype=np.float32)


def fit_line(points):
    pts = np.asarray(points, dtype=np.float64)
    center = pts.mean(axis=0)
    centered = pts - center
    _, _, vh = np.linalg.svd(centered, full_matrices=False)
    direction = vh[0]
    normal = np.array([-direction[1], direction[0]], dtype=np.float64)
    c = -float(np.dot(normal, center))
    return np.array([normal[0], normal[1], c], dtype=np.float64)


def intersect_lines(line_a, line_b):
    a1, b1, c1 = line_a
    a2, b2, c2 = line_b
    matrix = np.array([[a1, b1], [a2, b2]], dtype=np.float64)
    vector = np.array([-c1, -c2], dtype=np.float64)
    det = np.linalg.det(matrix)
    if abs(det) < 1e-6:
      return None
    return np.linalg.solve(matrix, vector)


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


def robust_fit(points):
    pts = np.asarray(points, dtype=np.float32)
    if pts.shape[0] < 12:
        return None
    line = fit_line(pts)
    for _ in range(2):
        distances = np.abs(line[0] * pts[:, 0] + line[1] * pts[:, 1] + line[2]) / max(
            1e-6, np.hypot(line[0], line[1])
        )
        keep_threshold = max(2.5, np.percentile(distances, 80))
        filtered = pts[distances <= keep_threshold]
        if filtered.shape[0] < 10:
            break
        line = fit_line(filtered)
        pts = filtered
    return line


def smooth_profile(profile, radius=5):
    values = np.asarray(profile, dtype=np.float32)
    if radius <= 0 or values.size == 0:
        return values
    kernel = np.ones(radius * 2 + 1, dtype=np.float32)
    kernel /= kernel.sum()
    return np.convolve(values, kernel, mode="same")


def detect_profile_peaks(profile, min_distance, min_value):
    peaks = []
    values = np.asarray(profile, dtype=np.float32)
    for index in range(1, len(values) - 1):
        if values[index] < min_value:
            continue
        if values[index] < values[index - 1] or values[index] < values[index + 1]:
            continue
        if peaks and index - peaks[-1] < min_distance:
            if values[index] > values[peaks[-1]]:
                peaks[-1] = index
            continue
        peaks.append(index)
    return peaks


def choose_outermost_peak(profile, peaks, prefer_start=True, relative_threshold=0.62):
    values = np.asarray(profile, dtype=np.float32)
    candidates = [int(idx) for idx in peaks if 0 <= int(idx) < len(values)]
    if not candidates:
        return None
    peak_values = [float(values[idx]) for idx in candidates]
    strongest = max(peak_values) if peak_values else 0.0
    qualified = [
        idx for idx in candidates
        if strongest <= 1e-6 or float(values[idx]) >= strongest * relative_threshold
    ]
    if not qualified:
        qualified = candidates
    return min(qualified) if prefer_start else max(qualified)


def refine_outer_peak_from_region(
    profile,
    base_peak,
    min_distance,
    prefer_start=True,
    search_radius=0,
    region_slice=None,
    exclusion_margin=0
):
    values = np.asarray(profile, dtype=np.float32)
    if values.size == 0:
        return base_peak
    if region_slice is None:
        from_idx = 0
        to_idx = len(values)
    else:
        from_idx = max(0, int(region_slice[0]))
        to_idx = min(len(values), int(region_slice[1]))
    region = values[from_idx:to_idx]
    if region.size == 0:
        return base_peak
    relaxed_threshold = float(np.percentile(region, 58))
    relaxed_distance = max(4, int(min_distance * 0.65))
    regional_peaks = detect_profile_peaks(region, relaxed_distance, relaxed_threshold)
    if not regional_peaks:
        return base_peak
    regional_peaks = [
        from_idx + idx for idx in regional_peaks
        if from_idx + idx >= from_idx + int(exclusion_margin) and from_idx + idx <= to_idx - 1 - int(exclusion_margin)
    ]
    if not regional_peaks:
        return base_peak
    chosen = choose_outermost_peak(values, regional_peaks, prefer_start=prefer_start, relative_threshold=0.58)
    if chosen is None:
        return base_peak
    if search_radius > 0 and base_peak is not None:
        if abs(int(chosen) - int(base_peak)) > int(search_radius):
            return base_peak
    return chosen


def detect_outer_peak_in_band(profile, band_start, band_end, min_distance, prefer_start=True, relative_threshold=0.56):
    values = np.asarray(profile, dtype=np.float32)
    from_idx = max(0, int(band_start))
    to_idx = min(len(values), int(band_end))
    region = values[from_idx:to_idx]
    if region.size == 0:
        return None
    regional_threshold = float(np.percentile(region, 54))
    regional_distance = max(4, int(min_distance * 0.6))
    regional_peaks = detect_profile_peaks(region, regional_distance, regional_threshold)
    if not regional_peaks:
        return None
    absolute_peaks = [from_idx + idx for idx in regional_peaks]
    return choose_outermost_peak(values, absolute_peaks, prefer_start=prefer_start, relative_threshold=relative_threshold)


def estimate_outer_guides(gray, mask, grid_rows, grid_cols):
    height, width = gray.shape
    darkness = np.clip(255.0 - gray, 0.0, 255.0)
    x_profile = smooth_profile(darkness.mean(axis=0), radius=max(3, width // 250))
    y_profile = smooth_profile(darkness.mean(axis=1), radius=max(3, height // 250))

    x_min_distance = max(8, int(width / max(grid_cols * 3, 1)))
    y_min_distance = max(8, int(height / max(grid_rows * 3, 1)))
    x_peaks = detect_profile_peaks(x_profile, x_min_distance, float(np.percentile(x_profile, 72)))
    y_peaks = detect_profile_peaks(y_profile, y_min_distance, float(np.percentile(y_profile, 72)))
    x_edge_margin = max(18, int((width / max(grid_cols, 1)) * 0.28))
    y_edge_margin = max(18, int((height / max(grid_rows, 1)) * 0.28))
    filtered_x_peaks = [idx for idx in x_peaks if x_edge_margin <= idx <= width - 1 - x_edge_margin]
    filtered_y_peaks = [idx for idx in y_peaks if y_edge_margin <= idx <= height - 1 - y_edge_margin]
    if len(filtered_x_peaks) >= 2:
        x_peaks = filtered_x_peaks
    if len(filtered_y_peaks) >= 2:
        y_peaks = filtered_y_peaks

    if len(x_peaks) < 2 or len(y_peaks) < 2:
        return None

    approx_cell_h = max(12.0, height / max(grid_rows, 1))
    approx_cell_w = max(12.0, width / max(grid_cols, 1))
    left_peak = min(x_peaks)
    right_peak = max(x_peaks)
    top_peak = min(y_peaks)
    bottom_peak = max(y_peaks)
    top_band_peak = detect_outer_peak_in_band(
        y_profile,
        y_edge_margin,
        min(height, int(y_edge_margin + approx_cell_h * 2.4)),
        y_min_distance,
        prefer_start=True,
        relative_threshold=0.54
    )
    bottom_band_peak = detect_outer_peak_in_band(
        y_profile,
        max(0, int(height - y_edge_margin - approx_cell_h * 2.4)),
        height - y_edge_margin,
        y_min_distance,
        prefer_start=False,
        relative_threshold=0.54
    )
    if top_band_peak is not None:
        top_peak = int(top_band_peak)
    if bottom_band_peak is not None:
        bottom_peak = int(bottom_band_peak)
    top_peak = refine_outer_peak_from_region(
        y_profile,
        top_peak,
        y_min_distance,
        prefer_start=True,
        search_radius=approx_cell_h * 1.15,
        region_slice=(0, min(height, int(top_peak + approx_cell_h * 0.65))),
        exclusion_margin=max(18, int(approx_cell_h * 0.28))
    )
    bottom_peak = refine_outer_peak_from_region(
        y_profile,
        bottom_peak,
        y_min_distance,
        prefer_start=False,
        search_radius=approx_cell_h * 1.15,
        region_slice=(max(0, int(bottom_peak - approx_cell_h * 0.65)), height),
        exclusion_margin=max(18, int(approx_cell_h * 0.28))
    )
    left_peak = refine_outer_peak_from_region(
        x_profile,
        left_peak,
        x_min_distance,
        prefer_start=True,
        search_radius=approx_cell_w * 1.15,
        region_slice=(0, min(width, int(left_peak + approx_cell_w * 0.65))),
        exclusion_margin=max(18, int(approx_cell_w * 0.18))
    )
    right_peak = refine_outer_peak_from_region(
        x_profile,
        right_peak,
        x_min_distance,
        prefer_start=False,
        search_radius=approx_cell_w * 1.15,
        region_slice=(max(0, int(right_peak - approx_cell_w * 0.65)), width),
        exclusion_margin=max(18, int(approx_cell_w * 0.18))
    )

    return {
        "left": float(left_peak),
        "right": float(right_peak),
        "top": float(top_peak),
        "bottom": float(bottom_peak),
        "xProfile": x_profile,
        "yProfile": y_profile,
        "xPeaks": x_peaks,
        "yPeaks": y_peaks
    }


def sample_outer_boundary_points(mask, guides, grid_rows, grid_cols):
    height, width = mask.shape
    left_points = []
    right_points = []
    top_points = []
    bottom_points = []
    min_dark_per_row = max(6, int(width * 0.008))
    min_dark_per_col = max(6, int(height * 0.008))
    cell_w = width / max(grid_cols, 1)
    cell_h = height / max(grid_rows, 1)
    x_band = max(10, int(cell_w * 0.22))
    y_band = max(10, int(cell_h * 0.22))
    left_guide = guides["left"]
    right_guide = guides["right"]
    top_guide = guides["top"]
    bottom_guide = guides["bottom"]
    y_start = max(0, int(top_guide - cell_h * 0.35))
    y_end = min(height, int(bottom_guide + cell_h * 0.35))
    x_start = max(0, int(left_guide - cell_w * 0.35))
    x_end = min(width, int(right_guide + cell_w * 0.35))

    for y in range(y_start, y_end):
        xs = np.flatnonzero(mask[y])
        if xs.size < min_dark_per_row:
            continue
        left_candidates = xs[np.abs(xs - left_guide) <= x_band]
        right_candidates = xs[np.abs(xs - right_guide) <= x_band]
        if left_candidates.size:
            left_idx = left_candidates[np.argmin(np.abs(left_candidates - left_guide))]
            left_points.append([float(left_idx), float(y)])
        if right_candidates.size:
            right_idx = right_candidates[np.argmin(np.abs(right_candidates - right_guide))]
            right_points.append([float(right_idx), float(y)])

    for x in range(x_start, x_end):
        ys = np.flatnonzero(mask[:, x])
        if ys.size < min_dark_per_col:
            continue
        top_candidates = ys[np.abs(ys - top_guide) <= y_band]
        bottom_candidates = ys[np.abs(ys - bottom_guide) <= y_band]
        if top_candidates.size:
            top_idx = top_candidates[np.argmin(np.abs(top_candidates - top_guide))]
            top_points.append([float(x), float(top_idx)])
        if bottom_candidates.size:
            bottom_idx = bottom_candidates[np.argmin(np.abs(bottom_candidates - bottom_guide))]
            bottom_points.append([float(x), float(bottom_idx)])

    return (
        np.asarray(left_points, dtype=np.float32),
        np.asarray(right_points, dtype=np.float32),
        np.asarray(top_points, dtype=np.float32),
        np.asarray(bottom_points, dtype=np.float32),
    )


def detect_grid_corners(image_array, threshold, grid_rows, grid_cols):
    if image_array.ndim == 3:
        gray = 0.299 * image_array[..., 0] + 0.587 * image_array[..., 1] + 0.114 * image_array[..., 2]
    else:
        gray = image_array.astype(np.float32)

    mask = gray < threshold
    guides = estimate_outer_guides(gray, mask, grid_rows=grid_rows, grid_cols=grid_cols)
    if guides is None:
        return None

    left_points, right_points, top_points, bottom_points = sample_outer_boundary_points(
        mask,
        guides,
        grid_rows=grid_rows,
        grid_cols=grid_cols
    )
    if min(left_points.shape[0], right_points.shape[0], top_points.shape[0], bottom_points.shape[0]) < 12:
        return None

    left_line = robust_fit(left_points)
    right_line = robust_fit(right_points)
    top_line = robust_fit(top_points)
    bottom_line = robust_fit(bottom_points)
    if any(line is None for line in [left_line, right_line, top_line, bottom_line]):
        return None

    corners = [
        intersect_lines(top_line, left_line),
        intersect_lines(top_line, right_line),
        intersect_lines(bottom_line, right_line),
        intersect_lines(bottom_line, left_line),
    ]
    if any(point is None for point in corners):
        return None

    corners = order_points(np.asarray(corners, dtype=np.float32))
    height, width = gray.shape[:2]
    if (
        np.any(corners[:, 0] < -width * 0.1) or
        np.any(corners[:, 0] > width * 1.1) or
        np.any(corners[:, 1] < -height * 0.1) or
        np.any(corners[:, 1] > height * 1.1)
    ):
        return None

    return {
        "corners": corners,
        "guides": {
            "left": guides["left"],
            "right": guides["right"],
            "top": guides["top"],
            "bottom": guides["bottom"],
            "xPeaks": guides["xPeaks"],
            "yPeaks": guides["yPeaks"]
        },
        "leftPoints": left_points,
        "rightPoints": right_points,
        "topPoints": top_points,
        "bottomPoints": bottom_points
    }


def expand_corners_for_square_cells(corners, grid_rows, grid_cols, image_width, image_height):
    pts = order_points(corners).astype(np.float32)
    width_top = np.linalg.norm(pts[1] - pts[0])
    width_bottom = np.linalg.norm(pts[2] - pts[3])
    height_left = np.linalg.norm(pts[3] - pts[0])
    height_right = np.linalg.norm(pts[2] - pts[1])
    average_width = float((width_top + width_bottom) / 2.0)
    average_height = float((height_left + height_right) / 2.0)
    cell_width = average_width / max(grid_cols, 1)
    cell_height = average_height / max(grid_rows, 1)
    target_cell = max(cell_width, cell_height)

    expanded = pts.copy()

    if cell_height < target_cell * 0.97:
        needed_height = target_cell * grid_rows - average_height
        top_space = max(0.0, min(expanded[0, 1], expanded[1, 1]))
        bottom_space = max(0.0, image_height - 1 - max(expanded[2, 1], expanded[3, 1]))
        total_space = max(1e-6, top_space + bottom_space)
        expand_top = min(top_space, needed_height * (top_space / total_space))
        expand_bottom = min(bottom_space, needed_height * (bottom_space / total_space))
        expanded[0, 1] -= expand_top
        expanded[1, 1] -= expand_top
        expanded[2, 1] += expand_bottom
        expanded[3, 1] += expand_bottom

    if cell_width < target_cell * 0.97:
        needed_width = target_cell * grid_cols - average_width
        left_space = max(0.0, min(expanded[0, 0], expanded[3, 0]))
        right_space = max(0.0, image_width - 1 - max(expanded[1, 0], expanded[2, 0]))
        total_space = max(1e-6, left_space + right_space)
        expand_left = min(left_space, needed_width * (left_space / total_space))
        expand_right = min(right_space, needed_width * (right_space / total_space))
        expanded[0, 0] -= expand_left
        expanded[3, 0] -= expand_left
        expanded[1, 0] += expand_right
        expanded[2, 0] += expand_right

    expanded[:, 0] = np.clip(expanded[:, 0], 0, image_width - 1)
    expanded[:, 1] = np.clip(expanded[:, 1], 0, image_height - 1)
    return order_points(expanded)


def warp_grid(image, corners, grid_rows, grid_cols):
    corners = order_points(corners)
    width_top = np.linalg.norm(corners[1] - corners[0])
    width_bottom = np.linalg.norm(corners[2] - corners[3])
    height_left = np.linalg.norm(corners[3] - corners[0])
    height_right = np.linalg.norm(corners[2] - corners[1])

    average_width = max(1.0, float((width_top + width_bottom) / 2.0))
    average_height = max(1.0, float((height_left + height_right) / 2.0))
    cell_width = average_width / max(grid_cols, 1)
    cell_height = average_height / max(grid_rows, 1)
    target_width = max(1, int(round(cell_width * grid_cols)))
    target_height = max(1, int(round(cell_height * grid_rows)))

    destination = np.array([
        [0, 0],
        [target_width - 1, 0],
        [target_width - 1, target_height - 1],
        [0, target_height - 1]
    ], dtype=np.float32)
    coeffs = find_perspective_coeffs(corners, destination)
    warped = image.transform(
        (target_width, target_height),
        Image.Transform.PERSPECTIVE,
        coeffs,
        Image.Resampling.BICUBIC
    )
    return warped, {
        "targetWidth": target_width,
        "targetHeight": target_height,
        "cellWidth": float(cell_width),
        "cellHeight": float(cell_height),
        "topWidth": float(width_top),
        "bottomWidth": float(width_bottom),
        "leftHeight": float(height_left),
        "rightHeight": float(height_right)
    }


def build_debug_image(image, corners):
    debug = image.convert("RGB")
    draw = ImageDraw.Draw(debug)
    pts = [tuple(point.tolist()) for point in corners]
    draw.line(pts + [pts[0]], fill="#16a34a", width=5)
    for idx, (x, y) in enumerate(pts):
        draw.ellipse((x - 8, y - 8, x + 8, y + 8), fill="#dc2626")
        draw.text((x + 10, y + 8), f"C{idx}", fill="#111827")
    return debug


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--meta", required=True)
    parser.add_argument("--grid-rows", type=int, required=True)
    parser.add_argument("--grid-cols", type=int, required=True)
    parser.add_argument("--threshold", type=int, default=220)
    parser.add_argument("--debug", default="")
    parser.add_argument("--corners-json", default="")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    meta_path = Path(args.meta)
    debug_path = Path(args.debug) if args.debug else None

    image = Image.open(input_path)
    image_array = np.asarray(image)
    detected = None
    if args.corners_json:
        corners = order_points(np.asarray(json.loads(args.corners_json), dtype=np.float32))
        guides = None
    else:
        detected = detect_grid_corners(image_array, args.threshold, args.grid_rows, args.grid_cols)
        if detected is None:
            raise RuntimeError("未检测到最外层方格四边")

        height, width = image_array.shape[:2]
        corners = expand_corners_for_square_cells(
            detected["corners"],
            args.grid_rows,
            args.grid_cols,
            width,
            height
        )
        guides = detected.get("guides")
    warped, warp_meta = warp_grid(image, corners, args.grid_rows, args.grid_cols)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    warped.save(output_path)

    if debug_path:
        debug_path.parent.mkdir(parents=True, exist_ok=True)
        build_debug_image(image, corners).save(debug_path)

    payload = {
        "inputPath": str(input_path),
        "outputPath": str(output_path),
        "corners": corners.tolist(),
        "guides": guides,
        "warp": warp_meta
    }
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
