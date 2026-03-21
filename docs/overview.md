# Oversolve project Overview

Exploratory project on how to build a full CAD step-by-step.

`docker-compose` for deployment including `caddy` self signed
`docker-compose` for local mariadb (test) databse

Use test driven development throughout.

## backend (Python)

* `bottle` server as backend with `waitress`
* `JAX` as sketch solver engine
* `cadquery-ocp` for Open Cascade bindings
* `mypy` ignore non typed imports
* `flake8` with line length 250
* `pytest` in `tests` folder
* `toml` file

source code in `oversolved` directory.

Oversolved CAD core part is a AST (Abstract Syntax tree) in toml/json format which handles all geometry rebuilds on the backend. The format is described in `ast.md`.

### Backend Architecture

```
oversolved/
├── __init__.py
├── app.py              # Flask app, routes, migrations
├── db.py               # Database abstraction
├── icons.py            # (existing)
├── icon_cairo.py       # (existing)
├── run_server.py       # CLI entry point
└── solver.py           # (existing)

tests/
├── test_api.py         # 17 API endpoint tests
├── test_database.py    # 15 database layer tests
├── test_solver.py      # (existing solver tests)
└── test_serpentine_belt_fixed.py # (existing)

docs/
├── api.md              # API documentation
├── setup.md            # Setup guide
└── overview.md         # This file
```

## frontend (React)

* React Frontend
* Typescript
* Vite
* Material icons (no CDN, local font file)
* dark mode

## CI

Gitea/Github style CI. ubuntu-latest runners.

Test on python 3.12, 3.13, 3.14

don't test docker compose in ci as it does not work with the local runners - start mariadb as plain apt install

## code style

* no em- or en-dashes.
* no emojys