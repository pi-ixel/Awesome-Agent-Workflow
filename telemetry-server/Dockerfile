FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY contracts /tmp/contracts
COPY telemetry-server/pyproject.toml telemetry-server/README.md ./
COPY telemetry-server/src ./src
RUN pip install --no-cache-dir /tmp/contracts .
COPY telemetry-server/alembic.ini ./
COPY telemetry-server/migrations ./migrations
COPY telemetry-server/config ./config

RUN useradd --create-home --uid 10001 appuser \
    && install -d -o appuser -g appuser -m 0750 /var/log/aaw-telemetry
USER appuser

EXPOSE 8000
CMD ["uvicorn", "aaw_telemetry.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
