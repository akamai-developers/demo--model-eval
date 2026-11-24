"""Locate a syntax error in saved inline JavaScript when preparing a repair."""

import asyncio
import json
import re
import shutil
from html.parser import HTMLParser


class _InlineScripts(HTMLParser):
    CDATA_CONTENT_ELEMENTS = ("script", "style", "textarea", "title", "iframe", "xmp", "noembed", "noframes", "noscript")

    def __init__(self):
        super().__init__()
        self.scripts = []
        self.current = None
        self.template_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag == "template":
            self.template_depth += 1
        if tag != "script" or self.template_depth:
            return
        attr = dict(attrs)
        kind = (attr.get("type") or "").strip().lower()
        if "src" not in attr and kind in ("", "text/javascript", "application/javascript", "module"):
            line = self.getpos()[0] + self.get_starttag_text().count("\n")
            self.current = {"line": line, "module": kind == "module", "code": ""}

    def handle_data(self, data):
        if self.current is not None:
            self.current["code"] += data

    def handle_endtag(self, tag):
        if tag == "template":
            self.template_depth = max(0, self.template_depth - 1)
        if tag == "script" and self.current is not None:
            self.scripts.append(self.current)
            self.current = None


# Compile generated source as data. Neither constructor runs the script, and
# modules are never linked or evaluated. A single process handles the page.
_PARSE = r"""
const fs = require('node:fs');
const vm = require('node:vm');
for (const script of JSON.parse(fs.readFileSync(0, 'utf8'))) {
  try {
    if (script.module) {
      new vm.SourceTextModule(script.code, {identifier: 'page.html', lineOffset: script.line - 1});
    } else {
      new vm.Script(script.code, {filename: 'page.html', lineOffset: script.line - 1});
    }
  } catch (error) {
    if (error.name === 'SyntaxError') {
      const match = /^page\.html:(\d+)\b/m.exec(error.stack);
      process.stdout.write(JSON.stringify({line: match ? Number(match[1]) : null, start: script.line,
                                           error: error.message.slice(0, 250)}));
      break;
    }
  }
}
"""


async def syntax_feedback(html: str) -> str:
    node = shutil.which("node")
    if not node:
        return ""
    parser = _InlineScripts()
    try:
        parser.feed(html)
        parser.close()
    except (AssertionError, ValueError):
        return ""
    if not parser.scripts:
        return ""
    try:
        process = await asyncio.create_subprocess_exec(
            node, "--no-warnings", "--experimental-vm-modules", "-e", _PARSE,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env={},
        )
    except OSError:
        return ""
    try:
        data, _ = await asyncio.wait_for(process.communicate(json.dumps(parser.scripts).encode()), timeout=4)
    except TimeoutError:
        return ""
    finally:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()
    if process.returncode or not data:
        return ""
    issue = json.loads(data)
    message = re.sub(r"\s+", " ", issue["error"]).strip()
    if issue["line"] is None:
        return f"Inline script starting at HTML line {issue['start']}: SyntaxError: {message}"
    line = issue["line"]
    return f"HTML line {line}: SyntaxError: {message}"
