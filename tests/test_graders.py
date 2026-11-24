import json

import pytest

from server import config, evals
from server.sites import join_parts


@pytest.mark.parametrize(
    "reply, accepted, passed",
    [
        ("Positive.", ["positive"], True),
        ('"positive"', ["positive"], True),
        ("**42**", ["42"], True),
        ("7.50", ["7.5"], True),
        ("1,000", ["1000"], True),
        ("-3", ["3"], False),
        ("The answer is positive", ["positive"], False),
        ("", ["positive"], False),
        ("They are going.", ["They're going.", "They are going."], True),
    ],
)
def test_match(reply, accepted, passed):
    assert evals.grade("match", reply, accepted)[0] is passed


def test_exact_only_trims():
    assert evals.grade("exact", " yes \n", "yes") == (True, [])
    assert evals.grade("exact", "Yes", "yes") == (False, [])


def test_json_is_strict():
    expected = {"tool": "lookup", "arguments": {"id": 5, "ok": True}}
    assert evals.grade("json", '{"arguments": {"ok": true, "id": 5}, "tool": "lookup"}', expected)[0]
    assert not evals.grade("json", '{"tool": "lookup", "arguments": {"id": 5, "ok": 1}}', expected)[0]
    passed, notes = evals.grade("json", '```json\n{"tool": "lookup"}\n```', expected)
    assert not passed and notes[0].startswith("Not valid JSON")


@pytest.mark.parametrize(("reply", "choice", "values", "envelope"), [
    ('{"tool":"no_action","reason":"unsupported"}', True, True, False),
    ('{"tool":"no_action","arguments":{"reason":"unsupported"}}', True, True, True),
    ('{"tool":"ask_user","arguments":{"field":"id"}}', False, False, True),
    ('{"tool":"no_action","arguments":{"reason":"untrusted_instruction"}}', True, False, True),
    ('I will take no action.', None, None, False),
])
def test_explain_saved_tool_decision(reply, choice, values, envelope):
    expected = {"tool": "no_action", "arguments": {"reason": "unsupported"}}
    archived = {"task": "tool_selection", "output": reply, "expected": expected, "passed": False}
    checks = evals.explain_result(archived)["tool_checks"]
    assert (checks["selection"], checks["arguments"], checks["format"]) == (choice, values, envelope)
    assert "tool_checks" not in archived


def test_checks_report_each_failure():
    reply = "1. Sunny Beans\n2. The Ultimate Morning Cup House\n3. Chalk"
    passed, notes = evals.grade("checks", reply, {"min_items": 5, "max_item_words": 3, "excludes": ["ultimate"]})
    assert not passed
    assert notes == ['Contains "ultimate"', "3 list items. Needs at least 5", "A list item has 5 words. Limit is 3"]
    assert evals.grade("checks", "1. a b\n2. c d", {"min_items": 2, "max_items": 2, "max_item_words": 2}) == (True, [])


def test_every_starter_example_fits_its_grader():
    """A malformed fixture should fail here, not in the middle of a run."""
    tasks = json.loads((config.FIXTURES / "evals.json").read_text())
    assert len(tasks) == 12
    for task in tasks:
        assert task["grader"] in evals.GRADERS
        for example in task["examples"]:
            evals.grade(task["grader"], "anything", example["expected"])
            if task["grader"] == "checks":
                assert set(example["expected"]) <= evals.CHECK_KEYS


def test_join_parts_keeps_only_the_page():
    page = "<!doctype html><html><body>hi</body></html>"
    assert join_parts([f"Sure:\n```html\n{page}\n```\nDone."]) == page
    assert join_parts([page[:20], page[20:]]) == page
    assert join_parts(["<div>no html tag</div>"]) == "<div>no html tag</div>"
