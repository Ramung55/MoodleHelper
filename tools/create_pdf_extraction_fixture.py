"""Generate synthetic, non-student #25 evidence using bundled authoring tools.

Run with the bundled Python (reportlab/Pillow), passing a Cyrillic-capable TTF.
This is fixture authoring only, not an application dependency or extraction path.
"""
import sys
from pathlib import Path
from reportlab.pdfgen.canvas import Canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw

pdfmetrics.registerFont(TTFont("FixtureFont", sys.argv[1]))
target = Path(__file__).resolve().parents[1] / "frontend/src/test/fixtures/extraction-bilingual.pdf"
c = Canvas(str(target), pagesize=(500, 400), pageCompression=0, invariant=1)
c.setTitle("Synthetic bilingual syllabus extraction fixture")
for heading, rows in [
    ("Synthetic English syllabus", [("Assignment 1", "29 October 2026"), ("Quiz 2", "5 November 2026")]),
    ("Синтетическая программа", [("Задание 1", "29 октября 2026"), ("Экзамен", "5 ноября 2026")]),
]:
    c.setFont("FixtureFont", 16)
    c.drawString(35, 350, heading)
    c.setFont("FixtureFont", 12)
    for y, (assessment, date) in zip([290, 245], rows):
        c.drawString(40, y, assessment)
        c.drawString(260, y, date)
        c.line(35, y - 10, 465, y - 10)
    c.showPage()
image = Image.new("RGB", (400, 160), "white")
ImageDraw.Draw(image).text((20, 40), "Synthetic image-only page - OCR needed", fill="black")
c.drawImage(ImageReader(image), 40, 150, width=400, height=160)
c.showPage()
c.showPage()  # A genuinely blank page is distinct from an image-only page.
c.save()
print(target)
