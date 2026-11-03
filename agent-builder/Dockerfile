FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

# Standalone project build (build context = this folder). The old
# agent-warehouse image copied the whole uv workspace (root manifest +
# lockfile + every member's pyproject.toml) — none of that is needed now:
# this folder carries its own manifest and lockfile.
COPY pyproject.toml uv.lock ./

# Virtual project ([tool.uv] package = false): sync installs only the
# third-party dependencies — the heavy download layer, cached unless the
# manifest or lockfile changes.
RUN uv sync --frozen --no-dev

# Copy the service source (including the vendored agents_shared/ package).
COPY . .

# Run from this directory so `main:app` (uvicorn import string) and the
# flat `from catalog import ...` / `from dispatcher import ...` /
# `from agents_shared.auth import ...` imports resolve.
CMD ["uv", "run", "--no-sync", "python", "main.py"]
