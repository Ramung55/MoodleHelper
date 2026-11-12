.DEFAULT_GOAL := start
.PHONY: help start install run frontend extension test test-backend test-frontend e2e

help:
	@echo make               Start Moodle Helper with your Moodle identity
	@echo make install       Install project dependencies
	@echo make run           Start the backend on port 8000
	@echo make frontend      Start the frontend development server
	@echo make extension     Build the browser extension
	@echo make test          Run backend and frontend tests
	@echo make e2e           Run the Compose browser test

start:
	node scripts/start.cjs

install:
	uv sync
	bun install --cwd frontend

run:
	uv run uvicorn backend.main:app --app-dir . --host 127.0.0.1 --port 8000 --reload --reload-dir backend

frontend:
	bun run --cwd frontend dev

extension:
	bun run --cwd extension build

test: test-backend test-frontend

test-backend:
	uv run pytest

test-frontend:
	bun run --cwd frontend test

e2e:
	node e2e/compose.cjs

