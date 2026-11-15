"""Structural safeguards for the private Tailscale Compose deployment (#137)."""
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]


def test_tailscale_compose_is_one_loopback_app_on_sqlite():
    compose = yaml.safe_load((ROOT / "docker-compose.production.yaml").read_text())
    app = compose["services"]["app"]
    assert set(compose["services"]) == {"app"}
    assert app["ports"] == ["127.0.0.1:8000:8000"]
    assert app["volumes"] == ["app-data:/data"]
    assert app["restart"] == "unless-stopped" and "healthcheck" in app
    env = app["environment"]
    assert not any(e.startswith("MOODLE_HELPER_DATABASE_URL") for e in env)
    assert any(e.startswith("MOODLE_HELPER_TAILNET_HOST=${MOODLE_HELPER_TAILNET_HOST:?") for e in env)
    assert not (ROOT / "Caddyfile.oci").exists()


def test_production_env_example_has_only_tailscale_settings():
    keys = {line.split("=", 1)[0] for line in (ROOT / ".env.production.example").read_text().splitlines()
            if line and not line.startswith("#")}
    assert keys == {"MOODLE_HELPER_TAILNET_HOST", "GROQ_API_KEY"}
