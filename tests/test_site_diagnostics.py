import asyncio
import shutil

import pytest

from server import site_diagnostics


@pytest.mark.skipif(not shutil.which("node"), reason="Node is optional for repair diagnostics")
def test_parse_error_uses_html_line_and_skips_inert_content():
    html = """<textarea><script>const =</script></textarea>
<script type="application/json">{"script": ";"}</script>
<template><script>const =</script></template>
<script
  type="text/javascript">
const ok = 1;
const ok = 2;
</script>"""
    assert asyncio.run(site_diagnostics.syntax_feedback(html)) == (
        "HTML line 7: SyntaxError: Identifier 'ok' has already been declared"
    )


@pytest.mark.skipif(not shutil.which("node"), reason="Node is optional for repair diagnostics")
def test_valid_scripts_are_only_parsed_including_modules():
    html = """<script>throw new Error("runtime only");</script>
<script type="module">import value from "./missing.js"; export default value;</script>"""
    assert asyncio.run(site_diagnostics.syntax_feedback(html)) == ""
    invalid = '<script type="module">export const value = ;</script>'
    assert "SyntaxError" in asyncio.run(site_diagnostics.syntax_feedback(invalid))


def test_missing_node_does_not_block_a_repair(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: None)
    assert asyncio.run(site_diagnostics.syntax_feedback("<script>const =</script>")) == ""
