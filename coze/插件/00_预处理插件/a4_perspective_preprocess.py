#!/usr/bin/env python3
import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

DEFAULT_NEUTRAL_PAPER_COLOR = np.array([216.0, 216.0, 216.0], dtype=np.float32)


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


def largest_component(mask):
    labels, count = ndimage.label(mask)
    if count == 0:
        return None
    areas = ndimage.sum(mask, labels, index=np.arange(1, count + 1))
    label = int(np.argmax(areas)) + 1
    component = labels == label
    return component


def point_segment_distance(points, start, end):
    start = np.asarray(start, dtype=np.float32)
    end = np.asarray(end, dtype=np.float32)
    segment = end - start
    length_sq = float(np.dot(segment, segment))
    if length_sq <= 1e-6:
        return np.linalg.norm(points - start, axis=1)
    t = np.clip(np.dot(points - start, segment) / length_sq, 0.0, 1.0)
    projection = start + np.outer(t, segment)
    return np.linalg.norm(points - projection, axis=1)


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


def refine_corners_from_boundary(boundary_points, initial_corners):
    ordered = order_points(initial_corners)
    points = np.asarray(boundary_points, dtype=np.float32)
    edge_lines = []
    point_count = points.shape[0]
    if point_count < 40:
        return ordered

    edge_names = [
        ("top", ordered[0], ordered[1]),
        ("right", ordered[1], ordered[2]),
        ("bottom", ordered[3], ordered[2]),
        ("left", ordered[0], ordered[3])
    ]

    for _, start, end in edge_names:
        distances = point_segment_distance(points, start, end)
        edge_length = np.linalg.norm(end - start)
        keep = distances <= max(6.0, edge_length * 0.03)

        if np.count_nonzero(keep) < max(25, point_count * 0.01):
            keep = distances <= max(10.0, edge_length * 0.05)

        selected = points[keep]
        if selected.shape[0] < 10:
            edge_lines.append(None)
            continue

        edge_lines.append(fit_line(selected))

    if any(line is None for line in edge_lines):
        return ordered

    intersections = [
        intersect_lines(edge_lines[0], edge_lines[3]),
        intersect_lines(edge_lines[0], edge_lines[1]),
        intersect_lines(edge_lines[1], edge_lines[2]),
        intersect_lines(edge_lines[2], edge_lines[3])
    ]
    if any(point is None for point in intersections):
        return ordered

    refined = np.asarray(intersections, dtype=np.float32)
    return order_points(refined)


