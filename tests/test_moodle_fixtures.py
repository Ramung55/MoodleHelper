"""Offline Moodle fixture hygiene; deliberately not a Moodle collector."""

import datetime as dt
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

import pytest


ROOT = Path(__file__).parent / "fixtures" / "moodle"
REPORT = Path(__file__).parents[1] / "_docs" / "compatibility" / "sdu-moodle.md"
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
ENTRIES = MANIFEST["fixtures"]
SYNTHETIC = [entry for entry in ENTRIES if entry["sourceKind"] == "synthetic"]
OBSERVED = [entry for entry in ENTRIES if entry["sourceKind"] == "observed-structure"]
OBSERVED_HTML = [entry for entry in OBSERVED if entry["path"].endswith(".html")]
OBSERVED_JSON = [entry for entry in OBSERVED if entry["path"].endswith(".json")]
UPSTREAM = [entry for entry in ENTRIES if entry["sourceKind"] == "upstream-string"]
UPSTREAM_LABEL = "upstream, not seen on SDU"
# #16 owner decision (2026-11-02): cited upstream Moodle strings for states SDU did not show.
UPSTREAM_CITATION = {
    "repository": "moodle/moodle",
    "branch": "MOODLE_405_STABLE",
    "commit": "c0690bbc765fccacd4956452cbff3f6aacad77c5",
    "files": ["mod/assign/lang/en/assign.php", "mod/assign/classes/output/renderer.php"],
    "citedDate": "2026-11-02",
}
UPSTREAM_STRINGS = {
    "submissionstatus_draft": ("Draft (not submitted)", "submissionstatusdraft", "draft"),
    "submissionstatus_reopened": ("Reopened", "submissionstatusreopened", "reopened"),
}
OBSERVED_PROVENANCE = (
    "Observed structure from the #3 live SDU inspection: the selectors, classes, data attributes and "
    "label wording that #3 recorded. Details #3 did not record are listed in unrecordedFields, and checks "
    "that assert them are marked basis=assumed. All content, ids and dates are invented. Not a capture."
)

# Moodle-relative paths that observed-structure fixtures may name as inert text.
SAFE_QUERY = re.compile(r"(id=\d+(&action=editsubmission)?|view=day&time=\d+)")
SAFE_RELATIVE = re.compile(
    r"/(my/courses\.php|course/view\.php|mod/[a-z]+/view\.php|calendar/view\.php|login/index\.php"
    r"|pluginfile\.php/\d+/mod_resource/content/\d+/fixture-[a-z-]+\.pdf)"
)


def safe_url(value, allow_ids=False):
    parts = urlsplit(value)
    assert parts.scheme == "https"
    assert parts.hostname and parts.hostname.endswith(".example.invalid")
    assert parts.username is None and parts.password is None
    assert not parts.fragment
    assert parts.port is None
    assert not parts.query or (allow_ids and SAFE_QUERY.fullmatch(parts.query))


def safe_relative(value):
    path, _, query = value.partition("?")
    assert SAFE_RELATIVE.fullmatch(path), value
    assert not query or SAFE_QUERY.fullmatch(query), value


class InertHTML(HTMLParser):
    """Strict allowlist for synthetic data-fact fixtures."""

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


class Node:
    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.parent = tag, attrs, parent
        self.children, self.parts = [], []

    @property
    def classes(self):
        return self.attrs.get("class", "").split()

    def text(self):
        return " ".join("".join(self._chunks()).split())

    def _chunks(self):
        for part in self.parts:
            yield from (part._chunks() if isinstance(part, Node) else [part])

    def walk(self):
        for child in self.children:
            yield child
            yield from child.walk()


class ObservedInertHTML(HTMLParser):
    """Allowlist for observed-structure fixtures: Moodle classes/ids/data-* but nothing active.

    Links keep their target only as a relative path in data-href on an <a> without href; <img> carries
    no src. Scripts, styles, handlers, forms, frames, refresh and any URL-valued attribute are rejected.
    """

    # svg: the decorative, text-less icon in the quiz view dates region (Addendum 4); attributes stay
    # limited to class/id/data-*, so it cannot carry a reference or script.
    TAGS = {"html", "head", "meta", "title", "body", "div", "span", "nav", "ul", "li", "a", "img", "p",
            "h1", "h2", "h3", "h4", "h5", "table", "tbody", "tr", "th", "td", "svg"}
    VOID = {"meta", "img"}
    TOKEN = re.compile(r"[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*")

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", {}, None)
        self.current = self.root

    def handle_starttag(self, tag, attrs):
        assert tag in self.TAGS, tag
        assert len(dict(attrs)) == len(attrs)
        for key, value in attrs:
            allowed = (key in {"class", "id"} or re.fullmatch(r"data-[a-z]+(-[a-z]+)*", key)
                       or (tag, key) in {("html", "lang"), ("meta", "charset"), ("img", "alt")})
            assert allowed, (tag, key)
            assert value is not None
            lowered = value.lower()
            assert "://" not in value and not value.startswith("//"), value
            assert not re.match(r"\s*(javascript|data|vbscript):", lowered), value
            if key in {"class", "id"}:
                assert self.TOKEN.fullmatch(value), value
            if key == "data-href":
                assert tag == "a"
                safe_relative(value)
            if tag == "meta":
                assert value == "utf-8"
        node = Node(tag, dict(attrs), self.current)
        self.current.children.append(node)
        self.current.parts.append(node)
        if tag not in self.VOID:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        assert tag in self.VOID, tag
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        assert tag not in self.VOID
        assert self.current.tag == tag, (self.current.tag, tag)
        self.current = self.current.parent

    def handle_data(self, data):
        self.current.parts.append(data)

    def handle_comment(self, data):
        raise AssertionError("comments are not allowed")

    def handle_pi(self, data):
        raise AssertionError("processing instructions are not allowed")

    def close(self):
        super().close()
        assert self.current is self.root, "unclosed element"


