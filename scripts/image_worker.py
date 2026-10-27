#!/usr/bin/env python3
"""Decode SAM 3.1 segmentation texts, union the masks, and composite the
serving set onto a studio backdrop.

Usage:
  python3 scripts/image_worker.py <job.json>

job.json fields:
  original: path to the seller photo
  backdrop: path to the generated studio backdrop
  sam_texts: list of SAM Responses API output texts (one per prompt)
  output: path for the final catalog PNG

Needs: Pillow and meta-sam-parser (see requirements.txt). The parser
decodes the mask records exactly as Meta's API emits them; this script only
parses, unions, and composites, it does not reimplement the codec.
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


def union_mask(original_size, sam_texts):
    canvas = Image.new("L", original_size, 0)
    found = 0
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
            mask = record.mask
            raster = decode_mask_to_raster(mask)
            small = Image.frombytes(
                "L", (mask.width, mask.height),
                bytes([255 if value else 0 for value in raster]),
            )
            layer = Image.new("L", original_size, 0)
            layer.paste(small, (box.left, box.top))
            canvas = Image.frombytes(
                "L", original_size,
                bytes(a or b for a, b in zip(canvas.tobytes(), layer.tobytes())),
            )
            found += 1
    return canvas, found


def main():
    job = json.loads(Path(sys.argv[1]).read_text())
    original = Image.open(job["original"]).convert("RGB")
    backdrop = Image.open(job["backdrop"]).convert("RGB")
    mask, found = union_mask(original.size, job["sam_texts"])
    bbox = mask.getbbox()
    if bbox is None or found == 0:
        print(json.dumps({"ok": False, "error": "no mask found"}))
        return 1
    cutout = original.convert("RGBA")
    cutout.putalpha(mask)
    piece = cutout.crop(bbox)

    width, height = backdrop.size
    target_w = int(width * 0.82)
    target_h = int(target_w * piece.size[1] / piece.size[0])
    piece = piece.resize((target_w, target_h), Image.LANCZOS)
    top = height - target_h - 90
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
    print(json.dumps({"ok": True, "masks": found, "bbox": bbox,
                      "output": job["output"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
