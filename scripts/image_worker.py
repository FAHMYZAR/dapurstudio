#!/usr/bin/env python3
"""Decode SAM 3.1 segmentation texts, keep only the serving set, refine the
mask, and composite the set onto a studio backdrop.

Usage:
  python3 scripts/image_worker.py <job.json>

job.json fields:
  original: path to the seller photo
  backdrop: path to the studio backdrop template
  sam_texts: list of SAM Responses API output texts (one per prompt)
  output: path for the final catalog PNG
  refine: optional bool, default true; apply edge refinement

Rules, all verified against real photos during the hackathon:
- One set: every serving object the seller photographed stays. Generic
  prompts ("cup", "glass") can also match kitchenware that is not part of
  the serving, so masks are clustered by adjacency: the largest mask seeds
  the cluster, and only masks touching the cluster (within 25 px) join it.
  A distant pot on the stove is dropped, a mug behind the plate is kept.
- Edge refinement: 1 px erosion (MinFilter 3) removes background
  contamination, then a light 0.8 blur anti-aliases the contour. Values are
  a starting experiment, not gospel; compare visually before changing them.
- Framing: the set fits inside 82% of backdrop width AND 80% of backdrop
  height, aspect ratio kept, so tall portrait sets are never clipped.

Needs: Pillow and meta-sam-parser (see requirements.txt). The parser
decodes the mask records exactly as Meta's API emits them; this script only
parses, clusters, refines, and composites, it does not reimplement the codec.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter
from meta_sam_parser import (
    CompletedOutcome,
    decode_mask_to_raster,
    image_segmentation_format,
)

ADJACENCY_PX = 25


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


def refine_mask(mask):
    refined = mask.filter(ImageFilter.MinFilter(3))
    return refined.filter(ImageFilter.GaussianBlur(0.8))


def main():
    job = json.loads(Path(sys.argv[1]).read_text())
    original = Image.open(job["original"]).convert("RGB")
    backdrop = Image.open(job["backdrop"]).convert("RGB")
    mask, kept, dropped = cluster_masks(original.size, job["sam_texts"])
    if mask is None or mask.getbbox() is None:
        print(json.dumps({"ok": False, "error": "no mask found"}))
        return 1
    if job.get("refine", True):
        mask = refine_mask(mask)
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
    canvas = backdrop.convert("RGBA")
    shadow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(shadow)
    center_x, bottom = width // 2, top + target_h - 10
    draw.ellipse(
        [center_x - target_w // 2 + 60, bottom - 40,
         center_x + target_w // 2 - 60, bottom + 60],
        fill=(0, 0, 0, 110),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(30))
    canvas = Image.alpha_composite(canvas, shadow)
    canvas.paste(piece, ((width - target_w) // 2, top), piece)
    canvas.convert("RGB").save(job["output"])
    print(json.dumps({"ok": True, "masks_kept": kept,
                      "masks_dropped": dropped, "output": job["output"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