COMPOUND = re.compile(r'([a-z][a-z0-9]*)?((?:[#.][A-Za-z0-9_-]+|\[[a-z-]+(?:[*^]?="[^"]*")?\])*)')
PIECE = re.compile(r'([#.])([A-Za-z0-9_-]+)|\[([a-z-]+)(?:([*^]?=)"([^"]*)")?\]')


def parse_selector(selector):
    steps, combinator = [], " "
    for token in selector.split():
        if token == ">":
            combinator = ">"
            continue
        match = COMPOUND.fullmatch(token)
        assert match, token
        steps.append((combinator, match.group(1), PIECE.findall(match.group(2))))
        combinator = " "
    return steps


def matches_compound(node, tag, pieces):
    if node.tag.startswith("#") or (tag and node.tag != tag):
        return False
    for kind, name, attr, op, value in pieces:
        if kind == "#" and node.attrs.get("id") != name:
            return False
        if kind == "." and name not in node.classes:
            return False
        if attr:
            actual = node.attrs.get(attr)
            if actual is None or (op == "=" and actual != value) or (op == "*=" and value not in actual) \
                    or (op == "^=" and not actual.startswith(value)):
                return False
    return True


def matches(node, steps):
    combinator, tag, pieces = steps[-1]
    if not matches_compound(node, tag, pieces):
        return False
    if len(steps) == 1:
        return True
    parent = node.parent
    if combinator == ">":
        return parent is not None and matches(parent, steps[:-1])
    while parent is not None:
        if matches(parent, steps[:-1]):
            return True
        parent = parent.parent
    return False


def select(root, selector):
    steps = parse_selector(selector)
    return [node for node in root.walk() if matches(node, steps)]


def parse_observed(text):
    parser = ObservedInertHTML()
    parser.feed(text)
    parser.close()
    return parser.root


def json_at(data, path):
    for part in path.split("/"):
        if isinstance(data, list):
            data = data[int(part)]
        else:
            if part not in data:
                return KeyError
            data = data[part]
    return data


def declared_paths(entries, root):
    paths = []
    for entry in entries:
        path = Path(entry["path"])
        assert not path.is_absolute() and path.suffix in {".html", ".json"}
        assert ".." not in path.parts
        target = (root / path).resolve()
        assert target.is_relative_to(root.resolve())
        paths.append(target)
    assert len(paths) == len(set(paths))
    fixtures = [p for p in root.rglob("*") if p.suffix in {".html", ".json"} and p.name != "manifest.json"]
    assert set(paths) == {p.resolve() for p in fixtures}


def matrix_rows():
    """Return {(table, row): status} for the #3 page-variant and navigation tables."""
    rows, table = {}, None
    for line in REPORT.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            table = {"## Page variant matrix": "page-variant-matrix",
                     "## Navigation and access behaviour collectors must handle": "navigation-and-access"}.get(line)
            continue
        if table and line.startswith("| ") and not line.startswith("| ---"):
            cells = [cell.strip() for cell in line.strip("|").split("|")]
            if cells[0] in {"Page family", "Behaviour"}:
                continue
            if table == "page-variant-matrix":
                rows[(table, f"{cells[0]} | {cells[1]}")] = cells[2]
            else:
                rows[(table, cells[0])] = cells[1]
    return rows


def test_manifest_discovery_and_observed_coverage():
    declared_paths(ENTRIES, ROOT)
    assert len({entry["id"] for entry in ENTRIES}) == len(ENTRIES)
    assert {entry["sourceKind"] for entry in ENTRIES} == {"synthetic", "observed-structure", "upstream-string"}
    assert {entry["path"] for entry in UPSTREAM} == {"upstream/assign-draft.html", "upstream/assign-reopened.html"}
    coverage = MANIFEST["observedCoverage"]
    assert coverage["status"] == "covered"
    assert coverage["comparedAgainst"] == {
        "issue": 3, "report": "_docs/compatibility/sdu-moodle.md", "inspectionDate": "2026-11-01",
        "language": "en", "theme": "alpha",
    }
    assert {entry["pageClass"] for entry in ENTRIES} >= {
        "course_list", "assignment", "quiz", "calendar", "material", "folder"
    }
    assert {entry["language"] for entry in SYNTHETIC} == {"en", "ru"}
    assert {case for entry in ENTRIES for case in entry["edgeCases"]} >= {
        "absent_dates", "draft", "reopened", "unknown_status", "login_redirect",
        "denied_access", "duplicates", "malformed_markup", "incomplete_markup",
        "exact_date", "date_only", "ambiguous_date", "individual_override", "nested_folder",
    }