def polygon_area(points):
    pts = np.asarray(points, dtype=np.float64)
    x = pts[:, 0]
    y = pts[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def angle_deviation_score(points):
    pts = order_points(points).astype(np.float64)
    total = 0.0
    for index in range(4):
      prev_point = pts[(index - 1) % 4]
      point = pts[index]
      next_point = pts[(index + 1) % 4]
      v1 = prev_point - point
      v2 = next_point - point
      denom = np.linalg.norm(v1) * np.linalg.norm(v2)
      if denom <= 1e-6:
          return float("inf")
      cosine = np.clip(np.dot(v1, v2) / denom, -1.0, 1.0)
      angle = math.degrees(math.acos(cosine))
      total += abs(90.0 - angle)
    return total


def side_lengths(points):
    pts = order_points(points).astype(np.float64)
    width_top = np.linalg.norm(pts[1] - pts[0])
    width_bottom = np.linalg.norm(pts[2] - pts[3])
    height_left = np.linalg.norm(pts[3] - pts[0])
    height_right = np.linalg.norm(pts[2] - pts[1])
    return width_top, width_bottom, height_left, height_right


def a4_ratio_score(points):
    width_top, width_bottom, height_left, height_right = side_lengths(points)
    width = max(width_top, width_bottom, 1e-6)
    height = max(height_left, height_right, 1e-6)
    long_edge = max(width, height)
    short_edge = max(1e-6, min(width, height))
    detected_ratio = long_edge / short_edge
    standard_ratio = math.sqrt(2.0)
    ratio_error = abs(detected_ratio - standard_ratio)
    ratio_error_percent = (ratio_error / standard_ratio) * 100.0
    return {
        "detectedRatio": float(detected_ratio),
        "standardRatio": float(standard_ratio),
        "ratioError": float(ratio_error),
        "ratioErrorPercent": float(ratio_error_percent)
    }


def choose_corners(rough_corners, refined_corners):
    rough = order_points(rough_corners)
    refined = order_points(refined_corners)
    rough_area = polygon_area(rough)
    refined_area = polygon_area(refined)
    rough_a4 = a4_ratio_score(rough)
    refined_a4 = a4_ratio_score(refined)
    payload = {
        "roughArea": float(rough_area),
        "refinedArea": float(refined_area),
        "selected": "rough",
        "reason": "invalid_area",
        "roughA4Ratio": rough_a4,
        "refinedA4Ratio": refined_a4
    }
    if rough_area <= 1e-6 or refined_area <= 1e-6:
        return rough, payload

    area_ratio = refined_area / rough_area
    rough_angle_score = angle_deviation_score(rough)
    refined_angle_score = angle_deviation_score(refined)
    payload.update({
        "areaRatio": float(area_ratio),
        "roughAngleScore": float(rough_angle_score),
        "refinedAngleScore": float(refined_angle_score),
        "roughA4RatioErrorPercent": float(rough_a4["ratioErrorPercent"]),
        "refinedA4RatioErrorPercent": float(refined_a4["ratioErrorPercent"])
    })

    if (
        refined_a4["ratioErrorPercent"] + 0.35 < rough_a4["ratioErrorPercent"] and
        area_ratio >= 0.955 and
        refined_angle_score <= rough_angle_score * 1.35
    ):
        payload.update({
            "selected": "refined",
            "reason": "refined_a4_ratio_better"
        })
        return refined, payload

    if area_ratio < 0.965 and refined_angle_score >= rough_angle_score * 0.85:
        payload.update({
            "selected": "rough",
            "reason": "refined_area_too_small"
        })
        return rough, payload
    if refined_angle_score > rough_angle_score * 1.15 and area_ratio < 0.99:
        payload.update({
            "selected": "rough",
            "reason": "refined_angle_worse"
        })
        return rough, payload
    if refined_angle_score <= rough_angle_score + 8:
        payload.update({
            "selected": "refined",
            "reason": "refined_accepted"
        })
        return refined, payload
    payload.update({
        "selected": "rough",
        "reason": "refined_not_better"
    })
    return rough, payload


def detect_paper_corners(image_array, scale=900):
    height, width = image_array.shape[:2]
    resize_ratio = min(1.0, scale / max(width, height))
    scaled_w = max(1, int(round(width * resize_ratio)))
    scaled_h = max(1, int(round(height * resize_ratio)))
    image = Image.fromarray(image_array).resize((scaled_w, scaled_h), Image.Resampling.BILINEAR)
    small = np.asarray(image).astype(np.float32)

    gray = 0.299 * small[..., 0] + 0.587 * small[..., 1] + 0.114 * small[..., 2]
    smooth = ndimage.gaussian_filter(gray, sigma=2.2)
    gx = ndimage.sobel(smooth, axis=1)
    gy = ndimage.sobel(smooth, axis=0)
    gradient = np.hypot(gx, gy)

    max_channel = np.max(small, axis=2)
    min_channel = np.min(small, axis=2)
    saturation = max_channel - min_channel
    bright_mask = smooth >= 140
    low_sat_mask = saturation <= 90
    edge_mask = gradient >= np.percentile(gradient, 80)
    paper_mask = ndimage.binary_fill_holes(ndimage.binary_closing(bright_mask & low_sat_mask, structure=np.ones((9, 9))))
    paper_mask = ndimage.binary_opening(paper_mask, structure=np.ones((5, 5)))

    component = largest_component(paper_mask)
    if component is None:
        return None

    ys, xs = np.nonzero(component)
    if xs.size < 100:
        return None

    boundary = component & ~ndimage.binary_erosion(component, structure=np.ones((3, 3)))
    edge_points = np.argwhere(boundary | edge_mask)
    if edge_points.shape[0] < 20:
        edge_points = np.column_stack([ys, xs])

    pts = np.column_stack([edge_points[:, 1], edge_points[:, 0]]).astype(np.float32)
    sums = pts[:, 0] + pts[:, 1]
    diffs = pts[:, 0] - pts[:, 1]
    rough_corners = np.array([
        pts[np.argmin(sums)],
        pts[np.argmax(diffs)],
        pts[np.argmax(sums)],
        pts[np.argmin(diffs)]
    ], dtype=np.float32)
    refined_corners = refine_corners_from_boundary(pts, rough_corners)
    selected_corners, selection_meta = choose_corners(rough_corners, refined_corners)

    corners = selected_corners / max(resize_ratio, 1e-6)
    corners = order_points(corners)

    width_top = np.linalg.norm(corners[1] - corners[0])
    width_bottom = np.linalg.norm(corners[2] - corners[3])
    height_left = np.linalg.norm(corners[3] - corners[0])
    height_right = np.linalg.norm(corners[2] - corners[1])
    min_area = width * height * 0.35
    est_area = max(width_top, width_bottom) * max(height_left, height_right)
    if est_area < min_area:
        return None

    return {
        "corners": corners,
        "roughCorners": order_points(rough_corners / max(resize_ratio, 1e-6)),
        "refinedCorners": order_points(refined_corners / max(resize_ratio, 1e-6)),
        "selection": selection_meta
    }


def warp_paper(image, corners, inward_crop_ratio=0.015, enforce_a4_ratio=True):
    corners = order_points(corners)
    width_top, width_bottom, height_left, height_right = side_lengths(corners)
    measured_width = max(width_top, width_bottom)
    measured_height = max(height_left, height_right)
    target_width = max(1, int(round(measured_width)))
    target_height = max(1, int(round(measured_height)))
    standard_ratio = math.sqrt(2.0)

    if enforce_a4_ratio:
        if target_height >= target_width:
            target_height = max(target_height, target_width)
            target_width = max(1, int(round(target_height / standard_ratio)))
            target_height = max(1, int(round(target_width * standard_ratio)))
        else:
            target_width = max(target_width, target_height)
            target_height = max(1, int(round(target_width / standard_ratio)))
            target_width = max(1, int(round(target_height * standard_ratio)))

    destination = np.array([
        [0, 0],
        [target_width - 1, 0],
        [target_width - 1, target_height - 1],
        [0, target_height - 1]
    ], dtype=np.float32)
    coeffs = find_perspective_coeffs(corners, destination)
    warped = image.transform((target_width, target_height), Image.Transform.PERSPECTIVE, coeffs, Image.Resampling.BICUBIC)

    inset_x = max(2, int(round(target_width * inward_crop_ratio)))
    inset_y = max(2, int(round(target_height * inward_crop_ratio)))
    crop_box = (
        inset_x,
        inset_y,
        max(inset_x + 1, target_width - inset_x),
        max(inset_y + 1, target_height - inset_y)
    )
    warped = warped.crop(crop_box)
    return warped, {
        "a4RatioEnforced": bool(enforce_a4_ratio),
        "standardRatio": float(round(standard_ratio, 4)),
        "measuredWidth": float(measured_width),
        "measuredHeight": float(measured_height),
        "targetWidth": target_width,
        "targetHeight": target_height,
        "insetX": inset_x,
        "insetY": inset_y
    }


def adaptive_binarize(image_array, threshold=185, blur_sigma=18, ignore_red_grid=True):
    rgb = image_array.astype(np.float32)
    gray = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    sigma = max(1.0, blur_sigma)
    background = ndimage.gaussian_filter(gray, sigma=sigma)
    normalized = np.clip((gray * 255.0) / np.maximum(background, 1.0), 0, 255)

    local_mean = ndimage.uniform_filter(normalized, size=35)
    binary = normalized < np.minimum(threshold, local_mean - 8)

    if ignore_red_grid:
        red_mask = (
            (rgb[..., 0] > 150) &
            (rgb[..., 1] < 170) &
            (rgb[..., 2] < 170) &
            ((rgb[..., 0] - rgb[..., 1]) > 30) &
            ((rgb[..., 0] - rgb[..., 2]) > 30)
        )
        binary[red_mask] = False

    binary = ndimage.binary_opening(binary, structure=np.ones((2, 2)))
    output = np.where(binary, 0, 255).astype(np.uint8)
    return output


def estimate_global_background_gray(gray):
    smoothed = ndimage.gaussian_filter(gray, sigma=6.0)
    bright_threshold = np.percentile(smoothed, 72.0)
    candidate_mask = smoothed >= bright_threshold
    candidate_values = smoothed[candidate_mask]
    if candidate_values.size == 0:
        return float(np.percentile(smoothed, 75.0))
    return float(np.median(candidate_values))


def apply_line_band_mask(mask, positions, axis, band):
    if not positions:
        return
    if axis == "x":
        width = mask.shape[1]
        for position in positions:
            left = max(0, int(round(position - band)))
            right = min(width, int(round(position + band + 1)))
            if right > left:
                mask[:, left:right] = True
    else:
        height = mask.shape[0]
        for position in positions:
            top = max(0, int(round(position - band)))
            bottom = min(height, int(round(position + band + 1)))
            if bottom > top:
                mask[top:bottom, :] = True


def build_guide_mask(height, width, grid_rows=None, grid_cols=None, grid_type="square", edge_ratio=0.018):
    if not grid_rows or not grid_cols:
        return None

    cell_w = width / max(grid_cols, 1)
    cell_h = height / max(grid_rows, 1)
    short_side = max(1.0, min(cell_w, cell_h))
    edge_band = max(1.2, short_side * edge_ratio)
    guide_mask = np.zeros((height, width), dtype=bool)
    x_positions = [cell_w * index for index in range(1, max(grid_cols, 1))]
    y_positions = [cell_h * index for index in range(1, max(grid_rows, 1))]
    apply_line_band_mask(guide_mask, x_positions, "x", edge_band)
    apply_line_band_mask(guide_mask, y_positions, "y", edge_band)
    return guide_mask


def build_segmentation_ready_image(
    image_array,
    blur_sigma=18,
    grid_rows=None,
    grid_cols=None,
    grid_type="square",
    disable_internal_grid_guide_cleanup=False
):
    rgb = image_array.astype(np.float32)
    gray = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    smoothed_gray = ndimage.gaussian_filter(gray, sigma=max(0.8, blur_sigma * 0.08))
    global_background = estimate_global_background_gray(smoothed_gray)
    paper_gray = np.clip(global_background * 1.15, 145.0, 210.0)
    baseline = np.clip(paper_gray * 0.60, 0.0, paper_gray)
    delta = smoothed_gray - baseline
    # Bright side remains capped by the global paper gray ceiling.
    bright_delta = np.clip(delta, 0.0, None)
    bright_headroom = np.maximum(paper_gray - baseline, 1.0)
    bright_ratio = np.clip(bright_delta / bright_headroom, 0.0, 1.0)
    bright_eased = 1.0 - np.power(1.0 - bright_ratio, 3.4)
    bright_eased = np.clip(bright_eased + 0.10 * bright_ratio, 0.0, 1.0)
    bright_enhanced = baseline + bright_headroom * bright_eased

    # Dark side uses ratio-based nonlinear expansion:
    # the darker it is relative to baseline, the faster it darkens.
    dark_delta = np.clip(-delta, 0.0, None)
    dark_ratio = dark_delta / np.maximum(baseline, 1.0)
    dark_scale = dark_ratio * (0.92 + 1.35 * dark_ratio + 0.95 * (dark_ratio ** 2))
    dark_enhanced = baseline * (1.0 - dark_scale)

    enhanced = np.where(delta >= 0.0, bright_enhanced, dark_enhanced)
    enhanced = np.clip(enhanced, 0.0, paper_gray)
    guide_mask = None if disable_internal_grid_guide_cleanup else build_guide_mask(
        gray.shape[0],
        gray.shape[1],
        grid_rows=grid_rows,
        grid_cols=grid_cols,
        grid_type=grid_type
    )
    if guide_mask is not None:
        guide_reference = ndimage.gaussian_filter(smoothed_gray, sigma=max(2.0, blur_sigma * 0.18))
        highlight_mask = guide_mask & (enhanced >= guide_reference + 8.0)
        enhanced[highlight_mask] = np.minimum(enhanced[highlight_mask], np.minimum(guide_reference[highlight_mask] + 2.0, paper_gray))
    enhanced = ndimage.gaussian_filter(enhanced, sigma=0.6)
    enhanced = np.minimum(enhanced, paper_gray)
    return np.clip(enhanced, 0, 255).astype(np.uint8)


def normalize_grid_type(grid_type):
    value = (grid_type or "square").strip().lower()
    if value in {"square", "normal", "plain", "普通", "方格"}:
        return "square"
    if value in {"tian", "田", "田字格"}:
        return "tian"
    if value in {"mi", "米", "米字格"}:
        return "mi"
    if value in {"hui", "回", "回字格", "回宫格"}:
        return "hui"
    return "square"


def estimate_neutral_paper_color(image_array, exclude_mask=None):
    return DEFAULT_NEUTRAL_PAPER_COLOR.copy()


def remove_grid_guides(image_array, grid_rows=None, grid_cols=None, grid_type="square", disable_internal_grid_guide_cleanup=False):
    grid_type = normalize_grid_type(grid_type)
    if disable_internal_grid_guide_cleanup or not grid_rows or not grid_cols:
      return image_array

    rgb = image_array.astype(np.float32).copy()
    height, width = rgb.shape[:2]
    cell_w = width / max(grid_cols, 1)
    cell_h = height / max(grid_rows, 1)
    short_side = max(1.0, min(cell_w, cell_h))
    band = max(1.4, short_side * 0.018)
    diag_band = max(1.8, short_side * 0.022)
    inner_band = max(1.2, short_side * 0.015)
    edge_band = max(1.6, short_side * 0.02)

    ys = (np.arange(height, dtype=np.float32) + 0.5)[:, None]
    xs = (np.arange(width, dtype=np.float32) + 0.5)[None, :]
    local_x = np.mod(xs, cell_w) / max(cell_w, 1e-6)
    local_y = np.mod(ys, cell_h) / max(cell_h, 1e-6)
    px_local_x = np.mod(xs, cell_w)
    px_local_y = np.mod(ys, cell_h)

    guide_mask = build_guide_mask(height, width, grid_rows=grid_rows, grid_cols=grid_cols, grid_type=grid_type, edge_ratio=0.02)
    if guide_mask is None:
        guide_mask = np.zeros((height, width), dtype=bool)

    if grid_type != "square":
        guide_mask |= np.abs(local_x - 0.5) <= band / max(cell_w, 1e-6)
        guide_mask |= np.abs(local_y - 0.5) <= band / max(cell_h, 1e-6)

    if grid_type == "mi":
        guide_mask |= np.abs(local_x - local_y) <= diag_band / short_side
        guide_mask |= np.abs((local_x + local_y) - 1.0) <= diag_band / short_side

    if grid_type == "hui":
        inner_margin_x = 0.2 * cell_w
        inner_margin_y = 0.2 * cell_h
        guide_mask |= (
            (np.abs(px_local_x - inner_margin_x) <= inner_band) |
            (np.abs(px_local_x - (cell_w - inner_margin_x)) <= inner_band)
        ) & (px_local_y >= inner_margin_y - inner_band) & (px_local_y <= cell_h - inner_margin_y + inner_band)
        guide_mask |= (
            (np.abs(px_local_y - inner_margin_y) <= inner_band) |
            (np.abs(px_local_y - (cell_h - inner_margin_y)) <= inner_band)
        ) & (px_local_x >= inner_margin_x - inner_band) & (px_local_x <= cell_w - inner_margin_x + inner_band)

    max_channel = np.max(rgb, axis=2)
    min_channel = np.min(rgb, axis=2)
    gray = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    color_span = max_channel - min_channel
    neutral_paper = estimate_neutral_paper_color(image_array, exclude_mask=guide_mask)
    neutral_gray = float(neutral_paper[0])
    bright_guide_mask = guide_mask & (gray >= max(118.0, neutral_gray - 96.0)) & (color_span <= 42.0)
    soft_guide_mask = guide_mask & (gray >= max(108.0, neutral_gray - 108.0)) & (color_span <= 58.0)
    removable_mask = guide_mask & (gray >= 105) & ((gray >= 150) | (color_span <= 70))
    removable_mask |= bright_guide_mask | soft_guide_mask

    if not np.any(removable_mask):
        return image_array

    sigma = max(6.0, short_side * 0.08)
    for channel in range(3):
        blurred = ndimage.gaussian_filter(rgb[..., channel], sigma=sigma)
        channel_data = rgb[..., channel]
        soft_only_mask = removable_mask & ~bright_guide_mask
        channel_data[soft_only_mask] = (
            channel_data[soft_only_mask] * 0.08 +
            blurred[soft_only_mask] * 0.24 +
            neutral_paper[channel] * 0.68
        )
        channel_data[bright_guide_mask] = (
            blurred[bright_guide_mask] * 0.10 +
            neutral_paper[channel] * 0.90
        )
        rgb[..., channel] = channel_data

    return np.clip(rgb, 0, 255).astype(np.uint8)


def build_grid_background_mask(image_array, grid_rows=None, grid_cols=None):
    if not grid_rows or not grid_cols:
        return None

    rgb = image_array.astype(np.float32)
    height, width = rgb.shape[:2]
    cell_w = width / max(grid_cols, 1)
    cell_h = height / max(grid_rows, 1)
    short_side = max(1.0, min(cell_w, cell_h))
    edge_band = max(1.8, short_side * 0.024)
    guide_zone = build_guide_mask(height, width, grid_rows=grid_rows, grid_cols=grid_cols, edge_ratio=0.024)
    if guide_zone is None:
        return None

    gray = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    max_channel = np.max(rgb, axis=2)
    min_channel = np.min(rgb, axis=2)
    color_span = max_channel - min_channel
    mask = guide_zone & (gray >= 70) & ((gray >= 125) | (color_span <= 55))
    return mask.astype(np.uint8) * 255


def build_grid_annotation_image(image_array, grid_rows=None, grid_cols=None):
    image = Image.fromarray(image_array.astype(np.uint8), mode="RGB").convert("RGBA")
    draw = ImageDraw.Draw(image)
    height, width = image_array.shape[:2]

    draw.rectangle((2, 2, width - 3, height - 3), outline=(22, 163, 74, 255), width=6)
    draw.rectangle((10, 10, 300, 46), fill=(17, 24, 39, 220))
    draw.text((18, 18), f"01 outer-grid  {grid_rows}x{grid_cols}", fill=(255, 255, 255, 255))

    if not grid_rows or not grid_cols:
        return image.convert("RGB")

    cell_w = width / max(grid_cols, 1)
    cell_h = height / max(grid_rows, 1)

    for col in range(1, grid_cols):
        x = int(round(col * cell_w))
        draw.line((x, 0, x, height), fill=(59, 130, 246, 180), width=2)
    for row in range(1, grid_rows):
        y = int(round(row * cell_h))
        draw.line((0, y, width, y), fill=(220, 38, 38, 180), width=2)

    for row in range(grid_rows):
        for col in range(grid_cols):
            left = int(round(col * cell_w))
            top = int(round(row * cell_h))
            right = int(round((col + 1) * cell_w))
            bottom = int(round((row + 1) * cell_h))
            center_x = left + max(12, (right - left) // 2 - 18)
            center_y = top + max(14, (bottom - top) // 2 - 10)
            draw.rectangle((center_x - 8, center_y - 10, center_x + 48, center_y + 12), fill=(255, 255, 255, 185))
            draw.text((center_x, center_y - 6), f"{row+1}-{col+1}", fill=(17, 24, 39, 255))

    return image.convert("RGB")


def build_debug_image(image, rough_corners, refined_corners, final_corners, selection_meta):
    debug = image.copy().convert("RGB")
    draw = ImageDraw.Draw(debug)

    def draw_quad(points, line_color, point_color, label_prefix, width=5):
        pts = [tuple(point.tolist()) for point in points]
        draw.line(pts + [pts[0]], fill=line_color, width=width)
        for idx, point in enumerate(pts):
            x, y = point
            draw.ellipse((x - 8, y - 8, x + 8, y + 8), fill=point_color)
            draw.text((x + 10, y - 10), f"{label_prefix}{idx}", fill=line_color)

    draw_quad(rough_corners, (245, 158, 11), (217, 119, 6), "R", width=4)
    draw_quad(refined_corners, (37, 99, 235), (29, 78, 216), "F", width=4)
    draw_quad(final_corners, (34, 197, 94), (220, 38, 38), "S", width=7)
    if selection_meta:
        text = f"selected={selection_meta.get('selected')} reason={selection_meta.get('reason')}"
        draw.rectangle((12, 12, 420, 42), fill=(17, 24, 39))
        draw.text((20, 20), text, fill=(255, 255, 255))
    return debug


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--segmentation-output", required=True)
    parser.add_argument("--paper-crop-output", default="")
    parser.add_argument("--warped-output", default="")
    parser.add_argument("--guide-removed-output", default="")
    parser.add_argument("--neutral-guide-removed-output", default="")
    parser.add_argument("--grid-background-mask-output", default="")
    parser.add_argument("--grid-annotated-output", default="")
    parser.add_argument("--meta", required=True)
    parser.add_argument("--debug", default=None)
    parser.add_argument("--threshold", type=float, default=185)
    parser.add_argument("--blur-sigma", type=float, default=18)
    parser.add_argument("--grid-rows", type=int, default=0)
    parser.add_argument("--grid-cols", type=int, default=0)
    parser.add_argument("--grid-type", default="square")
    parser.add_argument("--crop-to-paper", action="store_true")
    parser.add_argument("--ignore-red-grid", action="store_true")
    parser.add_argument("--disable-internal-grid-guide-cleanup", action="store_true")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    segmentation_output_path = Path(args.segmentation_output)
    paper_crop_output_path = Path(args.paper_crop_output) if args.paper_crop_output else None
    warped_output_path = Path(args.warped_output) if args.warped_output else None
    guide_removed_output_path = Path(args.guide_removed_output) if args.guide_removed_output else None
    neutral_guide_removed_output_path = Path(args.neutral_guide_removed_output) if args.neutral_guide_removed_output else None
    grid_background_mask_output_path = Path(args.grid_background_mask_output) if args.grid_background_mask_output else None
    grid_annotated_output_path = Path(args.grid_annotated_output) if args.grid_annotated_output else None
    meta_path = Path(args.meta)
    debug_path = Path(args.debug) if args.debug else None

    image = Image.open(input_path).convert("RGB")
    image_array = np.asarray(image)
    corner_result = detect_paper_corners(image_array) if args.crop_to_paper else None
    corners = corner_result["corners"] if corner_result is not None else None

    method = "perspective"
    if corners is None:
        warped = image
        warp_meta = {
            "targetWidth": image.width,
            "targetHeight": image.height,
            "insetX": 0,
            "insetY": 0
        }
        method = "fallback_no_quad"
    else:
        warped, warp_meta = warp_paper(image, corners)

    if corners is not None:
        xs = [float(point[0]) for point in corners.tolist()]
        ys = [float(point[1]) for point in corners.tolist()]
        crop_left = max(0, int(round(min(xs))))
        crop_top = max(0, int(round(min(ys))))
        crop_right = min(image.width, max(crop_left + 1, int(round(max(xs)))))
        crop_bottom = min(image.height, max(crop_top + 1, int(round(max(ys)))))
        paper_crop = image.crop((crop_left, crop_top, crop_right, crop_bottom))
    else:
        crop_left = 0
        crop_top = 0
        crop_right = image.width
        crop_bottom = image.height
        paper_crop = image

    if paper_crop_output_path:
        paper_crop_output_path.parent.mkdir(parents=True, exist_ok=True)
        paper_crop.save(paper_crop_output_path)

    warped_array = np.asarray(warped)
    cleaned_warped_array = remove_grid_guides(
        warped_array,
        grid_rows=args.grid_rows or None,
        grid_cols=args.grid_cols or None,
        grid_type=args.grid_type,
        disable_internal_grid_guide_cleanup=args.disable_internal_grid_guide_cleanup
    )
    if warped_output_path:
        warped_output_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(warped_array, mode="RGB").save(warped_output_path)
    if guide_removed_output_path:
        guide_removed_output_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(cleaned_warped_array, mode="RGB").save(guide_removed_output_path)
    if neutral_guide_removed_output_path:
        neutral_guide_removed_output_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(cleaned_warped_array, mode="RGB").save(neutral_guide_removed_output_path)

    grid_background_mask = build_grid_background_mask(
        cleaned_warped_array,
        grid_rows=args.grid_rows or None,
        grid_cols=args.grid_cols or None
    )
    if grid_background_mask_output_path and grid_background_mask is not None:
        grid_background_mask_output_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(grid_background_mask, mode="L").save(grid_background_mask_output_path)

    grid_annotated = build_grid_annotation_image(
        warped_array,
        grid_rows=args.grid_rows or None,
        grid_cols=args.grid_cols or None
    )
    if grid_annotated_output_path:
        grid_annotated_output_path.parent.mkdir(parents=True, exist_ok=True)
        grid_annotated.save(grid_annotated_output_path)

    segmentation_ready = build_segmentation_ready_image(
        cleaned_warped_array,
        blur_sigma=args.blur_sigma,
        grid_rows=args.grid_rows or None,
        grid_cols=args.grid_cols or None,
        grid_type=args.grid_type,
        disable_internal_grid_guide_cleanup=args.disable_internal_grid_guide_cleanup
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(segmentation_ready, mode="L").save(output_path)
    if segmentation_output_path != output_path:
        segmentation_output_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(segmentation_ready, mode="L").save(segmentation_output_path)

    if debug_path:
        debug_path.parent.mkdir(parents=True, exist_ok=True)
        if corners is not None:
            build_debug_image(
                image,
                corner_result["roughCorners"],
                corner_result["refinedCorners"],
                corner_result["corners"],
                corner_result["selection"]
            ).save(debug_path)
        else:
            image.save(debug_path)

    if corners is not None:
        corners_list = [[float(x), float(y)] for x, y in corners.tolist()]
        rough_corners_list = [[float(x), float(y)] for x, y in corner_result["roughCorners"].tolist()]
        refined_corners_list = [[float(x), float(y)] for x, y in corner_result["refinedCorners"].tolist()]
        paper_bounds = {
            "left": crop_left,
            "top": crop_top,
            "width": crop_right - crop_left,
            "height": crop_bottom - crop_top
        }
    else:
        corners_list = None
        rough_corners_list = None
        refined_corners_list = None
        paper_bounds = {
            "left": 0,
            "top": 0,
            "width": image.width,
            "height": image.height
        }

    payload = {
        "method": method,
        "imagePath": str(input_path),
        "outputPath": str(output_path),
        "segmentationOutputPath": str(segmentation_output_path),
        "paperCropOutputPath": str(paper_crop_output_path) if paper_crop_output_path else None,
        "warpedOutputPath": str(warped_output_path) if warped_output_path else None,
        "guideRemovedOutputPath": str(guide_removed_output_path) if guide_removed_output_path else None,
        "neutralGuideRemovedOutputPath": str(neutral_guide_removed_output_path) if neutral_guide_removed_output_path else None,
        "gridBackgroundMaskOutputPath": str(grid_background_mask_output_path) if grid_background_mask_output_path and grid_background_mask is not None else None,
        "gridAnnotatedOutputPath": str(grid_annotated_output_path) if grid_annotated_output_path else None,
        "gridType": normalize_grid_type(args.grid_type),
        "gridRows": int(args.grid_rows),
        "gridCols": int(args.grid_cols),
        "paperBounds": paper_bounds,
        "paperCorners": corners_list,
        "roughPaperCorners": rough_corners_list,
        "refinedPaperCorners": refined_corners_list,
        "cornerSelection": corner_result["selection"] if corner_result is not None else None,
        "warp": warp_meta,
        "outputInfo": {
            "width": int(segmentation_ready.shape[1]),
            "height": int(segmentation_ready.shape[0])
        }
    }

    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
