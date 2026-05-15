#!/usr/bin/env python
"""Run the Oversolved API server."""

import argparse
from waitress import serve
from oversolved.app import create_app


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Run the Oversolved API server')
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
        choices=['sqlite'],
        default='sqlite',
        help='Database type (default: sqlite)'
    )
    parser.add_argument(
        '--db-path',
        default='oversolved.db',
        help='SQLite database path (default: oversolved.db)'
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

    app = create_app(config)

    if args.debug:
        print(f'Running in debug mode on {args.host}:{args.port}')
        app.run(host=args.host, port=args.port, debug=True)
    else:
        print(f'Starting Oversolved API server on {args.host}:{args.port}')
        print(f'Database: {args.db_type}')
        serve(app, host=args.host, port=args.port)


if __name__ == '__main__':
    main()
