"""Synthetic XML/ZIP test containers; only Python stdlib, no student content."""
from pathlib import Path
from zipfile import ZipFile, ZIP_STORED, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1] / "frontend/src/test/fixtures"
content_types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
body = '''<w:p><w:r><w:t>Synthetic English syllabus</w:t><w:tab/><w:t>Schedule</w:t><w:br/><w:t>Second line</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Assignment 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>29 October 2026</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Синтетическая программа</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Экзамен</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>5 ноября 2026</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>&lt;img src="https://example.invalid/private" onerror="alert(1)"&gt;</w:t></w:r><w:hyperlink r:id="external"><w:r><w:t>Visible external link</w:t></w:r></w:hyperlink></w:p>'''

def write(name, mode, inner, prefix=""):
    xml = prefix + f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>{inner}<w:sectPr/></w:body></w:document>'
    with ZipFile(root / name, "w", compression=mode) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", xml)
        archive.writestr("word/_rels/document.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/private" TargetMode="External"/></Relationships>')

write("extraction-bilingual.docx", ZIP_STORED, body)
write("extraction-bilingual-deflated.docx", ZIP_DEFLATED, body)
write("extraction-unsupported.docx", ZIP_STORED, '<w:p><w:fldSimple w:instr="DATE"><w:r><w:t>Field value</w:t></w:r></w:fldSimple></w:p>')
write("extraction-nested.docx", ZIP_STORED, '<w:tbl><w:tr><w:tc><w:tbl/></w:tc></w:tr></w:tbl>')
write("extraction-empty.docx", ZIP_STORED, '<w:p/>')
write("extraction-entity.docx", ZIP_STORED, '<w:p><w:r><w:t>&external;</w:t></w:r></w:p>', '<!DOCTYPE document [<!ENTITY external SYSTEM "https://example.invalid/private">]>')
