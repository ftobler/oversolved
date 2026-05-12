"""Unified CLI for Oversolved with subcommands."""

import argparse
import signal
import sys
import time
from datetime import datetime, timezone


def _positive_int(value: str) -> int:
    """Validate positive integer argument."""
    ival = int(value)
    if ival <= 0:
        raise argparse.ArgumentTypeError(f"must be positive, got {value}")
    return ival


def _validate_db_args(args: argparse.Namespace) -> dict:
    """Build DB config dict and validate database-specific args."""
    import os
    config = {"DB_TYPE": args.db_type, "DEBUG": getattr(args, "debug", False)}

    if args.db_type == "postgres":
        dsn = getattr(args, "db_dsn", None) or os.environ.get("OVERSOLVED_DB_DSN")
        if not dsn:
            print("error: --db-dsn or OVERSOLVED_DB_DSN required for postgres")
            sys.exit(1)
        config["DB_DSN"] = dsn
    elif args.db_type == "sqlite":
        config["DB_PATH"] = args.db_path
    elif args.db_type == "mariadb":
        missing = [opt for opt in ("db_host", "db_user", "db_password", "db_name")
                   if not getattr(args, opt, None)]
        if missing:
            print(f"error: --db-host, --db-user, --db-password, --db-name required for MariaDB "
                  f"(missing: {', '.join('--' + m.replace('_', '-') for m in missing)})")
            sys.exit(1)
        config.update({
            "DB_HOST": args.db_host,
            "DB_USER": args.db_user,
            "DB_PASSWORD": args.db_password,
            "DB_NAME": args.db_name,
        })

    return config


def run_server(args: argparse.Namespace) -> None:
    """Start the Oversolved API server."""
    from waitress import serve
    from oversolved.app import create_app

    config = _validate_db_args(args)
    app = create_app(config)

    if args.debug:
        print(f"Running in debug mode on {args.host}:{args.port}")
        app.run(host=args.host, port=args.port, debug=True)
    else:
        print(f"Starting Oversolved API server on {args.host}:{args.port}")
        print(f"Database: {args.db_type}")
        serve(app, host=args.host, port=args.port)


def _get_db_from_config(args: argparse.Namespace, init_db: bool = True):
    """Build a Database instance from CLI args.

    Args:
        args: Parsed CLI arguments.
        init_db: If True (default), runs pending migrations on connect.
    """
    from oversolved.db import Database, DatabaseConnection, SQLiteConnection, MariaDBConnection, PostgreSQLConnection

    config = _validate_db_args(args)

    conn: DatabaseConnection
    if config["DB_TYPE"] == "postgres":
        conn = PostgreSQLConnection(config["DB_DSN"])
    elif config["DB_TYPE"] == "sqlite":
        conn = SQLiteConnection(config["DB_PATH"])
    else:
        conn = MariaDBConnection(
            host=config["DB_HOST"],
            user=config["DB_USER"],
            password=config["DB_PASSWORD"],
            database=config["DB_NAME"],
        )
    db = Database(conn)
    from oversolved.app import _register_migrations
    _register_migrations(db)
    if init_db:
        db.init()
    return db


