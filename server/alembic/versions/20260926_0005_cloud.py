"""Cloud-executed documents have no owning device."""
import sqlalchemy as sa
from alembic import op

revision = '20260926_0005'
down_revision = '20260926_0004'
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column('shared_documents', 'device_id', existing_type=sa.Uuid(), nullable=True)
    op.alter_column('shared_changes', 'device_id', existing_type=sa.Uuid(), nullable=True)
    op.create_index('shared_documents_cloud_runs', 'shared_documents', ['kind'], postgresql_where=sa.text("device_id IS NULL AND kind = 'chat_run'"))


def downgrade():
    op.drop_index('shared_documents_cloud_runs', table_name='shared_documents')
    op.execute("DELETE FROM shared_changes WHERE device_id IS NULL")
    op.execute("DELETE FROM shared_revisions WHERE document_id IN (SELECT id FROM shared_documents WHERE device_id IS NULL)")
    op.execute("DELETE FROM shared_documents WHERE device_id IS NULL")
    op.alter_column('shared_changes', 'device_id', existing_type=sa.Uuid(), nullable=False)
    op.alter_column('shared_documents', 'device_id', existing_type=sa.Uuid(), nullable=False)
