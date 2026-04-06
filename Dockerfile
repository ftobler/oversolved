FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
RUN pip install --no-cache-dir .

COPY oversolved/ ./oversolved/
COPY frontend/dist/ ./frontend/dist/

EXPOSE 5000

CMD ["python", "-m", "oversolved.run_server"]