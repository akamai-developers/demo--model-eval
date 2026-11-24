"""Launch the local app with the backend port configured in .env."""

import argparse
import os
import signal
import subprocess
import sys
import time

import uvicorn

from . import config


def develop() -> int:
    """Run both dev servers and stop both when either exits."""
    backend = [
        sys.executable, "-m", "uvicorn", "server.app:app", "--host", "127.0.0.1",
        "--port", str(config.PORT), "--reload", "--reload-dir", "server",
    ]
    processes = []
    stopping = False

    def request_stop(signum, frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        processes.append(subprocess.Popen(backend, cwd=config.ROOT, start_new_session=True))
        processes.append(subprocess.Popen(
            ["npm", "run", "dev"], cwd=config.ROOT / "web", start_new_session=True,
            env={k: v for k, v in os.environ.items() if k not in config.API_KEY_VARIABLES}
                | {"PORT": str(config.PORT)},
        ))
        while not stopping:
            for process in processes:
                code = process.poll()
                if code is not None:
                    return code if code >= 0 else 128 - code
            time.sleep(0.1)
        return 0
    finally:
        for process in processes:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for process in processes:
            process.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dev", action="store_true", help="run the reload server and Vite")
    if parser.parse_args().dev:
        sys.exit(develop())
    uvicorn.run("server.app:app", host="127.0.0.1", port=config.PORT)
