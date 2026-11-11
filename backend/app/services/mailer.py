"""Email transport.

Why a background worker
-----------------------
An SMTP handshake costs 1-3 seconds. A bulk CSV import of 200 students would
therefore block the request for several minutes if it sent inline. Rather than
introduce Celery/Redis for one job (the brief explicitly says not to), outbound
mail goes onto an in-process queue drained by a single daemon thread. That keeps
requests fast, preserves ordering, and adds no infrastructure.

The trade-off is honest and documented: if the process dies with mail still
queued, that mail is lost. For invites and alerts that is acceptable — both are
re-sendable from the UI, and nothing about the system's correctness depends on
delivery. Anything that *must* not be lost would need a real queue.

Dev ergonomics
--------------
With no SMTP credentials configured, ``Config.MAIL_SUPPRESS_SEND`` is true and
messages are logged in full — including the invite/reset URL — so local
onboarding flows can be exercised end to end without a mail provider.
"""
from __future__ import annotations

import atexit
import logging
import queue
import threading
from dataclasses import dataclass
from typing import Optional, Sequence

from flask import Flask, current_app

from ..config import Config
from ..extensions import mail

log = logging.getLogger(__name__)

# Bounded so a runaway loop cannot exhaust memory; sends block briefly instead.
_MAX_QUEUE_SIZE = 2000
_SHUTDOWN = object()

_queue: "queue.Queue" = queue.Queue(maxsize=_MAX_QUEUE_SIZE)
_worker: Optional[threading.Thread] = None
_worker_lock = threading.Lock()
_app: Optional[Flask] = None


@dataclass
class Message:
    to: list[str]
    subject: str
    html: str
    text: str


# --------------------------------------------------------------------------- #
# Worker lifecycle
# --------------------------------------------------------------------------- #
def init_app(app: Flask) -> None:
    """Bind the mailer to an app instance and start the worker thread."""
    global _app
    _app = app
    _ensure_worker()
    if Config.MAIL_SUPPRESS_SEND:
        app.logger.warning(
            "MAIL_SUPPRESS_SEND is active (no MAIL_USERNAME configured): emails will be "
            "logged to the console instead of sent."
        )


def _ensure_worker() -> None:
    global _worker
    if _worker is not None and _worker.is_alive():
        return
    with _worker_lock:
        if _worker is not None and _worker.is_alive():
            return
        _worker = threading.Thread(target=_drain, name="snapattend-mailer", daemon=True)
        _worker.start()


def _drain() -> None:
    while True:
        item = _queue.get()
        try:
            if item is _SHUTDOWN:
                return
            _deliver(item)
        except Exception as exc:  # pragma: no cover - never kill the worker
            log.error("Mail worker error: %s", exc, exc_info=True)
        finally:
            _queue.task_done()


def _deliver(message: Message) -> None:
    """Actually hand a message to Flask-Mail, inside an app context."""
    if _app is None:
        log.error("Mailer used before init_app(); dropping message %r", message.subject)
        return

    with _app.app_context():
        if Config.MAIL_SUPPRESS_SEND:
            # Full body in the log so dev can copy the invite link out.
            log.info(
                "\n%s\n[EMAIL NOT SENT - SMTP not configured]\nTo: %s\nSubject: %s\n\n%s\n%s",
                "=" * 78,
                ", ".join(message.to),
                message.subject,
                message.text,
                "=" * 78,
            )
            return
        try:
            from flask_mail import Message as MailMessage

            msg = MailMessage(
                subject=message.subject,
                recipients=message.to,
                body=message.text,
                html=message.html,
                sender=Config.MAIL_DEFAULT_SENDER,
            )
            mail.send(msg)
            log.info("Sent %r to %s", message.subject, ", ".join(message.to))
        except Exception as exc:
            # Log the recipient and subject but not the body, which may contain a
            # single-use invite token.
            log.error("Failed to send %r to %s: %s", message.subject, ", ".join(message.to), exc)


@atexit.register
def _shutdown() -> None:  # pragma: no cover - interpreter teardown
    try:
        _queue.put_nowait(_SHUTDOWN)
    except queue.Full:
        pass


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def send(
    to: str | Sequence[str],
    subject: str,
    html: str,
    text: Optional[str] = None,
    *,
    blocking: bool = False,
) -> bool:
    """Queue an email. Returns False only if the queue is saturated.

    ``blocking=True`` sends inline — used by CLI scripts, which exit before a
    background thread would get a chance to run.
    """
    recipients = [to] if isinstance(to, str) else [t for t in to if t]
    if not recipients:
        return False

    message = Message(
        to=list(recipients),
        subject=subject,
        html=html,
        text=text or _html_to_text(html),
    )

    if blocking:
        _deliver(message)
        return True

    _ensure_worker()
    try:
        _queue.put_nowait(message)
        return True
    except queue.Full:
        log.error("Mail queue is full; dropped %r to %s", subject, ", ".join(recipients))
        return False


def flush(timeout: float = 30.0) -> None:
    """Block until the queue drains. For scripts and tests, not request paths."""
    deadline = threading.Event()
    waiter = threading.Thread(target=lambda: (_queue.join(), deadline.set()), daemon=True)
    waiter.start()
    deadline.wait(timeout)


def pending_count() -> int:
    return _queue.qsize()


def _html_to_text(html: str) -> str:
    """Crude HTML -> text fallback for the plain-text alternative part.

    Good enough for our own templates (which are simple and known); we are not
    trying to be a general-purpose HTML renderer.
    """
    import re

    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", "", html)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|h[1-6]|tr|li)>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", "", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def is_configured() -> bool:
    """True when real SMTP delivery is available (surfaced on the admin page)."""
    return not Config.MAIL_SUPPRESS_SEND and bool(Config.MAIL_USERNAME)


def describe() -> dict:
    return {
        "configured": is_configured(),
        "server": Config.MAIL_SERVER,
        "port": Config.MAIL_PORT,
        "sender": Config.MAIL_DEFAULT_SENDER,
        "suppressed": Config.MAIL_SUPPRESS_SEND,
        "queued": pending_count(),
    }
