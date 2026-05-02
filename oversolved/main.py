"""Backward-compat entry point. Prefer `oversolved.cli:main` directly."""

from oversolved.cli import main as cli_main


def main():
    cli_main()