def run_tasks(args: argparse.Namespace) -> None:
    """Run periodic task checks."""
    from oversolved.periodic_tasks import TaskScheduler, EmptyTrashTask

    db = _get_db_from_config(args)

    scheduler = TaskScheduler()
    scheduler.register_task(EmptyTrashTask())

    if args.force_task:
        result = scheduler.force_run_task(args.force_task, db)
        print(f"{result.get('status', 'error')}: {args.force_task}")
        if "error" in result:
            print(f"  error: {result['error']}")
        db.close()
        return

    if args.loop:
        signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))
        print(f"Task runner in loop mode (interval: {args.interval}s)")
        try:
            while True:
                results = scheduler.run_due_tasks(db)
                now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                for r in results:
                    print(f"[{now}] {r['task_key']}: {r['status']}")
                time.sleep(args.interval)
        except (KeyboardInterrupt, SystemExit):
            print("\nShutting down task runner.")
        finally:
            db.close()
    else:
        results = scheduler.run_due_tasks(db)
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        for r in results:
            print(f"[{now}] {r['task_key']}: {r['status']}")
        if not results:
            print("No tasks were due.")
        db.close()

    db.close()


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser with subcommands."""
    parser = argparse.ArgumentParser(description="Oversolved CLI")
    subparsers = parser.add_subparsers(dest="command", help="Subcommand")

    # run_server subcommand
    server_parser = subparsers.add_parser("run_server", help="Start the API server")
    server_parser.add_argument("--host", default="127.0.0.1", help="Host to bind to (default: 127.0.0.1)")
    server_parser.add_argument("--port", type=int, default=5000, help="Port to bind to (default: 5000)")
    server_parser.add_argument("--db-type", choices=["postgres", "sqlite", "mariadb"], default="postgres", help="Database type (default: postgres)")
    server_parser.add_argument("--db-dsn", help="PostgreSQL DSN (default: OVERSOLVED_DB_DSN env var)")
    server_parser.add_argument("--db-path", default="oversolved.db", help="SQLite database path")
    server_parser.add_argument("--db-host", help="MariaDB host")
    server_parser.add_argument("--db-user", help="MariaDB username")
    server_parser.add_argument("--db-password", help="MariaDB password")
    server_parser.add_argument("--db-name", help="MariaDB database name")
    server_parser.add_argument("--debug", action="store_true", help="Run in debug mode (use Flask development server)")

    # db subcommand group
    db_parser = subparsers.add_parser("db", help="Manage database schema")
    db_parser.add_argument("--db-type", choices=["postgres", "sqlite", "mariadb"], default="postgres", help="Database type (default: postgres)")
    db_parser.add_argument("--db-dsn", help="PostgreSQL DSN (default: OVERSOLVED_DB_DSN env var)")
    db_parser.add_argument("--db-path", default="oversolved.db", help="SQLite database path")
    db_parser.add_argument("--db-host", help="MariaDB host")
    db_parser.add_argument("--db-user", help="MariaDB username")
    db_parser.add_argument("--db-password", help="MariaDB password")
    db_parser.add_argument("--db-name", help="MariaDB database name")
    db_subparsers = db_parser.add_subparsers(dest="db_command", help="DB subcommand")
    db_subparsers.add_parser("status", help="Show current schema version and pending migrations")
    db_subparsers.add_parser("upgrade", help="Apply all pending migrations")
    db_subparsers.add_parser("check", help="Exit 1 if pending migrations exist (for CI gates)")

    # run_tasks subcommand
    tasks_parser = subparsers.add_parser("run_tasks", help="Run periodic task checks")
    tasks_parser.add_argument("--db-type", choices=["postgres", "sqlite", "mariadb"], default="postgres", help="Database type (default: postgres)")
    tasks_parser.add_argument("--db-dsn", help="PostgreSQL DSN (default: OVERSOLVED_DB_DSN env var)")
    tasks_parser.add_argument("--db-path", default="oversolved.db", help="SQLite database path")
    tasks_parser.add_argument("--db-host", help="MariaDB host")
    tasks_parser.add_argument("--db-user", help="MariaDB username")
    tasks_parser.add_argument("--db-password", help="MariaDB password")
    tasks_parser.add_argument("--db-name", help="MariaDB database name")
    tasks_parser.add_argument("--loop", action="store_true", help="Run continuously instead of once")
    tasks_parser.add_argument("--interval", type=_positive_int, default=60, help="Seconds between checks in loop mode (default: 60)")
    tasks_parser.add_argument("--force-task", help="Run a single task by key immediately")

    return parser


def cmd_db(args: argparse.Namespace) -> None:
    """Manage database schema (status, upgrade, check)."""
    db = _get_db_from_config(args, init_db=False)

    if args.db_command == "status":
        current = db.get_current_version()
        pending = db.get_pending_migrations()
        latest = max((v for v, _, _ in db._migrations), default=0)

        print(f"Schema version: {current}")
        print(f"Latest:         {latest}")
        print()
        if not db._migrations:
            print("No migrations registered.")
        else:
            print(f"{'Version':<8} {'Name':<35} {'Status'}")
            print("-" * 60)
            for version, name, _ in db._migrations:
                status = "applied" if version <= current else "pending"
                print(f"{version:<8} {name:<35} {status}")
        db.close()
        return

    if args.db_command == "upgrade":
        pending = db.get_pending_migrations()
        if not pending:
            print("Database is up to date.")
        else:
            for version, name, _ in pending:
                print(f"Applying migration {version}: {name}...")
                db.get_current_version()  # refresh before each in case of partial state
                still_pending = db.get_pending_migrations()
                match = [(v, n, f) for v, n, f in still_pending if v == version]
                if match:
                    v, n, func = match[0]
                    db.apply_migration(v, n, func)
                    print("  done.")
                else:
                    print("  already applied, skipping.")
        db.close()
        return

    if args.db_command == "check":
        try:
            is_ok, current, latest = db.check_version_sync()
        except TimeoutError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            db.close()
            sys.exit(1)
        db.close()
        if not is_ok:
            print(
                f"Pending migrations (current: {current}, latest: {latest})",
                file=sys.stderr,
            )
            sys.exit(1)
        else:
            print("Database is up to date.")
        return


def main() -> None:
    """Main entry point."""
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "run_server":
        run_server(args)
    elif args.command == "run_tasks":
        run_tasks(args)
    elif args.command == "db":
        cmd_db(args)
    else:
        # Default to run_server for backward compatibility
        sys.argv = [sys.argv[0], "run_server"] + sys.argv[1:]
        main()


if __name__ == "__main__":
    main()
