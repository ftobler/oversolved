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

source code in `oversolve` directory.

Oversolve CAD core part is a AST (Abstract Syntax tree) in toml/json format which handles all geometry rebuilds on the backend. The format is described in `ast.md`.

## frontend (React)

* React Frontend
* Typescript
* Vite
* Material icons (no CDN, local font file)

## CI

Gitea/Github style CI. ubuntu-latest runners.

Test on python 3.12, 3.13, 3.14

don't test docker compose in ci as it does not work with the local runners - start mariadb as plain apt install

## code style

* no em- or en-dashes.
* no emojys