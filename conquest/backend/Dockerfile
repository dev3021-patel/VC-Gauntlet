FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /srv

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY migrations ./migrations

RUN useradd --system --uid 10001 --no-create-home appuser
USER appuser

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

EXPOSE 8000
CMD ["sh", "-c", "exec hypercorn app.main:app --bind 0.0.0.0:${PORT} --access-logfile - --error-logfile -"]