def test_every_observed_matrix_variant_has_an_observed_fixture():
    rows = matrix_rows()
    observed = {key for key, status in rows.items() if status.startswith("Observed")}
    unverified = set(rows) - observed
    assert len(observed) == 17 and len(unverified) == 12
    coverage = MANIFEST["observedCoverage"]
    mapped = {(item["table"], item["matrixRow"]): item["fixtures"] for item in coverage["observedVariants"]}
    assert set(mapped) == observed
    by_id = {entry["id"]: entry for entry in ENTRIES}
    for fixtures in mapped.values():
        assert fixtures and all(by_id[f]["sourceKind"] == "observed-structure" for f in fixtures)
    assert {f for fixtures in mapped.values() for f in fixtures} == {entry["id"] for entry in OBSERVED}
    stated = {(item["table"], item["matrixRow"]): item for item in coverage["unverifiedVariants"]}
    assert set(stated) == unverified
    for item in stated.values():
        assert item["coverage"] == "synthetic-only"
        assert all(by_id[f]["sourceKind"] == "synthetic" for f in item["syntheticFixtures"])
        for f in item.get("upstreamFixtures", []):
            assert by_id[f]["sourceKind"] == "upstream-string"
            assert item["seenOnSdu"] is False and UPSTREAM_LABEL in item["note"]
    # Draft and reopened stay unverified on SDU; only upstream wording backs them.
    upstream_rows = {key[1]: item.get("upstreamFixtures") for key, item in stated.items() if "upstreamFixtures" in item}
    assert upstream_rows == {"Assignment | Draft submission": ["upstream-assign-draft"],
                             "Assignment | Reopened submission": ["upstream-assign-reopened"]}
    assert {f for fixtures in upstream_rows.values() for f in fixtures} == {entry["id"] for entry in UPSTREAM}
    assert all(rows[key].startswith("Unavailable") for key in stated if "upstreamFixtures" in stated[key])


@pytest.mark.parametrize("entry", SYNTHETIC, ids=lambda entry: entry["id"])
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


def check_observed_metadata(entry):
    assert entry["synthetic"] is False
    assert entry["provenance"] == OBSERVED_PROVENANCE
    # The SDU site is English (en/alpha); only its login page defaults to Russian (Addendum 5; #20 fixture).
    assert entry["language"] == ("ru" if entry["id"] == "observed-login-page" else "en")
    assert entry["inspectionDate"] == "2026-11-01" and entry["theme"] == "alpha"
    assert entry["sourceVariant"].startswith("sdu-en-alpha/")
    assert entry["path"].startswith("observed/")
    for key in ("purpose", "pageClass"):
        assert isinstance(entry[key], str) and entry[key]
    assert entry["edgeCases"]
    expected = entry["expected"]
    assert expected["checks"]
    for key in ("absentFields", "redactedFields", "unrecordedFields", "schemaGapOwners"):
        assert isinstance(expected[key], list)
    check_basis_labels(expected)


def check_upstream_metadata(entry):
    """An upstream-string entry carries its label and the full cited source of its one string."""
    assert entry["sourceKind"] == "upstream-string" and entry["synthetic"] is False
    assert entry["label"] == UPSTREAM_LABEL
    assert "Upstream, not seen on SDU." in entry["provenance"] and "Not a capture." in entry["provenance"]
    assert entry["path"].startswith("upstream/") and entry["language"] == "en"
    assert "inspectionDate" not in entry and "theme" not in entry
    assert entry["sourceVariant"].startswith("upstream-moodle-405/")
    assert entry["baseFixture"] == "observed-assign-submitted"
    citation = entry["citation"]
    assert {key: citation.get(key) for key in UPSTREAM_CITATION} == UPSTREAM_CITATION
    assert set(citation) == set(UPSTREAM_CITATION) | {"stringKey", "string", "cellClass"}
    text, cell_class, state = UPSTREAM_STRINGS[citation["stringKey"]]
    assert citation["string"] == text and citation["cellClass"] == cell_class
    assert entry["expected"]["statusCell"] == {"selector": f".submissionstatustable td.{cell_class}", "text": [text]}
    assert entry["expected"]["derived"] == {"submission_status": state, "evidenceBasis": "upstream-not-seen-on-sdu",
                                            "actionRequired": state == "reopened"}
    assert entry["edgeCases"] == [state]


CHECK_KINDS = ("count", "attr", "text", "contains", "includes", "matches", "absent", "length", "equals")


def observed_detail(check):
    """An observed check asserts exactly its own target and kinds, never a free-text detail."""
    target = check.get("selector") or check["path"]
    return f"{target}: {', '.join(kind for kind in CHECK_KINDS if kind in check)}"


def check_basis_labels(expected):
    """Generic observed/assumed guard, applied to every observed-structure entry.

    Every check names the detail it covers in `asserts`. An assumed check must assert a listed
    unrecordedFields entry, and an observed check must not assert any detail listed there, so relabelling
    an assumed check as observed fails unless its detail is also removed from unrecordedFields. Every
    field must be listed in observedFields, and only observed checks may back a field (see
    check_fields_observed), so an unrecorded detail cannot pass silently as an observed one.
    """
    assert list(expected["fields"]) == expected["observedFields"]
    unrecorded = expected["unrecordedFields"]
    assert len(set(unrecorded)) == len(unrecorded)
    for check in expected["checks"]:
        assert check.get("basis") in {"observed", "assumed"}, check
        assert "unrecorded" not in check, check  # replaced by `asserts`
        detail = check.get("asserts")
        assert isinstance(detail, str) and detail.strip(), check
        if check["basis"] == "assumed":
            assert detail in unrecorded, check
        else:
            assert detail not in unrecorded and detail == observed_detail(check), check


