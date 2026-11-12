FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
RUN npm install --global bun
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
COPY shared/ /app/shared/
COPY extension/src/ /app/extension/src/
RUN MOODLE_HELPER_STATIC=1 npm run build

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS backend-build
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY backend/ ./backend/
COPY shared/ ./shared/

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS runtime
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    MOODLE_HELPER_DATABASE_URL=sqlite:////data/moodle-helper.sqlite3
RUN groupadd --system --gid 10001 moodlehelper \
    && useradd --system --uid 10001 --gid moodlehelper --home-dir /app moodlehelper \
    && mkdir -p /data && chown moodlehelper:moodlehelper /data
COPY --from=backend-build /app/.venv /app/.venv
COPY --from=backend-build /app/backend /app/backend
COPY --from=backend-build /app/shared /app/shared
COPY --from=frontend /app/frontend/.output/public/ ./backend/static/
USER 10001:10001
EXPOSE 8000
CMD ["/app/.venv/bin/uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
