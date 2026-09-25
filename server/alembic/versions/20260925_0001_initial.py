"""阶段 1 身份与项目目录。不保存代码路径或源码。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260925_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("user_id", sa.Uuid(), primary_key=True),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("singleton", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("singleton", name="users_singleton_key"),
    )
    op.create_table(
        "pairing_codes",
        sa.Column("pairing_code_id", sa.Uuid(), primary_key=True),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("code_hash", name="pairing_codes_code_hash_key"),
    )
    op.create_table(
        "devices",
        sa.Column("device_id", sa.Uuid(), primary_key=True),
        sa.Column("public_key", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("capabilities", postgresql.JSONB(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "devices_active_public_key",
        "devices",
        ["public_key"],
        unique=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )
    op.create_table(
        "device_nonces",
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("devices.device_id"), primary_key=True),
        sa.Column("nonce", sa.Text(), primary_key=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("device_nonces_expires_at", "device_nonces", ["expires_at"])
    op.create_table(
        "projects",
        sa.Column("project_id", sa.Uuid(), primary_key=True),
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("devices.device_id"), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("availability", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("availability IN ('available', 'unavailable')", name="projects_availability_check"),
    )
    op.create_index("projects_device_id", "projects", ["device_id"])


def downgrade() -> None:
    op.drop_index("projects_device_id", table_name="projects")
    op.drop_table("projects")
    op.drop_index("device_nonces_expires_at", table_name="device_nonces")
    op.drop_table("device_nonces")
    op.drop_index("devices_active_public_key", table_name="devices")
    op.drop_table("devices")
    op.drop_table("pairing_codes")
    op.drop_table("users")
