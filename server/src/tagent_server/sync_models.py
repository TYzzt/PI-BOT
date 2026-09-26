"""Shared documents use explicit versions; private credentials never enter event payloads."""
import uuid
from sqlalchemy import BigInteger, ForeignKey, Identity, Integer, Text, Uuid, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from tagent_server.db import Base

class SharedDocument(Base):
    __tablename__ = 'shared_documents'
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    position: Mapped[int] = mapped_column(BigInteger, Identity(), nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # NULL marks a cloud-executed document (cloud models, cloud conversations and their runs).
    device_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey('devices.device_id'), nullable=True, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    data: Mapped[dict] = mapped_column(JSONB, nullable=False)

class SharedRevision(Base):
    __tablename__ = 'shared_revisions'
    __table_args__ = (UniqueConstraint('document_id', 'version'),)
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    document_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey('shared_documents.id'), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    data: Mapped[dict] = mapped_column(JSONB, nullable=False)

class SharedChange(Base):
    __tablename__ = 'shared_changes'
    cursor: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    device_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey('devices.device_id'), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)

class SharedReceipt(Base):
    __tablename__ = 'shared_receipts'
    id: Mapped[str] = mapped_column(Text, primary_key=True)
    digest: Mapped[str] = mapped_column(Text, nullable=False)
    result: Mapped[dict] = mapped_column(JSONB, nullable=False)
