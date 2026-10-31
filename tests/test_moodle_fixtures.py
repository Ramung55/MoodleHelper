"""Offline synthetic fixture hygiene; deliberately not a Moodle collector."""

import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

import pytest


ROOT = Path(__file__).parent / "fixtures" / "moodle"
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
ENTRIES = MANIFEST["fixtures"]


def safe_url(value):
    parts = urlsplit(value)
    assert parts.scheme == "https"
    assert parts.hostname and parts.hostname.endswith(".example.invalid")
    assert parts.username is None and parts.password is None
    assert not parts.query and not parts.fragment
    assert parts.port is None


class InertHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.facts = {}
        self.active_fact = None

    def handle_starttag(self, tag, attrs):
        assert tag in {"html", "head", "meta", "title", "body", "h1", "dl", "dt", "dd"}
        assert len(dict(attrs)) == len(attrs)
        for key, value in attrs:
            assert (tag, key) in {("html", "lang"), ("meta", "charset"), ("dd", "data-fact")}
            assert value
            if tag == "meta":
                assert value == "utf-8"
        if tag == "dd":
            self.active_fact = dict(attrs)["data-fact"]
            assert self.active_fact not in self.facts
            self.facts[self.active_fact] = ""

    def handle_endtag(self, tag):
        if tag == "dd":
            self.active_fact = None

    def handle_data(self, data):
        if self.active_fact:
            self.facts[self.active_fact] += data


def declared_paths(entries, root):
    paths = []
    for entry in entries:
        path = Path(entry["path"])
        assert not path.is_absolute() and path.suffix == ".html"
        assert ".." not in path.parts
        target = (root / path).resolve()
        assert target.is_relative_to(root.resolve())
        paths.append(target)
    assert len(paths) == len(set(paths))
    assert set(paths) == {p.resolve() for p in root.rglob("*.html")}


def test_manifest_discovery_and_blocked_observed_coverage():
    declared_paths(ENTRIES, ROOT)
    assert len({entry["id"] for entry in ENTRIES}) == len(ENTRIES)
    assert MANIFEST["observedCoverage"]["status"] == "pending"
    assert MANIFEST["observedCoverage"]["blockedBy"] == 3
    assert {entry["pageClass"] for entry in ENTRIES} >= {
        "course_list", "assignment", "quiz", "calendar", "material", "folder"
    }
    assert {entry["language"] for entry in ENTRIES} == {"en", "ru"}
    assert {case for entry in ENTRIES for case in entry["edgeCases"]} >= {
        "absent_dates", "draft", "reopened", "unknown_status", "login_redirect",
        "denied_access", "duplicates", "malformed_markup", "incomplete_markup",
        "exact_date", "date_only", "ambiguous_date", "individual_override", "nested_folder",
    }


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda entry: entry["id"])
def test_manifest_facts_match_visible_inert_input(entry):
    assert entry["synthetic"] is True and entry["sourceKind"] == "synthetic"
    for key in ("sourceVariant", "language", "purpose", "provenance"):
        assert isinstance(entry[key], str) and entry[key]
    assert entry["provenance"] == "Invented; not captured or inspected."
    assert "inspectionDate" not in entry
    text = (ROOT / entry["path"]).read_text(encoding="utf-8")
    parser = InertHTML()
    parser.feed(text)
    assert f'lang="{entry["language"]}"' in text
    assert "Fictional synthetic fixture" in text
    expected = entry["expected"]
    assert parser.facts == expected["rawFacts"]
    assert not set(expected["absentFields"]) & parser.facts.keys()
    assert set(expected["unknownFields"]) <= {"date", "submission_status"}
    for relation in expected["duplicateRelationships"]:
        assert parser.facts[relation["field"]] == parser.facts[relation["sameAs"]]
    for value in parser.facts.values():
        if value.startswith("https:"):
            safe_url(value)


def test_raw_semantics_preserve_schema_gaps():
    entries = {entry["id"]: entry["expected"] for entry in ENTRIES}
    assignment = entries["assignment"]["rawFacts"]
    assert len({assignment[key] for key in ("base_due", "base_cutoff", "effective_due")}) == 3
    assert assignment["activity_id"] != assignment["course_module_id"]
    assert entries["assignment"]["schemaGapOwners"] == ["13"]
    quiz = entries["quiz"]["rawFacts"]
    assert int(quiz["attempts_allowed"]) - int(quiz["attempts_used"]) == int(quiz["attempts_remaining"])
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", quiz["close_date"])
    assert entries["quiz"]["schemaGapOwners"] == ["14"]
    folder = entries["folder"]["rawFacts"]
    assert folder["child_folder_parent_id"] == folder["folder_id"]
    assert folder["file_parent_id"] == folder["child_folder_id"]
    assert entries["folder"]["schemaGapOwners"] == ["17"]


def test_fixture_text_and_metadata_safety_review_guard():
    for path in ROOT.rglob("*"):
        if path.is_file():
            text = path.read_text(encoding="utf-8")
            assert not re.search(r"(?i)(sesskey|password|authorization|cookie|access_token|session_token)\s*[=:]", text)
            for value in re.findall(r'https://[^\s<>"`]+', text):
                # Documentation issue links are references, never HTML assets.
                if path.suffix == ".md" and value.startswith("https://github.com/Ramung55/MoodleHelper/issues/"):
                    continue
                safe_url(value)


@pytest.mark.parametrize("html", [
    '<script>alert(1)</script>', '<dd onclick="run()">x</dd>',
    '<img src="https://example.invalid/pixel">', '<meta http-equiv="refresh" content="0">',
    '<form action="https://example.invalid"></form>', '<style>body{}</style>',
])
def test_safety_guard_rejects_active_content(html):
    with pytest.raises((AssertionError, KeyError)):
        InertHTML().feed(html)


@pytest.mark.parametrize("url", [
    "https://user:secret@moodle.example.invalid/course", "http://moodle.example.invalid/course",
    "https://moodle.example.invalid/course?key=secret", "https://real.example.org/course",
])
def test_url_guard_rejects_unsafe_references(url):
    with pytest.raises(AssertionError):
        safe_url(url)


def test_path_guard_rejects_escape_and_unmanifested_fixture(tmp_path):
    with pytest.raises(AssertionError):
        declared_paths([{"path": "../escape.html"}], tmp_path)
    (tmp_path / "unmanifested.html").write_text("invented", encoding="utf-8")
    with pytest.raises(AssertionError):
        declared_paths([], tmp_path)
