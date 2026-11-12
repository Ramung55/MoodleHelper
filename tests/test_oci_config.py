"""Structural safeguards for the proposed, opt-in OCI Compose stack."""
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]


def test_oci_networks_and_required_gateway_credentials():
    compose = yaml.safe_load((ROOT / "docker-compose.production.yaml").read_text())
    services = compose["services"]
    assert set(services) == {"app", "postgres", "caddy"}
    assert "ports" not in services["app"]
    assert "ports" not in services["postgres"]
    assert services["postgres"]["networks"] == ["database"]
    assert compose["networks"]["database"]["internal"] is True
    assert compose["networks"]["application"]["internal"] is True
    assert "egress" in services["app"]["networks"]
    assert all("${OCI_BIND_ADDRESS:-127.0.0.1}" in port for port in services["caddy"]["ports"])
    assert services["caddy"]["secrets"] == ["caddy_users"]
    assert "test -s /run/secrets/caddy_users" in services["caddy"]["command"][0]
    assert all(service.get("restart") == "unless-stopped" and "healthcheck" in service
               for service in services.values())


def test_proxy_gates_every_route_and_preserves_backend_host():
    config = (ROOT / "Caddyfile.oci").read_text()
    assert "basic_auth {" in config
    assert "import /run/secrets/caddy_users" in config
    assert "reverse_proxy app:8000" in config
    assert "header_up Host localhost" in config
    assert "header_up -Authorization" in config
