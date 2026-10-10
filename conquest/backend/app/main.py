"""ASGI entry point: ``hypercorn app.main:app``."""

from app import create_app
from app.ws_compression import install

install()
app = create_app()
