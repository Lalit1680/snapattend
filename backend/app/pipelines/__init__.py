"""Standalone biometric pipelines.

These modules deliberately import **nothing from Flask**. They take bytes in and
return dataclasses out, which is what makes them runnable from
``scripts/test_pipelines.py`` against a folder of images/audio before any HTTP
route exists — the build order in the brief calls for exactly that.

Heavy third-party imports (dlib, torch) happen lazily inside functions so that
importing the web app does not pay a multi-second model-loading cost, and so a
machine without dlib can still boot the non-biometric parts of the API.
"""
