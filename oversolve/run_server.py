#!/usr/bin/env python
"""Run the Oversolve API server."""

import argparse
from waitress import serve
from oversolve.app import create_app


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Run the Oversolve API server')
    parser.add_argument(
        '--host',
        default='127.0.0.1',
        help='Host to bind to (default: 127.0.0.1)'
    )
    parser.add_argument(
        '--port',
        type=int,
        default=5000,
        help='Port to bind to (default: 5000)'
    )
    parser.add_argument(
        '--db-type',
        choices=['sqlite', 'mariadb'],
        default='sqlite',
        help='Database type (default: sqlite)'
    )
    parser.add_argument(
        '--db-path',
        default='oversolve.db',
        help='SQLite database path (default: oversolve.db)'
    )
    parser.add_argument(
        '--db-host',
        help='MariaDB host'
    )
    parser.add_argument(
        '--db-user',
        help='MariaDB username'
    )
    parser.add_argument(
        '--db-password',
        help='MariaDB password'
    )
    parser.add_argument(
        '--db-name',
        help='MariaDB database name'
    )
    parser.add_argument(
        '--debug',
        action='store_true',
        help='Run in debug mode (use Flask development server)'
    )

    args = parser.parse_args()

    # Build config
    config = {
        'DB_TYPE': args.db_type,
    }

    if args.db_type == 'sqlite':
        config['DB_PATH'] = args.db_path
    elif args.db_type == 'mariadb':
        if not all([args.db_host, args.db_user, args.db_password, args.db_name]):
            parser.error('--db-host, --db-user, --db-password, --db-name required for MariaDB')
        config.update({
            'DB_HOST': args.db_host,
            'DB_USER': args.db_user,
            'DB_PASSWORD': args.db_password,
            'DB_NAME': args.db_name,
        })

    app = create_app(config)

    if args.debug:
        print(f'Running in debug mode on {args.host}:{args.port}')
        app.run(host=args.host, port=args.port, debug=True)
    else:
        print(f'Starting Oversolve API server on {args.host}:{args.port}')
        print(f'Database: {args.db_type}')
        serve(app, host=args.host, port=args.port)


if __name__ == '__main__':
    main()
