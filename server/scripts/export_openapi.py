import json
from pathlib import Path

from tagent_server.config import Settings
from tagent_server.main import create_app


def main() -> None:
    app = create_app(
        Settings(
            database_url="postgresql+psycopg://tagent:tagent@localhost:5432/tagent",
            admin_password="export-placeholder",
            jwt_secret="export-placeholder-secret-32chars-min",
        )
    )
    destination = Path(__file__).resolve().parents[1] / "openapi.json"
    destination.write_text(json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
