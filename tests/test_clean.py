import shutil
import subprocess
from pathlib import Path


def test_clean_keeps_saved_work(tmp_path):
    shutil.copyfile(Path(__file__).resolve().parents[1] / "Makefile", tmp_path / "Makefile")
    saved = [".env", "data/runs/a.json", "data/sites/a/index.html", "data/tasks/a.json"]
    generated = ["web/dist/index.html", ".pytest_cache/README.md"]
    for name in saved + generated:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("keep")

    subprocess.run(["make", "clean"], cwd=tmp_path, check=True, capture_output=True)

    assert all((tmp_path / name).read_text() == "keep" for name in saved)
    assert all(not (tmp_path / name).exists() for name in generated)
