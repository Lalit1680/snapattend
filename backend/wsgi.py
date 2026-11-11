"""WSGI entry point for gunicorn / waitress.

Kept separate from ``run.py`` so the production server never imports the
``if __name__ == "__main__"`` development block.
"""
from __future__ import annotations

from app import create_app

app = create_app()
