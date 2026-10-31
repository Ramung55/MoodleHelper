"""Synthetic bilingual teaching-week DOCX fixture, Python standard library only."""
from pathlib import Path
from zipfile import ZipFile, ZIP_STORED

target = Path(__file__).resolve().parents[1] / "frontend/src/test/fixtures/teaching-weeks.docx"
types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
rows = ["Exam Week 6", "Экзамен неделя 6", "Assignment Week 31", "Quiz Week 2–3"]
body = ''.join(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>' for text in rows)
with ZipFile(target, "w", compression=ZIP_STORED) as archive:
    archive.writestr("[Content_Types].xml", types)
    archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    archive.writestr("word/document.xml", f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr/></w:body></w:document>')
