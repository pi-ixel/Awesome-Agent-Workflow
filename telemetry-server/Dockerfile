FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir .
COPY alembic.ini ./
COPY migrations ./migrations
COPY config ./config

RUN useradd --create-home --uid 10001 appuser \
    && install -d -o appuser -g appuser -m 0750 /var/log/aaw-telemetry
USER appuser

EXPOSE 8000
CMD ["uvicorn", "aaw_telemetry.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
