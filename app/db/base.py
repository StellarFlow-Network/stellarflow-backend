"""app/db/base.py — shared SQLAlchemy declarative base.

Kept in its own module (rather than in :mod:`app.db.session`) so that ORM
model modules can import the base without pulling in the engine, the session
factory, and the ``DATABASE_URL`` requirement that comes with them.
"""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Shared declarative base for all StellarFlow ORM models."""
