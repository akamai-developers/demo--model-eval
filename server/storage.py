"""Atomic, owner-only storage for local results."""

import json
import os
import secrets
from contextlib import contextmanager
from pathlib import Path
from tempfile import NamedTemporaryFile


@contextmanager
def atomic_text(path: Path, *, replace: bool = True):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False)
    temporary_path = Path(temp.name)
    try:
        with temp:
            yield temp
        if replace:
            temporary_path.replace(path)
        else:
            os.link(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def write_json(path: Path, value: dict, *, indent: int | None = None, replace: bool = True) -> None:
    with atomic_text(path, replace=replace) as output:
        json.dump(value, output, ensure_ascii=False, indent=indent)


def create_json(directory: Path, prefix: str, value: dict, *, indent: int | None = None) -> None:
    """Assign a fresh ID and publish the first complete snapshot without overwriting an existing one."""
    while True:
        value["id"] = f"{prefix}_{secrets.token_hex(4)}"
        path = directory / f"{value['id']}.json"
        try:
            write_json(path, value, indent=indent, replace=False)
            return
        except FileExistsError as exc:
            if exc.filename2 != str(path):  # Only a collision at the final link can use a new ID.
                raise
