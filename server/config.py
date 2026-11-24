"""Settings. Everything comes from .env or the environment."""

import os
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

API_KEY_VARIABLES = ("AKAMAI_API_KEY", "AKAMAI_INFERENCE_API_KEY")


def _api_key() -> str:
    for name in API_KEY_VARIABLES:
        value = os.environ.get(name, "").strip()
        if value and value != "paste_your_key_here":
            return value
    return ""


def _base_url(value: str) -> str:
    """Use TLS for remote inference, and keep credentials out of URLs shown in the UI."""
    message = ("AKAMAI_BASE_URL must be an HTTPS endpoint without credentials, a query or a fragment. "
               "HTTP is supported for loopback endpoints.")
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        parsed.port  # Validate an explicit port before sending any request.
    except ValueError:
        raise ValueError(message) from None
    if (not host or parsed.scheme not in ("https", "http") or parsed.username is not None
            or "?" in value or "#" in value or "\\" in value or any(c.isspace() or ord(c) < 32 for c in value)):
        raise ValueError(message)
    if parsed.scheme == "http" and host != "localhost":
        try:
            loopback = ip_address(host).is_loopback
        except ValueError:
            loopback = False
        if not loopback:
            raise ValueError(message)
    return value.rstrip("/")


BASE_URL = _base_url(os.environ.get("AKAMAI_BASE_URL", "https://api.akamai-inference.com/v1"))
API_KEY = _api_key()

PORT = int(os.environ.get("PORT", "8080"))
DATA = Path(os.environ.get("DATA_DIR", ROOT / "data"))
FIXTURES = Path(__file__).resolve().parent / "fixtures"
WEB_DIST = ROOT / "web" / "dist"

# Requests in flight at once during an eval run.
EVAL_CONCURRENCY = int(os.environ.get("EVAL_CONCURRENCY", "8"))
if EVAL_CONCURRENCY < 1:
    raise ValueError("EVAL_CONCURRENCY must be at least 1.")