def check_fields_observed(expected, verified):
    for name in expected["observedFields"]:
        value = expected["fields"][name]
        assert any(value == seen or (isinstance(seen, str) and isinstance(value, str) and value in seen)
                   for seen in verified), (name, value)


@pytest.mark.parametrize("entry", OBSERVED_HTML, ids=lambda entry: entry["id"])
def test_observed_html_is_inert_and_matches_manifest(entry):
    check_observed_metadata(entry)
    text = (ROOT / entry["path"]).read_text(encoding="utf-8")
    language = entry["language"]
    assert text.startswith(f'<!doctype html>\n<html lang="{language}">')
    root = parse_observed(text)
    assert "(invented content)" in select(root, "title")[0].text()
    assert f"lang-{language}" in select(root, "body")[0].classes
    verified = []
    for check in entry["expected"]["checks"]:
        found = select(root, check["selector"])
        seen = []
        if "count" in check:
            assert len(found) == check["count"], check
        if "attr" in check:
            values = [node.attrs[check["attr"]] for node in found]
            assert values == check["values"], check
            seen += values
        if "text" in check:
            texts = [node.text() for node in found]
            assert texts == check["text"], check
            seen += texts
        if "contains" in check:
            texts = [node.text() for node in found]
            assert all(text in texts for text in check["contains"]), check
            seen += check["contains"]
        if "includes" in check:
            region = " ".join(node.text() for node in found)
            assert all(text in region for text in check["includes"]), check
            seen += check["includes"]
        if "matches" in check:
            # Shape check: each node's text fully matches its pattern; the invented values back no field.
            texts = [node.text() for node in found]
            assert len(texts) == len(check["matches"]), check
            assert all(re.fullmatch(pattern, text) for pattern, text in zip(check["matches"], texts)), check
        if check["basis"] == "observed":
            verified += seen
    check_fields_observed(entry["expected"], verified)


@pytest.mark.parametrize("entry", OBSERVED_JSON, ids=lambda entry: entry["id"])
def test_observed_json_records_match_manifest(entry):
    check_observed_metadata(entry)
    data = json.loads((ROOT / entry["path"]).read_text(encoding="utf-8"))
    verified = []
    for check in entry["expected"]["checks"]:
        value = json_at(data, check["path"])
        if check.get("absent"):
            assert value is KeyError, check
            continue
        assert value is not KeyError, check
        if "length" in check:
            assert len(value) == check["length"], check
        if "equals" in check:
            assert value == check["equals"] and type(value) is type(check["equals"]), check
            if check["basis"] == "observed":
                verified.append(value)
    check_fields_observed(entry["expected"], verified)

    def strings(node):
        if isinstance(node, dict):
            for item in node.values():
                yield from strings(item)
        elif isinstance(node, list):
            for item in node:
                yield from strings(item)
        elif isinstance(node, str):
            yield node

    for value in strings(data):
        assert "<" not in value and not re.match(r"(?i)\s*(javascript|data):", value)
        if value.startswith("https:"):
            safe_url(value, allow_ids=True)
        elif value.startswith("/"):
            safe_relative(value)


@pytest.mark.parametrize("entry", UPSTREAM, ids=lambda entry: entry["id"])
def test_upstream_fixture_is_cited_inert_copy_of_observed_submitted(entry):
    check_upstream_metadata(entry)
    text = (ROOT / entry["path"]).read_text(encoding="utf-8")
    # Same inert-markup allowlist as the observed-structure fixtures.
    root = parse_observed(text)
    assert "lang-en" in select(root, "body")[0].classes
    cell = entry["expected"]["statusCell"]
    assert [node.text() for node in select(root, cell["selector"])] == cell["text"]
    # Only the status cell class and text differ from the observed submitted page.
    by_id = {e["id"]: e for e in ENTRIES}
    base = (ROOT / by_id[entry["baseFixture"]]["path"]).read_text(encoding="utf-8")
    observed_cell = '<td class="submissionstatussubmitted">Submitted for grading</td>'
    citation = entry["citation"]
    assert base.count(observed_cell) == 1
    assert text == base.replace(observed_cell, f'<td class="{citation["cellClass"]}">{citation["string"]}</td>')


@pytest.mark.parametrize("mutate", [
    lambda e: e.pop("label"),
    lambda e: e.update(label="observed on SDU"),
    lambda e: e.pop("citation"),
    lambda e: e["citation"].pop("repository"),
    lambda e: e["citation"].pop("branch"),
    lambda e: e["citation"].update(commit="0580991669815767026aea115a2053e2040378af"),
    lambda e: e["citation"]["files"].pop(),
    lambda e: e["citation"].pop("stringKey"),
    lambda e: e["citation"].update(cellClass="submissionstatussubmitted"),
    lambda e: e["citation"].update(string="Draft"),
    lambda e: e["citation"].pop("citedDate"),
    lambda e: e.update(sourceKind="observed-structure"),
    lambda e: e.update(inspectionDate="2026-11-01"),
], ids=["no-label", "wrong-label", "no-citation", "no-repository", "no-branch", "wrong-commit", "one-file",
        "no-string-key", "wrong-cell-class", "wrong-string", "no-cited-date", "relabelled-observed",
        "claims-inspection"])
