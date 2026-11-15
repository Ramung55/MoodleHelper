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


def test_app_runs_the_ghcr_image_tagged_by_release():
    app = yaml.safe_load((ROOT / "docker-compose.production.yaml").read_text())["services"]["app"]
    assert app["image"] == "ghcr.io/ramung55/moodlehelper:${MOODLE_HELPER_RELEASE:-local}"
    assert app["build"] == "."
    assert "MOODLE_HELPER_RELEASE=${MOODLE_HELPER_RELEASE:-local}" in app["environment"]


def test_ci_publishes_only_on_main_and_has_no_aws_deploy():
    text = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    jobs = yaml.safe_load(text)["jobs"]
    assert "deploy" not in jobs
    assert not any(word in text.lower() for word in ("aws", "ecs", "ecr"))
    publish = jobs["publish"]
    assert publish["if"] == "github.event_name == 'push' && github.ref == 'refs/heads/main'"
    assert publish["needs"] == ["backend", "frontend", "compose"]
    assert publish["permissions"] == {"contents": "read", "packages": "write"}
    assert all("packages" not in job.get("permissions", {}) for name, job in jobs.items() if name != "publish")
    assert 'ghcr.io/ramung55/moodlehelper:${GITHUB_SHA}' in text


def test_deploy_script_keeps_the_volume():
    script = (ROOT / "scripts" / "deploy.sh").read_text()
    assert "/data/pre-deploy.sqlite3" in script and "up -d --no-build --wait" in script
    assert not any(bad in script for bad in ("--volumes", "volume rm", "prune", "rm .env.production"))
    assert script.rstrip().endswith('main "$@"')


def test_dev_override_is_isolated_demo_only():
    class Loader(yaml.SafeLoader):
        pass
    # Compose's !override/!reset tags: keep the node's plain value.
    Loader.add_multi_constructor("!", lambda loader, _tag, node: loader.construct_sequence(node)
                                 if isinstance(node, yaml.SequenceNode) else None)
    dev = yaml.load((ROOT / "docker-compose.dev.yaml").read_text(), Loader=Loader)
    app = dev["services"]["app"]
    assert dev["name"] == "moodlehelper-dev"
    assert app["ports"] == ["127.0.0.1:8001:8000"]
    assert app["volumes"] == ["app-data-dev:/data"]
    assert dev["volumes"] == {"app-data": None, "app-data-dev": {}}
    names = {e.split("=", 1)[0] for e in app["environment"]}
    assert names == {"MOODLE_HELPER_TAILNET_HOST", "MOODLE_HELPER_TAILNET_PORT", "MOODLE_HELPER_RELEASE", "MOODLE_HELPER_DATASET"}
    assert "MOODLE_HELPER_DATASET=demo" in app["environment"] and "MOODLE_HELPER_TAILNET_PORT=8443" in app["environment"]
    keys = {line.split("=", 1)[0] for line in (ROOT / ".env.dev.example").read_text().splitlines()
            if line and not line.startswith("#")}
    assert keys == {"MOODLE_HELPER_TAILNET_HOST", "MOODLE_HELPER_RELEASE"}
