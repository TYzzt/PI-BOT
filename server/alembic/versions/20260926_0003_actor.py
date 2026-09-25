"""阶段 3 记录审批与修改意见的发起方：云端用户或执行设备本身。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260926_0003"
down_revision: str | None = "20260925_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ("approvals", "plan_feedback")


def upgrade() -> None:
    for table in TABLES:
        op.add_column(table, sa.Column("actor", sa.Text(), nullable=False, server_default="user"))
        op.create_check_constraint(f"{table}_actor_check", table, "actor IN ('user', 'device')")


def downgrade() -> None:
    for table in TABLES:
        op.drop_constraint(f"{table}_actor_check", table, type_="check")
        op.drop_column(table, "actor")