def test_upstream_guard_rejects_missing_label_or_citation(mutate):
    import copy
    for original in UPSTREAM:
        entry = copy.deepcopy(original)
        check_upstream_metadata(entry)
        mutate(entry)
        with pytest.raises((AssertionError, KeyError)):
            check_upstream_metadata(entry)


def test_observed_semantics_follow_the_matrix():
    by_id = {entry["id"]: entry["expected"] for entry in OBSERVED}
    ajax = by_id["observed-enrolled-courses-inprogress"]
    data = json.loads((ROOT / "observed/enrolled-courses-inprogress.json").read_text(encoding="utf-8"))
    payload = data[0]["data"]
    derived = ajax["derived"]
    # The nextoffset quirk: it equals the returned count even though the list is exhausted.
    assert payload["nextoffset"] == len(payload["courses"]) == derived["returnedCount"]
    assert derived["returnedCount"] < derived["request"]["limit"] and derived["moreAvailable"] is False
    for course in payload["courses"]:
        code, _, login, year, term = course["shortname"].split("-")
        assert login == "redacted" and year.isdigit() and term.isdigit()
        assert "(" not in course["fullname"]
        assert course["viewurl"].endswith(f"/course/view.php?id={course['id']}")
    assert derived["course_code"] == payload["courses"][0]["shortname"].split("-")[0]

    assert by_id["observed-assign-submitted"]["derived"]["submission_status"] == "submitted"
    assert by_id["observed-assign-not-submitted"]["derived"]["submission_status"] == "not_submitted"
    quiz = by_id["observed-quiz-finished"]["derived"]
    assert quiz["attempts_allowed"] - quiz["attempts_used"] == quiz["attempts_remaining"] == 0
    assert by_id["observed-quiz-finished"]["schemaGapOwners"] == ["14"]

    almaty = dt.timezone(dt.timedelta(hours=5))
    root = parse_observed((ROOT / "observed/calendar-upcoming.html").read_text(encoding="utf-8"))
    boxes = select(root, "div.calendar-event-box")
    for box, event in zip(boxes, by_id["observed-calendar-upcoming"]["derived"]["events"], strict=True):
        assert box.attrs["data-event-title"] == f"{event['title']} is due"
        day, action = select(box, "a")
        assert day.attrs["data-href"].endswith(f"time={event['epoch']}")
        assert action.attrs["data-href"] == f"/mod/assign/view.php?id={event['cmid']}&action=editsubmission"
        local = dt.datetime.fromtimestamp(event["epoch"], almaty)
        assert local.strftime("%I:%M %p").lstrip("0") == event["displayedTime"]
        # #3 recorded only the displayed time; the surrounding date text format is assumed.
        assert event["displayedTime"] in box.text()

    page = parse_observed((ROOT / "observed/course-page.html").read_text(encoding="utf-8"))
    due = select(page, "li#module-990102 [data-region=\"activity-dates\"] > div")[1].text()
    instant = dt.datetime.fromisoformat(by_id["observed-course-page"]["derived"]["dueInstant"])
    assert due == f"Due: {instant:%A}, {instant.day} {instant:%B %Y}, {instant:%I:%M %p}".replace(" 0", " ")

    course_redirect = json.loads((ROOT / "observed/login-redirect-course.json").read_text(encoding="utf-8"))
    file_redirect = json.loads((ROOT / "observed/login-redirect-resource.json").read_text(encoding="utf-8"))
    for record in (course_redirect, file_redirect):
        assert record["response"]["status"] == 200 and record["response"]["finalPath"] == "/login/index.php"
    assert course_redirect["response"]["contentType"] is None  # not recorded in #3
    assert file_redirect["response"]["contentType"] == "text/html"
    assert by_id["observed-not-found"]["derived"]["httpStatus"] == 404


# QA on #4: details #3 never recorded stay labelled as assumed and are never asserted as observed.
UNRECORDED_DETAILS = {
    "observed-course-page": ['"Assignment"', '"Quiz"', '"Forum"', '"Page"'],
    "observed-assign-submitted": ["h3", "table.generaltable"],
    "observed-assign-not-submitted": ["h3", "table.generaltable"],
    "observed-course-list": ["paging-bar inside paging-control-container", "ul.pagination", "a.coursename"],
    "observed-calendar-upcoming": ["Tuesday, 7 March, 2:30 PM"],
    "observed-not-found": ["p wrapper"],
}
# The quiz password notice wording was recorded live in Addendum 6 (2026-11-02), so it is no longer assumed.
UNRECORDED_TEXT = {"Assignment", "Quiz", "Forum", "Page"}


