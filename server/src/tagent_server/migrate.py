from alembic.config import Config

from tagent_server.config import project_root


def upgrade_database() -> None:
    root = project_root()
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    from alembic import command

    command.upgrade(cfg, "head")
