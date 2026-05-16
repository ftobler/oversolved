"""Migration package: auto-discovers versioned migration modules and registers them."""

import importlib
import pkgutil
from typing import Callable

from oversolved.db import Database


def _load_migrations() -> list[tuple[int, str, Callable]]:
    """Import every m*.py submodule and return sorted (version, name, apply) tuples.

    Raises ValueError if duplicate VERSION values are detected.
    """
    migrations: list[tuple[int, str, Callable]] = []
    seen: dict[int, str] = {}

    for info in pkgutil.iter_modules(__path__):  # type: ignore[arg-type]
        if not info.name.startswith("m"):
            continue
        module = importlib.import_module(f"oversolved.migrations.{info.name}")
        version: int = module.VERSION
        name: str = module.NAME
        if version in seen:
            raise ValueError(
                f"Duplicate migration VERSION {version}: "
                f"'{seen[version]}' and '{info.name}'"
            )
        seen[version] = info.name
        migrations.append((version, name, module.apply))

    migrations.sort(key=lambda t: t[0])
    return migrations


def discover_and_register(db: Database) -> list[tuple[int, str, Callable]]:
    """Load all migration modules and register them on db. Returns the sorted list."""
    migrations = _load_migrations()
    for version, name, apply_fn in migrations:
        db.register_migration(version, name, apply_fn)
    return migrations