def test_unrecorded_details_are_labelled_assumed():
    by_id = {entry["id"]: entry["expected"] for entry in OBSERVED}
    for fixture, details in UNRECORDED_DETAILS.items():
        expected = by_id[fixture]
        for detail in details:
            assert any(detail in reason for reason in expected["unrecordedFields"]), (fixture, detail)
        for check in expected["checks"]:
            if check["basis"] != "observed":
                continue
            selector = check.get("selector", "")
            assert not UNRECORDED_TEXT & set(check.get("text", []) + check.get("contains", [])), check
            assert " h3" not in selector and "generaltable" not in selector, check
            assert "pagination" not in selector and "coursename" not in selector, check
            assert not re.search(r"paging-control-container.*paging-bar", selector), check
            # The calendar's year-less date text ("Tuesday, 7 March, 2:30 PM") stays unrecorded.
            assert not any(re.search(r"[A-Z][a-z]+day, \d{1,2} [A-Z][a-z]+, ", text)
                           for text in check.get("text", []) + check.get("contains", [])), check
    folder = by_id["observed-folder-empty"]
    assert "fpFilenamePlacement" not in folder["derived"]
    sibling = [c for c in folder["checks"] if c.get("selector") == "div.fp-filename-icon > span.fp-filename"]
    assert sibling and sibling[0]["basis"] == "observed" and "correction" in sibling[0]["note"]



def test_quiz_attempt_values_are_checked_by_observed_format_only():
    expected = {entry["id"]: entry["expected"] for entry in OBSERVED}["observed-quiz-finished"]
    [check] = [c for c in expected["checks"] if c.get("selector", "").endswith(".rui-infobox-content--small")]
    assert check["basis"] == "observed" and "text" not in check and check["contains"] == ["Finished"]
    status, started, completed, duration = check["matches"][:4]
    # Shapes from Addendum 2 of the 2026-11-01 inspection notes.
    assert re.fullmatch(started, "Tuesday, 13 October 2026, 2:30 PM") and started == completed
    assert re.fullmatch(duration, "9 mins 59 secs")
    assert not re.fullmatch(duration, "8 mins")  # minutes-only was not observed


def test_not_found_text_is_observed_and_its_element_assumed():
    expected = {entry["id"]: entry["expected"] for entry in OBSERVED}["observed-not-found"]
    text = "Can't find data record in database."
    observed = [c for c in expected["checks"] if c["basis"] == "observed" and text in c.get("includes", [])]
    assumed = [c for c in expected["checks"] if c["basis"] == "assumed" and c.get("text") == [text]]
    assert observed and observed[0]["selector"] == "body#page-site-index"
    assert assumed and assumed[0]["selector"].endswith(" p") and "p wrapper" in assumed[0]["asserts"]
    assert not any("after 'in database'" in entry for entry in expected["unrecordedFields"])


@pytest.mark.parametrize("mutate", [
    lambda e: e["checks"][0].pop("basis"),
    lambda e: e["checks"][0].update(basis="guessed"),
    lambda e: e["checks"][0].update(basis="assumed"),
    lambda e: e["checks"][0].update(basis="assumed", asserts="not listed"),
    lambda e: e["checks"][0].pop("asserts"),
    lambda e: e["checks"][0].update(asserts=""),
    lambda e: e["checks"][0].update(asserts="markup"),
    lambda e: e["checks"][0].update(unrecorded="markup"),
    lambda e: e["checks"][1].update(basis="observed"),
    lambda e: e["checks"][1].pop("asserts"),
    lambda e: e["checks"][1].update(basis="observed", asserts="renamed detail"),
    lambda e: e["checks"][0].update(asserts="p: count"),
    lambda e: e["observedFields"].pop(),
], ids=["no-basis", "unknown-basis", "assumed-without-listed-detail", "assumed-unlisted", "no-asserts",
        "empty-asserts", "observed-asserts-unrecorded", "legacy-unrecorded-key", "assumed-flipped-to-observed",
        "assumed-without-asserts", "assumed-flipped-and-renamed", "observed-asserts-wrong-kind",
        "field-not-listed"])
def test_basis_guard_rejects_unlabelled_or_unlisted_checks(mutate):
    expected = {
        "fields": {"name": "x"}, "observedFields": ["name"], "unrecordedFields": ["markup"],
        "checks": [{"selector": "p", "text": ["x"], "basis": "observed", "asserts": "p: text"},
                   {"selector": "div > p", "count": 1, "basis": "assumed", "asserts": "markup"}],
    }
    check_basis_labels(expected)
    mutate(expected)
    with pytest.raises(AssertionError):
        check_basis_labels(expected)


def test_field_guard_ignores_values_seen_only_by_assumed_checks():
    expected = {"fields": {"label": "Quiz"}, "observedFields": ["label"]}
    with pytest.raises(AssertionError):
        check_fields_observed(expected, [])
    check_fields_observed(expected, ["Fictional Warm-up Quiz Quiz"])


PERSONAL_PATTERNS = [
    r"\d+[.,]\d+\s*/\s*\d+",  # grade value such as 7.50/10
    r"(?i)\bout of \d",
    r"(?i)\bgrade:\s*\d",
    r"(?i)sesskey",
    r"(?i)moodlesession",
    r"(?i)(password|authorization|cookie|access_token|session_token|wstoken)\s*[=:]",
    r"(?i)sdu\.edu\.kz",
    r"@[a-z0-9-]+\.[a-z]{2,}",  # e-mail addresses
    r"\b[A-Z]{2,}\s?\d{2,4}-\d+-(?!redacted-)[^-\s\"]+-\d{4}-\d\b",  # real instructor-login shortname style
]


