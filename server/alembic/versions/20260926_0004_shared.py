"""Shared conversations, versioned models and encrypted credentials."""
from alembic import op
from tagent_server.sync_models import SharedDocument, SharedRevision, SharedChange, SharedReceipt
revision = '20260926_0004'
down_revision = '20260926_0003'
branch_labels = None
depends_on = None

def upgrade():
    for model in (SharedDocument, SharedRevision, SharedChange, SharedReceipt):
        model.__table__.create(op.get_bind())

def downgrade():
    for model in (SharedReceipt, SharedChange, SharedRevision, SharedDocument):
        model.__table__.drop(op.get_bind())
