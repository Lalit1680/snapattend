"""Development entry point:  ``python run.py``.

For production use a real WSGI server against ``wsgi:app`` instead::

    gunicorn -w 4 -b 0.0.0.0:5000 wsgi:app     # Linux/macOS
    waitress-serve --port=5000 wsgi:app        # Windows

Flask's built-in server is single-threaded by default, which matters here: a
class-photo upload occupies the worker for a few seconds of dlib work, and every
dashboard poll behind it would block. ``threaded=True`` is enough for local use.
"""
from __future__ import annotations

import os

from app import create_app

app = create_app()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(
        host=os.getenv("HOST", "127.0.0.1"),
        port=port,
        debug=app.config.get("DEBUG", False),
        threaded=True,
    )
