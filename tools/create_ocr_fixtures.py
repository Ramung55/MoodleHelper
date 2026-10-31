"""Synthetic scanned PDF/OCR images, authored with bundled Pillow/ReportLab."""
import sys
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import ImageReader

root = Path(__file__).resolve().parents[1] / "frontend/src/test/fixtures"
font = ImageFont.truetype(sys.argv[1], 48)
images = []
for language, lines in [("eng", ["Assignment 1", "Due 29 October 2026"]), ("rus", ["Экзамен", "5 ноября 2026"])]:
    image = Image.new("RGB", (1100, 320), "white")
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(lines):
        draw.text((60, 70 + index * 80), line, fill="black", font=font)
    image.save(root / f"ocr-{language}.png")
    images.append(image)
random.seed(27)
noise = Image.new("RGB", (1100, 320))
noise.putdata([(value, value, value) for value in [random.randrange(110, 146) for _ in range(1100 * 320)]])
noise = noise.filter(ImageFilter.GaussianBlur(2))
noise.save(root / "ocr-unreadable.png")
images.append(noise)
canvas = Canvas(str(root / "ocr-scanned.pdf"), pagesize=(660, 192), invariant=1)
canvas.setTitle("Synthetic bilingual scanned OCR fixture")
for image in images:
    canvas.drawImage(ImageReader(image), 0, 0, width=660, height=192)
    canvas.showPage()
canvas.save()
