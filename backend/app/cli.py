"""Command line: python -m app.cli [migrate|seed|init|reset]"""

from __future__ import annotations

import argparse
import shutil

from alembic import command
from alembic.config import Config

from app.config import BACKEND_DIR, get_settings


def migrate() -> None:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    command.upgrade(cfg, "head")


def main() -> None:
    p = argparse.ArgumentParser(description="AgentOps Desk management")
    p.add_argument("command", choices=["migrate", "seed", "init", "reset"])
    p.add_argument("--no-workflows", action="store_true", help="seed reference data only")
    args = p.parse_args()
    if args.command == "reset":
        s = get_settings()
        if not s.database_url.startswith("sqlite"):
            raise SystemExit("reset only deletes local SQLite databases; drop the database manually for Postgres")
        db_path = s.database_url.removeprefix("sqlite:///")
        for suffix in ("", "-wal", "-shm"):
            try:
                import os

                os.remove(db_path + suffix)
            except FileNotFoundError:
                pass
        shutil.rmtree(s.data_dir / "uploads", ignore_errors=True)
        shutil.rmtree(s.chroma_dir, ignore_errors=True)
        print("Deleted local database, uploads and vector index")
    if args.command in ("migrate", "init", "reset"):
        migrate()
        print("Migrations applied")
    if args.command in ("seed", "init", "reset"):
        from app.seed import run_seed

        print("Seeded:", run_seed(with_workflows=not args.no_workflows))


if __name__ == "__main__":
    main()
