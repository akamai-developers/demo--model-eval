PYTHON ?= python3
.DEFAULT_GOAL := help

.PHONY: help setup build start dev test clean

help:
	@echo "make setup   create .venv, install Python and Node packages, create .env"
	@echo "make build   build the frontend into web/dist"
	@echo "make start   build and serve the app on PORT (default 8080)"
	@echo "make dev     backend with reload on PORT, frontend dev server on 5173"
	@echo "make test    run the tests against a fake endpoint (no key, no network)"
	@echo "make clean   remove the frontend build and test cache"

setup:
	@command -v "$(PYTHON)" >/dev/null || { echo "Setup requires Python 3.12 or newer. Set PYTHON to its executable." >&2; exit 1; }
	@$(PYTHON) -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else "Setup requires Python 3.12 or newer. Run make setup PYTHON=python3.12 to select it.")'
	@command -v npm >/dev/null || { echo "Setup requires Node.js 22.13 or newer with npm." >&2; exit 1; }
	$(PYTHON) -m venv .venv
	.venv/bin/python -m pip install --quiet --upgrade pip==26.3
	.venv/bin/pip install --quiet -r requirements-dev.txt
	cd web && npm ci --engine-strict --no-audit --no-fund
	@if [ ! -e .env ] && [ ! -L .env ]; then \
		(umask 077 && set -C && cat .env.example > .env) && \
		echo "Created .env. Set AKAMAI_API_KEY there or export AKAMAI_INFERENCE_API_KEY."; \
	elif [ -f .env ] && [ ! -L .env ]; then chmod go-rwx .env; fi

.venv/bin/uvicorn .venv/bin/pytest web/node_modules/.bin/vite:
	@echo "Missing $@. Run make setup first." >&2
	@exit 1

build: web/node_modules/.bin/vite
	cd web && npm run build

start: .venv/bin/uvicorn build
	.venv/bin/python -m server

dev: .venv/bin/uvicorn web/node_modules/.bin/vite
	.venv/bin/python -m server --dev

test: .venv/bin/pytest web/node_modules/.bin/vite
	.venv/bin/python -m pytest tests -q
	cd web && npm test
	cd web && npm run typecheck

clean:
	rm -rf web/dist .pytest_cache