# #82: the synthetic /my/courses.php shell holds the one invented session value, and the
# manifest and README describe it. Exactly these texts in exactly these top-level files are
# exempt from the sesskey pattern; any other session value anywhere still fails.
INVENTED_SESSKEY = '"sesskey":"0InventedFixtureKey0"'
SESSKEY_NOTE = "M.cfg sesskey placement assumed from Moodle defaults; not recorded by #3"
ALLOWED_SESSKEY_TEXT = {
    "my-courses-shell.html": [INVENTED_SESSKEY],
    "manifest.json": [json.dumps(INVENTED_SESSKEY)[1:-1], SESSKEY_NOTE],
    "README.md": [INVENTED_SESSKEY, SESSKEY_NOTE],
}


def reviewed_text(path, text):
    for allowed in ALLOWED_SESSKEY_TEXT.get(path.name, []) if path.parent == ROOT else []:
        text = text.replace(allowed, "")
    return text


def test_fixture_text_and_metadata_safety_review_guard():
    for path in ROOT.rglob("*"):
        if path.is_file():
            text = reviewed_text(path, path.read_text(encoding="utf-8"))
            for pattern in PERSONAL_PATTERNS:
                assert not re.search(pattern, text), (path.name, pattern)
            for value in re.findall(r'https://[^\s<>"`]+', text):
                # Documentation issue links are references, never HTML assets.
                if path.suffix == ".md" and value.startswith("https://github.com/Ramung55/MoodleHelper/issues/"):
                    continue
                safe_url(value, allow_ids=path.parent.name == "observed" or path.name == "manifest.json")


def test_sesskey_exemption_is_exactly_the_invented_shell_value():
    shell = ROOT / "my-courses-shell.html"
    text = shell.read_text(encoding="utf-8")
    assert text.count(INVENTED_SESSKEY) == 1
    for other in [text.replace("0InventedFixtureKey0", "a1b2c3d4e5"), text + "sesskey=x",
                  text.replace(INVENTED_SESSKEY, INVENTED_SESSKEY + ' "sesskey":"Other0"')]:
        assert re.search(r"(?i)sesskey", reviewed_text(shell, other))
    # The same texts elsewhere (an observed fixture) are not exempt.
    assert re.search(r"(?i)sesskey", reviewed_text(ROOT / "observed" / "my-courses-shell.html", text))
    entry = next(e for e in SYNTHETIC if e["id"] == "my-courses-shell")
    assert entry["note"] == SESSKEY_NOTE and entry["expected"]["rawFacts"]["session_config"] == INVENTED_SESSKEY


def test_personal_data_guard_rejects_real_shapes():
    samples = ["Marks 7.50/10.00", "sesskey abc", "MoodleSession=x", "ABC 101-1-jdoe-2026-1",
               "CS101-2-a.smith-2026-1", "https://moodle.sdu.edu.kz/course/view.php?id=1"]
    for sample in samples:
        assert any(re.search(pattern, sample) for pattern in PERSONAL_PATTERNS), sample
    assert not any(re.search(p, "DEMO101-1-redacted-2028-1") for p in PERSONAL_PATTERNS)


ACTIVE = [
    '<script>alert(1)</script>', '<dd onclick="run()">x</dd>',
    '<img src="https://example.invalid/pixel">', '<meta http-equiv="refresh" content="0">',
    '<form action="https://example.invalid"></form>', '<style>body{}</style>',
]


@pytest.mark.parametrize("html", ACTIVE)
def test_safety_guard_rejects_active_content(html):
    with pytest.raises((AssertionError, KeyError)):
        InertHTML().feed(html)


@pytest.mark.parametrize("html", ACTIVE + [
    '<a href="/course/view.php?id=1">x</a>', '<a data-href="https://moodle.example.invalid/x">x</a>',
    '<a data-href="javascript:alert(1)">x</a>', '<a data-href="/course/view.php?id=1&sesskey=x">x</a>',
    '<a data-href="/admin/tool.php">x</a>', '<span data-href="/course/view.php?id=1">x</span>',
    '<img class="icon" src="/theme/image.php/alpha/core/1/f/pdf">', '<img srcset="/x.png 1x">',
    '<div style="background:url(x)">x</div>', '<div data-src="//cdn.example.invalid/x.js">x</div>',
    '<div class="a" class="b">x</div>', '<div class="x" onmouseover="run()">x</div>',
    '<svg onload="run()"></svg>', '<iframe srcdoc="x"></iframe>', '<link rel="stylesheet" href="x.css">',
    '<!-- comment -->', '<input type="hidden" name="sesskey" value="x">', '<button>Submit</button>',
    '<div><span>unclosed</div>',
])
def test_observed_guard_rejects_active_or_navigating_content(html):
    with pytest.raises((AssertionError, KeyError)):
        parse_observed(html)


@pytest.mark.parametrize("url", [
    "https://user:secret@moodle.example.invalid/course", "http://moodle.example.invalid/course",
    "https://moodle.example.invalid/course?key=secret", "https://real.example.org/course",
])
def test_url_guard_rejects_unsafe_references(url):
    with pytest.raises(AssertionError):
        safe_url(url)
    with pytest.raises(AssertionError):
        safe_url(url, allow_ids=True)


