FROM node:22-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=frontend-builder /app/frontend/dist frontend/dist
COPY pyproject.toml setup.cfg ./
COPY oversolved/ oversolved/
RUN pip install --no-cache-dir .
EXPOSE 5000
ENV SOLVER_DAEMON_HOST=solver
ENV SOLVER_DAEMON_PORT=9100
ENV OVERSOLVED_DB_PATH=/data/oversolved.db
ENV OVERSOLVED_UPLOAD_DIR=/data/uploads
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5000/')" || exit 1
ENTRYPOINT ["gunicorn", "-k", "gevent", "--bind", "0.0.0.0:5000", "--workers", "1", "oversolved.app:create_app()"]
