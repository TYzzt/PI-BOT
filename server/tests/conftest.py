import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from testcontainers.community.postgres import PostgresContainer

from tagent_server.main import create_app

SERVER_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session", autouse=True)
def server_cwd() -> None:
    os.chdir(SERVER_ROOT)


@pytest.fixture(scope="session")
def database_url() -> str:
    with PostgresContainer("postgres:16-alpine", username="tagent", password="tagent", dbname="tagent", driver="psycopg") as postgres:
        yield postgres.get_connection_url()


@pytest.fixture
def client(database_url: str, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("T_AGNET_DATABASE_URL", database_url)
    monkeypatch.setenv("T_AGNET_ADMIN_PASSWORD", "test-password")
    monkeypatch.setenv("T_AGNET_JWT_SECRET", "test-jwt-secret-must-be-32-characters")
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
        with app.state.engine.begin() as connection:
            connection.execute(
                text(
                    "TRUNCATE events, device_event_sequences, commands, plan_feedback, runs, approvals, plans, tasks, "
                    "device_nonces, projects, devices, pairing_codes, users RESTART IDENTITY CASCADE"
                )
            )
