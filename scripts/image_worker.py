#!/usr/bin/env python3
"""Decode SAM 3.1 segmentation texts, keep only the serving set, refine the
mask, and composite the set onto a studio backdrop.

Usage:
  python3 scripts/image_worker.py <job.json>

job.json fields (all new fields optional; an old job without them still
runs, see "Backward compatibility" below):
  original: path to the seller photo
  backdrop: path to the studio backdrop template
  sam_texts: list of SAM Responses API output texts (one per prompt)
  output: path for the final catalog PNG
  refine: optional bool, default true; apply the refine chain below.
    When false, the raw serving-cluster mask is used as-is (binary,
    no expand/close/snap/feather) and only the shadow + framing run.
  feather_px: optional int, default 3; width of the distance-based
    alpha ramp, in px, on EACH side of the mask edge (total ramp 2x).
    0 means a hard binary edge.
  expand_px: optional int, default 0, clamped to +/-20; positive dilates
    the mask (MaxFilter 2*px+1), negative erodes it (MinFilter 2*|px|+1).
    Backend for the manual-correction slider. 0 means no change.
  snap: optional bool, default false; gradient snap (see below).
    Default OFF: the strongest nearby gradient is not necessarily the
    object contour, so snapping must be an explicit, compared choice.
  shadow_strength: optional int, default 140; alpha of the contact
    shadow core right below the object (0-255, clamped).
  shadow_blur: optional int, default 30; Gaussian blur radius of the
    wide soft falloff layer.
  mask_output: optional path; when present, the final mask actually
    used for the cutout is saved here as a grayscale PNG. See
    "Mask coordinate contract" below.

Rules, all verified against real photos during the hackathon:
- One set: every serving object the seller photographed stays. Generic
  prompts ("cup", "glass") can also match kitchenware that is not part of
  the serving, so masks are clustered by adjacency: the largest mask seeds
  the cluster, and only masks touching the cluster (within 25 px) join it.
  A distant pot on the stove is dropped, a mug behind the plate is kept.
- Refine order (each step feeds the next): expand -> close -> snap ->
  feather. Expand is the explicit user correction, so it goes first;
  close cleans the corrected mask; snap moves the hard edge; feather
  turns the hard edge into alpha last, so no later step can shift it.
- Conservative closing (replaces the old 1 px erosion): MaxFilter(3)
  then MinFilter(3). The dilation fills 1 px holes and 1 px gaps, the
  erosion restores the original extent, so the outer contour comes back
  to (approximately) where SAM put it instead of shrinking 1 px
  everywhere as the old MinFilter(3)-only erosion did. Kernel 3x3 means:
  enclosed holes up to ~2 px close; open gaps of 3 px or more are
  untouched (dilation narrows them by 1 px per side, erosion reopens
  them fully); natural gaps in a serving set (between items, handles,
  garnish) are far wider than that at photo resolution and are never
  closed. Thin 1-2 px structures survive: dilation thickens them, the
  erosion thins them back.
- Distance-based feather (replaces the old uniform GaussianBlur 0.8):
  the alpha ramp is anchored to the ORIGINAL mask edge using Chebyshev
  distance bands. Successive MinFilter(3) erosions give inside rings
  E[0..F] and successive MaxFilter(3) dilations give outside rings
  D[0..F], where F = feather_px. Ring k (0 outside-in) gets alpha
  255*(k+0.5)/(2*F); pixels deeper than E[F] get 255, pixels beyond
  D[F] get 0. The ramp is linear across 2*F pixels, centered on the
  original edge (the two rings straddling the edge average ~128), and
  because each ring is contour-parallel, the transition follows the
  contour instead of blurring it into a uniform halo. The distance
  metric is Chebyshev (8-connected), so corners stay slightly squarer
  than a Euclidean ramp would; at a 3 px feather this is invisible.
  Structures thinner than 2*F px lose their 255 core and turn
  translucent instead of vanishing, which is the honest behaviour for
  a sub-feather-width feature.
- Gradient snap (optional, default OFF): for each mask boundary pixel,
  take the outward normal from the gradient of a lightly blurred mask
  and sample the grayscale image gradient magnitude at offsets -3..3
  px along that normal. The boundary moves to the strongest sample
  ONLY if that sample beats the current position by a margin
  (1.25x and +8 on a 0-255 gradient scale), a noise guard against
  jitter on weak gradients. Moving outward sets the ray pixels to 1,
  moving inward clears them. Implemented with numpy; if numpy is not
  installed the job fails with a clear error instead of silently
  skipping the requested snap (see "Dependencies").
- Footprint shadow (replaces the old generic centered ellipse): the
  shadow follows the physical contact line of the placed piece. For
  each x column of the piece, the contact y is the bottommost piece
  pixel (alpha >= 128). A band is drawn strictly BELOW that profile:
  the band is split into 5 sub-bands of equal depth, sub-band k gets
  alpha strength*(1-(k+0.5)/5), so the shadow is darkest right under
  the contact line and fades to zero at fade_len below it. fade_len
  is min(25% of piece height, free space below the piece on the
  canvas): framing leaves a 90 px bottom margin, so in practice the
  fade is capped by that margin, which guarantees the shadow always
  fades out inside the canvas instead of being cut by its bottom edge.
  A second layer, the same band blurred by shadow_blur at half alpha,
  is composited underneath as the wide soft falloff; the core band is
  composited on top of it. Columns with no piece pixels get no shadow,
  and nothing is drawn above or beside the object.
- Framing: the set fits inside 82% of backdrop width AND 80% of backdrop
  height, aspect ratio kept, so tall portrait sets are never clipped.
  Framing is unchanged from the old worker on purpose: the evaluation
  harness reconstructs final-image coordinates from exactly this rule.

Quality metrics (stdout JSON, raw indicators only, NO absolute score):
- mask_area_fraction: refined-mask pixels with alpha >= 128 divided by
  the full image area. The 128 threshold is the binary interior
  convention shared with the saved mask (see below).
- border_touch: {left, right, top, bottom} booleans; true when any
  binary mask pixel lies on that image border. A touched border means
  the object may be clipped by the frame, not that it is bad.
- edge_roughness: perimeter^2 / (4*pi*area), where perimeter counts
  binary mask pixels with at least one 4-neighbour outside the mask
  (image borders count as outside) and area is the binary pixel count.
  A perfect circle scores 1.0; jagged or clipped contours score higher.
  Scale-invariant, but small masks read rougher from pixelation alone,
  so always read it together with mask_area_fraction. These are
  warnings for a human to look at, never a verdict: a legitimately
  textured object can score high, and a smooth wrong mask scores low.

Mask coordinate contract (mask_output):
- The saved PNG has EXACTLY the original photo's pixel size, and mask
  pixel (x, y) is original pixel (x, y). The piece resize for the
  backdrop never affects it: the mask is saved before any crop/resize,
  from the full-size refined mask.
- Values are alpha 0-255 (feathered when refine is true, binary 0/255
  when refine is false). Binary interior convention: alpha >= 128.
  A future adjust step should threshold at 128 to recover the binary
  mask, apply its own expand, then re-feather; it must NOT assume the
  saved mask is binary.

Color preservation:
- The pre-resize cutout is built with putalpha only: RGB channels are
  copied verbatim from the original wherever the mask is used, so
  pre-resize cutout RGB is bit-identical to original RGB at every
  pixel (alpha alone changes). No brightness, contrast, saturation,
  or color grading is applied anywhere. The backdrop resize resamples
  with LANCZOS, which shifts final-image pixel values slightly; that
  resampling is the only RGB difference between cutout and catalog,
  and the harness measures it as small per-channel diffs.

Backward compatibility:
- A job without any new field runs exactly like before at the API
  level (same inputs, same stdout keys plus the new metric keys) and
  produces a catalog image. The refine/shadow BEHAVIOUR is the rework
  itself (closing instead of erosion, distance feather instead of
  uniform blur, footprint shadow instead of generic ellipse); a
  byte-identical old output is available from the baseline copy
  (dapurstudio-eval/worker-old.py), not from this file.

Dependencies:
- Pillow and meta-sam-parser (as before). Gradient snap additionally
  needs numpy, imported lazily inside gradient_snap so jobs that do
  not request snap never touch it. Deploy note: the container pylibs
  currently holds only meta-sam-parser (plus Pillow); numpy must be
  added there before snap=true is ever used, otherwise such jobs fail
  with "gradient snap needs numpy" instead of running.

Needs: Pillow and meta-sam-parser (see requirements.txt). The parser
decodes the mask records exactly as Meta's API emits them; this script only
parses, clusters, refines, and composites, it does not reimplement the codec.
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter
from meta_sam_parser import (
    CompletedOutcome,
    decode_mask_to_raster,
    image_segmentation_format,
)

ADJACENCY_PX = 25
BINARY_THRESHOLD = 128
FEATHER_DEFAULT_PX = 3
EXPAND_MAX_PX = 20
SHADOW_STRENGTH_DEFAULT = 140
SHADOW_BLUR_DEFAULT = 30
SHADOW_FADE_FRACTION = 0.25
SHADOW_BAND_STEPS = 48
SNAP_WINDOW_PX = 3


def full_mask(original_size, box, mask):
    raster = decode_mask_to_raster(mask)
    small = Image.frombytes(
        "L", (mask.width, mask.height),
        bytes([255 if value else 0 for value in raster]),
    )
    layer = Image.new("L", original_size, 0)
    layer.paste(small, (box.left, box.top))
    return layer


def cluster_masks(original_size, sam_texts):
    """Return (union, kept, dropped) keeping only the serving cluster."""
    layers = []
    for text in sam_texts:
        parser = image_segmentation_format().create_parser()
        parser.push(text)
        result = parser.finish(CompletedOutcome()).result
        boxes = {r.object_id: r for r in result.records if r.kind == "box"}
        for record in result.records:
            if record.kind != "mask":
                continue
            box = boxes.get(record.object_id)
            if box is None:
                continue
            layers.append(full_mask(original_size, box, record.mask))
    if not layers:
        return None, 0, 0
    counts = [sum(1 for v in layer.tobytes() if v) for layer in layers]
    seed = max(range(len(layers)), key=lambda i: counts[i])
    cluster = layers[seed]
    remaining = [layer for i, layer in enumerate(layers) if i != seed]
    kept = 1
    changed = True
    while changed:
        changed = False
        reach = cluster.filter(
            ImageFilter.MaxFilter(ADJACENCY_PX * 2 + 1))
        still = []
        for layer in remaining:
            touching = any(
                r and o for r, o in zip(reach.tobytes(), layer.tobytes()))
            if touching:
                cluster = Image.frombytes(
                    "L", original_size,
                    bytes(a or b for a, b in zip(
                        cluster.tobytes(), layer.tobytes())),
                )
                kept += 1
                changed = True
            else:
                still.append(layer)
        remaining = still
    return cluster, kept, len(remaining)


def threshold_binary(mask, threshold=BINARY_THRESHOLD):
    """L image -> 0/255 binary image at the given threshold."""
    return mask.point(lambda v: 255 if v >= threshold else 0)


def expand_mask(binary_mask, px):
    """Dilate (px > 0) or erode (px < 0) a binary mask by |px| pixels.

    Kernel 2*|px|+1: MaxFilter/MinFilter of size k moves an edge by
    (k-1)/2 px, so the kernel is chosen to move it exactly |px| px.
    Clamped to +/-EXPAND_MAX_PX: larger kernels get slow and a manual
    correction beyond 20 px is no longer a correction.
    """
    px = max(-EXPAND_MAX_PX, min(EXPAND_MAX_PX, px))
    if px > 0:
        return binary_mask.filter(ImageFilter.MaxFilter(2 * px + 1))
    if px < 0:
        return binary_mask.filter(ImageFilter.MinFilter(2 * (-px) + 1))
    return binary_mask


def closing(binary_mask):
    """Conservative closing: MaxFilter(3) then MinFilter(3).

    Fills 1 px holes/gaps and restores the original extent; open gaps
    of 3 px or more survive untouched (see module docstring).
    """
    return binary_mask.filter(ImageFilter.MaxFilter(3)).filter(
        ImageFilter.MinFilter(3))


def distance_feather(binary_mask, feather_px):
    """Binary mask -> alpha mask with a distance-anchored edge ramp.

    Rings from successive MinFilter(3)/MaxFilter(3) passes give the
    Chebyshev distance to the original edge; ring k (0 outside-in)
    gets alpha 255*(k+0.5)/(2*F), deep interior gets 255, outside
    D[F] gets 0. feather_px <= 0 returns the binary mask unchanged.
    """
    feather_px = max(0, int(feather_px))
    if feather_px == 0:
        return binary_mask
    size = binary_mask.size
    eroded = [binary_mask]
    dilated = [binary_mask]
    for _ in range(feather_px):
        eroded.append(eroded[-1].filter(ImageFilter.MinFilter(3)))
        dilated.append(dilated[-1].filter(ImageFilter.MaxFilter(3)))
    alpha = Image.new("L", size, 0)
    width = 2 * feather_px
    for k in range(width):
        if k < feather_px:
            ring = ImageChops.subtract(
                dilated[feather_px - k], dilated[feather_px - k - 1])
        else:
            ring = ImageChops.subtract(
                eroded[k - feather_px], eroded[k - feather_px + 1])
        value = int(round(255 * (k + 0.5) / width))
        alpha.paste(Image.new("L", size, value), (0, 0), ring)
    alpha.paste(Image.new("L", size, 255), (0, 0), eroded[feather_px])
    return alpha


def gradient_snap(binary_mask, gray_image):
    """Shift mask boundary pixels to the strongest nearby image edge.

    For each boundary pixel, the outward normal comes from the gradient
    of a lightly blurred mask, and the grayscale image gradient
    magnitude is sampled at offsets -SNAP_WINDOW_PX..+SNAP_WINDOW_PX
    along that normal. The boundary moves only to a clearly stronger
    edge (1.25x and +8 over the current position on a 0-255 gradient
    scale); otherwise it stays, so weak-gradient noise cannot jitter
    the contour. Requires numpy; raises RuntimeError when missing.
    """
    try:
        import numpy as np
    except ImportError:
        raise RuntimeError(
            "gradient snap needs numpy, which is not installed; "
            "run with snap=false or install numpy")
    gray = np.asarray(gray_image, dtype=np.float64)
    grad_y, grad_x = np.gradient(gray)
    grad_mag = np.hypot(grad_x, grad_y)
    blurred = np.asarray(
        binary_mask.filter(ImageFilter.GaussianBlur(1.0)), dtype=np.float64)
    mask_grad_y, mask_grad_x = np.gradient(blurred)
    mask_norm = np.hypot(mask_grad_x, mask_grad_y)
    eroded = binary_mask.filter(ImageFilter.MinFilter(3))
    mask_bool = np.asarray(binary_mask) > 0
    boundary = mask_bool & ~(np.asarray(eroded) > 0)
    out = mask_bool.copy()
    height, width = mask_bool.shape
    ys, xs = np.nonzero(boundary)
    for y, x in zip(ys, xs):
        norm = mask_norm[y, x]
        if norm < 1e-6:
            continue
        # Mask gradient points inward (0 outside -> 255 inside).
        nx = -mask_grad_x[y, x] / norm
        ny = -mask_grad_y[y, x] / norm
        here = grad_mag[y, x]
        best_t = 0
        best_g = here
        for t in range(-SNAP_WINDOW_PX, SNAP_WINDOW_PX + 1):
            if t == 0:
                continue
            sx = int(round(x + t * nx))
            sy = int(round(y + t * ny))
            if 0 <= sx < width and 0 <= sy < height:
                value = grad_mag[sy, sx]
                if value > best_g:
                    best_g = value
                    best_t = t
        if best_t == 0 or best_g < 1.25 * here + 8:
            continue
        if best_t > 0:
            for s in range(1, best_t + 1):
                sx = int(round(x + s * nx))
                sy = int(round(y + s * ny))
                if 0 <= sx < width and 0 <= sy < height:
                    out[sy, sx] = True
        else:
            for s in range(best_t + 1, 1):
                sx = int(round(x + s * nx))
                sy = int(round(y + s * ny))
                if 0 <= sx < width and 0 <= sy < height:
                    out[sy, sx] = False
    return Image.fromarray(out.astype("uint8") * 255, mode="L")


def refine_mask(mask, feather_px=FEATHER_DEFAULT_PX, expand_px=0,
                snap=False, gray=None):
    """Full refine chain: expand -> close -> snap -> feather.

    Input may be any L mask; it is thresholded to binary first so a
    feathered input can also pass through. Output is an L alpha mask.
    """
    binary = threshold_binary(mask)
    if expand_px:
        binary = expand_mask(binary, expand_px)
    binary = closing(binary)
    if snap:
        if gray is None:
            raise ValueError("gradient snap needs the grayscale original")
        binary = gradient_snap(binary, gray)
    return distance_feather(binary, feather_px)


def quality_metrics(alpha_mask):
    """Raw quality indicators for a final (possibly feathered) mask.

    Binary interior is alpha >= BINARY_THRESHOLD. Returns
    mask_area_fraction, border_touch booleans, and edge_roughness
    (perimeter^2/(4*pi*area), None when the mask is empty). No score.
    """
    width, height = alpha_mask.size
    binary = threshold_binary(alpha_mask)
    area = binary.histogram()[255]
    total = width * height
    fraction = area / total if total else 0.0
    touch = {
        "left": binary.crop((0, 0, 1, height)).getextrema()[1] == 255,
        "right": binary.crop((width - 1, 0, width, height)).getextrema()[1] == 255,
        "top": binary.crop((0, 0, width, 1)).getextrema()[1] == 255,
        "bottom": binary.crop((0, height - 1, width, height)).getextrema()[1] == 255,
    }
    # 4-neighbour interior: a pixel is interior only when all four
    # orthogonal neighbours are inside (shifts fill borders with 0,
    # so border pixels count as outside, matching the definition).
    up = Image.new("L", (width, height), 0)
    up.paste(binary, (0, 1))
    down = Image.new("L", (width, height), 0)
    down.paste(binary, (0, -1))
    left = Image.new("L", (width, height), 0)
    left.paste(binary, (1, 0))
    right = Image.new("L", (width, height), 0)
    right.paste(binary, (-1, 0))
    interior = ImageChops.multiply(
        ImageChops.multiply(up, down), ImageChops.multiply(left, right))
    interior = ImageChops.multiply(interior, binary)
    boundary = ImageChops.subtract(binary, interior)
    perimeter = boundary.histogram()[255]
    roughness = None
    if area:
        roughness = (perimeter * perimeter) / (4.0 * math.pi * area)
    return {
        "mask_area_fraction": round(fraction, 4),
        "border_touch": touch,
        "edge_roughness": round(roughness, 3) if roughness is not None else None,
    }


def dilate_down(img, px):
    """Dilate a 0/255 L image downward by px pixels (binary doubling).

    Dilation amounts add, so px is applied bit by bit: for each set
    bit, the current result is OR-ed with itself shifted down by that
    bit's value. Log2(px) steps instead of px pastes.
    """
    result = img
    step = 1
    remaining = px
    while remaining > 0:
        if remaining & 1:
            shifted = Image.new("L", img.size, 0)
            shifted.paste(result, (0, step))
            result = ImageChops.lighter(result, shifted)
        remaining >>= 1
        step *= 2
    return result


def footprint_shadow(piece_alpha, piece_x, piece_y, canvas_size,
                     strength=SHADOW_STRENGTH_DEFAULT,
                     blur=SHADOW_BLUR_DEFAULT):
    """Return (falloff, core) shadow layers for a placed piece.

    piece_alpha is the piece's alpha (L) after resize; piece_x/piece_y
    is where the piece is pasted on the canvas. The contact line per
    column is the bottommost piece pixel with alpha >= 128; the band
    below it is split into SHADOW_BAND_STEPS sub-bands of equal depth,
    darkest at the contact line, fading to zero at fade_len below it.
    fade_len is min(25% of piece height, free space below the piece),
    so the shadow always fades out inside the canvas. The falloff is
    the core band blurred by `blur` at half alpha, composited under
    the core. Strength is clamped to 0-255, blur to >= 0.
    """
    canvas_w, canvas_h = canvas_size
    strength = max(0, min(255, int(strength)))
    blur = max(0, int(blur))
    binary = threshold_binary(piece_alpha)
    footprint = Image.new("L", (canvas_w, canvas_h), 0)
    footprint.paste(binary, (piece_x, piece_y))
    piece_bottom = piece_y + piece_alpha.height
    space_below = canvas_h - piece_bottom
    fade_len = max(1, min(int(round(SHADOW_FADE_FRACTION * piece_alpha.height)),
                          space_below))
    core = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    dilations = {}
    for k in range(SHADOW_BAND_STEPS + 1):
        d = k * fade_len // SHADOW_BAND_STEPS
        dilations[d] = dilate_down(footprint, d) if d > 0 else footprint
    for k in range(SHADOW_BAND_STEPS):
        d0 = k * fade_len // SHADOW_BAND_STEPS
        d1 = (k + 1) * fade_len // SHADOW_BAND_STEPS
        if d1 <= d0:
            continue
        band = ImageChops.subtract(dilations[d1], dilations[d0])
        alpha = int(round(strength * (1 - (k + 0.5) / SHADOW_BAND_STEPS)))
        if alpha <= 0:
            continue
        core.paste((0, 0, 0, alpha), (0, 0), band)
    red, green, blue, alpha = core.split()
    half = alpha.point(lambda v: v // 2)
    falloff = Image.merge("RGBA", (red, green, blue, half))
    if blur > 0:
        falloff = falloff.filter(ImageFilter.GaussianBlur(blur))
    return falloff, core


def main():
    job = json.loads(Path(sys.argv[1]).read_text())
    original = Image.open(job["original"]).convert("RGB")
    backdrop = Image.open(job["backdrop"]).convert("RGB")
    mask, kept, dropped = cluster_masks(original.size, job["sam_texts"])
    if mask is None or mask.getbbox() is None:
        print(json.dumps({"ok": False, "error": "no mask found"}))
        return 1
    if job.get("refine", True):
        try:
            mask = refine_mask(
                mask,
                feather_px=int(job.get("feather_px", FEATHER_DEFAULT_PX)),
                expand_px=int(job.get("expand_px", 0)),
                snap=bool(job.get("snap", False)),
                gray=original.convert("L"),
            )
        except RuntimeError as error:
            print(json.dumps({"ok": False, "error": str(error)}))
            return 1
    if mask.getbbox() is None:
        print(json.dumps({"ok": False, "error": "mask empty after refine"}))
        return 1
    mask_output = job.get("mask_output")
    if mask_output:
        out_path = Path(mask_output)
        if str(out_path.parent) not in ("", "."):
            out_path.parent.mkdir(parents=True, exist_ok=True)
        mask.convert("L").save(out_path)
    metrics = quality_metrics(mask)
    cutout = original.convert("RGBA")
    cutout.putalpha(mask)
    piece = cutout.crop(mask.getbbox())

    width, height = backdrop.size
    max_w, max_h = int(width * 0.82), int(height * 0.80)
    scale = min(max_w / piece.size[0], max_h / piece.size[1])
    target_w = int(piece.size[0] * scale)
    target_h = int(piece.size[1] * scale)
    piece = piece.resize((target_w, target_h), Image.LANCZOS)
    top = max(20, height - target_h - 90)
    piece_x = (width - target_w) // 2
    falloff, core = footprint_shadow(
        piece.split()[3], piece_x, top, (width, height),
        strength=int(job.get("shadow_strength", SHADOW_STRENGTH_DEFAULT)),
        blur=int(job.get("shadow_blur", SHADOW_BLUR_DEFAULT)),
    )
    canvas = backdrop.convert("RGBA")
    canvas = Image.alpha_composite(canvas, falloff)
    canvas = Image.alpha_composite(canvas, core)
    canvas.paste(piece, (piece_x, top), piece)
    canvas.convert("RGB").save(job["output"])
    result = {
        "ok": True,
        "masks_kept": kept,
        "masks_dropped": dropped,
        "output": job["output"],
    }
    result.update(metrics)
    if mask_output:
        result["mask_output"] = mask_output
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