def test_path_guard_rejects_escape_and_unmanifested_fixture(tmp_path):
    with pytest.raises(AssertionError):
        declared_paths([{"path": "../escape.html"}], tmp_path)
    (tmp_path / "unmanifested.html").write_text("invented", encoding="utf-8")
    with pytest.raises(AssertionError):
        declared_paths([], tmp_path)
    (tmp_path / "unmanifested.html").unlink()
    (tmp_path / "observed").mkdir()
    (tmp_path / "observed" / "stray.json").write_text("{}", encoding="utf-8")
    with pytest.raises(AssertionError):
        declared_paths([], tmp_path)


def test_quiz_body_classes_and_attempt_chain_follow_addendum_3():
    """QA FAIL on #14: the 2026-11-01 Addendum 3 re-check observed the body classes and the live
    attempts chain, and found no `.card` element inside `.rui-attempts-list`."""
    by_id = {entry["id"]: entry["expected"] for entry in OBSERVED}
    quiz, course = by_id["observed-quiz-finished"], by_id["observed-course-page"]

    def observed(expected, selector, kind):
        return [c for c in expected["checks"]
                if c.get("selector") == selector and kind in c and c["basis"] == "observed"
                and "Addendum 3" in c.get("note", "")]

    [body] = observed(quiz, "body#page-mod-quiz-view", "attr")
    assert {"cmid-990103", "course-9001"} <= set(body["values"][0].split())
    [course_body] = observed(course, "body.format-topics", "attr")
    assert "course-9001" in course_body["values"][0].split()
    assert not any(c.startswith("cmid-") for c in course_body["values"][0].split())
    [no_card] = observed(quiz, ".rui-attempts-list .card", "count")
    assert no_card["count"] == 0
    assert observed(quiz, "div.rui-attempts-list > div.w-100 > div.rounded.border.p-3 > h4.card-title.mb-3", "text")
    root = parse_observed((ROOT / "observed/quiz-finished.html").read_text(encoding="utf-8"))
    assert not [node for node in root.walk() if "card" in getattr(node, "classes", ())]


def test_quiz_live_markup_and_weekday_quirk_follow_addendum_4():
    """Live run of the #14 parser (Addendum 4, 2026-11-01): decorative svg in the quiz view dates
    region, p.text-start + div.continuebutton in .box.quizattempt, and the SDU weekday quirk."""
    by_id = {entry["id"]: entry["expected"] for entry in OBSERVED}
    quiz, course = by_id["observed-quiz-finished"], by_id["observed-course-page"]

    def observed(expected, selector):
        return [c for c in expected["checks"] if c.get("selector") == selector and c["basis"] == "observed"
                and "Addendum 4" in c.get("note", "")]

    assert observed(quiz, '[data-region="activity-dates"] > svg')
    assert observed(quiz, ".box.quizattempt > p.text-start")[0]["text"] == ["No more attempts are allowed"]
    assert observed(quiz, ".box.quizattempt > div.continuebutton")[0]["text"] == ["Back to the course"]
    root = parse_observed((ROOT / "observed/quiz-finished.html").read_text(encoding="utf-8"))
    [region] = select(root, '[data-region="activity-dates"]')
    assert region.children[0].tag == "svg" and region.children[0].text() == ""
    assert [child.tag for child in region.children] == ["svg", "div", "div"]

    [dates] = observed(course, 'li.modtype_quiz [data-region="activity-dates"] > div')
    quirk = course["derived"]["quizWeekdayQuirk"]
    page = parse_observed((ROOT / "observed/course-page.html").read_text(encoding="utf-8"))
    opened, closed = (n.text() for n in select(page, f'li#module-{quirk["cmid"]} [data-region="activity-dates"] > div'))
    assert closed in dates["text"] and closed == course["fields"]["quiz_weekday_quirk_close_text"]
    open_at = dt.datetime.fromisoformat(quirk["openInstant"])
    close_at = dt.datetime.fromisoformat(quirk["closeInstant"])
    # Opened is internally consistent; Closed shows a weekday that is wrong for its own numeric date.
    assert opened == f"Opened: {open_at:%A}, {open_at.day} {open_at:%B %Y}, {open_at:%I:%M %p}".replace(" 0", " ")
    assert close_at.date() == open_at.date() and f"{close_at:%A}" == quirk["computedWeekday"]
    assert quirk["shownWeekday"] != quirk["computedWeekday"]
    assert closed == (f"Closed: {quirk['shownWeekday']}, {close_at.day} {close_at:%B %Y}, "
                      f"{close_at:%I:%M %p}").replace(" 0", " ")


def test_m_cfg_user_id_fixture_holds_only_the_recorded_shape_with_an_invented_id():
    # #93 Addendum 7: the location and shape of the signed-in user id, never a real value.
    text = (ROOT / "observed" / "m-cfg-user-id.txt").read_text(encoding="utf-8")
    match = re.fullmatch(r"M\.cfg = (\{.*\});\n", text)
    assert match
    config = json.loads(match[1])
    assert list(config) == ["courseContextId", "contextid", "contextInstanceId", "langrev", "templaterev", "siteId", "userId"]
    assert text.count('"userId":') == 1 and type(config["userId"]) is int
    # Only the invented id used by the tests and the network harness.
    assert config["userId"] == 987650
    assert "sesskey" not in text
