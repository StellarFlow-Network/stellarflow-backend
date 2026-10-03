"""app/models/portfolio.py — ORM models for multi-address wallet aggregation and portfolio indexing.

Tables:
  wallet_group           — user-defined wallet groups for unified portfolio view
  wallet_group_member    — Stellar public keys grouped under a wallet group
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import (
    DateTime,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class WalletGroup(Base):
    """User-defined wallet group for unified portfolio view.

    Attributes
    ----------
    id : str
        Unique wallet group identifier.
    user_id : int
        Reference to the Relayer (user) who owns this group.
    name : str
        Human-readable name for the wallet group.
    description : str
        Optional description of the wallet group.
    is_default : bool
        Whether this is the user's default wallet group.
    metadata : dict
        Additional group configuration.
    created_at : datetime
        Group creation timestamp.
    updated_at : datetime
        Last update timestamp.
    """

    __tablename__ = "wallet_group"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        comment="Unique wallet group identifier",
    )

    user_id: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        index=True,
        comment="Reference to Relayer (user) who owns this group",
    )

    name: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        comment="Human-readable name for the wallet group",
    )

    description: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
        comment="Optional description of the wallet group",
    )

    is_default: Mapped[bool] = mapped_column(
        nullable=False,
        server_default=text("false"),
        comment="Whether this is the user's default wallet group",
    )

    metadata: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Additional group configuration",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        comment="Group creation timestamp",
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        onupdate=text("now()"),
        comment="Last update timestamp",
    )

    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_wallet_group_user_name"),
        Index("ix_wallet_group_user_default", "user_id", "is_default"),
    )

    def __repr__(self) -> str:
        return f"<WalletGroup id={self.id} user_id={self.user_id} name={self.name}>"


class WalletGroupMember(Base):
    """Stellar public key member of a wallet group.

    Attributes
    ----------
    id : str
        Unique member identifier.
    wallet_group_id : str
        Reference to the parent wallet group.
    public_key : str
        Stellar public key (G-prefixed 56-character string).
    label : str
        Optional label for this specific wallet.
    is_primary : bool
        Whether this is the primary wallet in the group.
    metadata : dict
        Additional member configuration.
    created_at : datetime
        Member addition timestamp.
    updated_at : datetime
        Last update timestamp.
    """

    __tablename__ = "wallet_group_member"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        comment="Unique member identifier",
    )

    wallet_group_id: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        index=True,
        comment="Reference to parent wallet group",
    )

    public_key: Mapped[str] = mapped_column(
        String(56),
        nullable=False,
        index=True,
        comment="Stellar public key (G-prefixed)",
    )

    label: Mapped[Optional[str]] = mapped_column(
        String(128),
        nullable=True,
        comment="Optional label for this wallet",
    )

    is_primary: Mapped[bool] = mapped_column(
        nullable=False,
        server_default=text("false"),
        comment="Whether this is the primary wallet in the group",
    )

    metadata: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Additional member configuration",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        comment="Member addition timestamp",
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        onupdate=text("now()"),
        comment="Last update timestamp",
    )

    __table_args__ = (
        UniqueConstraint("wallet_group_id", "public_key", name="uq_wallet_group_member_group_key"),
        Index("ix_wallet_group_member_public_key", "public_key"),
    )

    def __repr__(self) -> str:
        return (
            f"<WalletGroupMember id={self.id} group_id={self.wallet_group_id} "
            f"public_key={self.public_key[:12]}...>"
        )
