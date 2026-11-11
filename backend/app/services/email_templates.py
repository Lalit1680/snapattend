"""HTML email templates.

Hand-written inline-CSS templates rather than Jinja files: email clients ignore
external stylesheets and most ignore ``<style>`` blocks, so inline styles on a
table layout is the only thing that renders consistently. Five templates does not
justify a templating directory.

Every interpolated value is passed through :func:`html.escape` — an institution
named ``Smith & Sons <School>`` must not break the markup, and user-controlled
strings should never be trusted into HTML even in an email.
"""
from __future__ import annotations

from html import escape

from ..config import Config

BRAND = "SnapAttend"
_ACCENT = "#4f46e5"
_TEXT = "#1f2937"
_MUTED = "#6b7280"
_BORDER = "#e5e7eb"


def _shell(*, heading: str, body_html: str, preheader: str = "") -> str:
    """Wrap content in the shared email chrome."""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">{escape(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;border:1px solid {_BORDER};overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 0 32px;">
              <div style="font-size:18px;font-weight:700;color:{_ACCENT};letter-spacing:-0.02em;">{BRAND}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 32px 32px;">
              <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;color:{_TEXT};font-weight:650;">{escape(heading)}</h1>
              {body_html}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background-color:#f9fafb;border-top:1px solid {_BORDER};">
              <p style="margin:0;font-size:12px;line-height:1.6;color:{_MUTED};">
                {BRAND} stores only mathematical embeddings of face and voice samples &mdash;
                never the original photos or recordings.
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:16px 0 0 0;font-size:12px;color:{_MUTED};">
          You received this because your institution uses {BRAND}.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>"""


def _paragraph(text: str) -> str:
    return (
        f'<p style="margin:0 0 16px 0;font-size:15px;line-height:1.65;color:{_TEXT};">{text}</p>'
    )


def _button(url: str, label: str) -> str:
    safe_url = escape(url, quote=True)
    return f"""<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px 0;">
  <tr>
    <td style="border-radius:8px;background-color:{_ACCENT};">
      <a href="{safe_url}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">{escape(label)}</a>
    </td>
  </tr>
</table>
<p style="margin:0 0 16px 0;font-size:13px;line-height:1.6;color:{_MUTED};word-break:break-all;">
  Or paste this link into your browser:<br><a href="{safe_url}" style="color:{_ACCENT};">{safe_url}</a>
</p>"""


def _expiry_note(text: str) -> str:
    return (
        f'<p style="margin:0;padding:12px 16px;background-color:#fffbeb;border-left:3px solid #f59e0b;'
        f'font-size:13px;line-height:1.6;color:#92400e;border-radius:4px;">{text}</p>'
    )


# --------------------------------------------------------------------------- #
# Templates
# --------------------------------------------------------------------------- #
def teacher_invite(*, name: str, institution: str, invite_url: str, inviter_name: str | None) -> tuple[str, str]:
    """Returns ``(subject, html)``."""
    invited_by = f" by {escape(inviter_name)}" if inviter_name else ""
    hours = Config.INVITE_TOKEN_MAX_AGE_SECONDS // 3600
    body = (
        _paragraph(f"Hi {escape(name)},")
        + _paragraph(
            f"You have been invited{invited_by} to join <strong>{escape(institution)}</strong> "
            f"on {BRAND} as a teacher."
        )
        + _paragraph("Set your password to activate your account and start creating class sessions.")
        + _button(invite_url, "Accept invitation")
        + _expiry_note(f"This invitation expires in {hours} hours.")
    )
    return (
        f"You're invited to join {institution} on {BRAND}",
        _shell(
            heading=f"Join {institution} on {BRAND}",
            body_html=body,
            preheader=f"Set your teacher password for {institution}.",
        ),
    )


def student_invite(*, name: str, institution: str, invite_url: str) -> tuple[str, str]:
    hours = Config.INVITE_TOKEN_MAX_AGE_SECONDS // 3600
    steps = f"""<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">
  <tr><td style="padding:0 0 10px 0;font-size:15px;color:{_TEXT};">1. Choose a password</td></tr>
  <tr><td style="padding:0 0 10px 0;font-size:15px;color:{_TEXT};">2. Capture a few face samples with your camera</td></tr>
  <tr><td style="padding:0;font-size:15px;color:{_TEXT};">3. Record the voice passphrase once</td></tr>
</table>"""
    body = (
        _paragraph(f"Hi {escape(name)},")
        + _paragraph(
            f"<strong>{escape(institution)}</strong> uses {BRAND} to record class attendance. "
            f"Enrollment takes about two minutes:"
        )
        + steps
        + _button(invite_url, "Start enrollment")
        + _expiry_note(
            f"This link is personal to you and expires in {hours} hours. "
            f"Do not forward it &mdash; anyone with the link could enroll as you."
        )
    )
    return (
        f"Enroll for attendance at {institution}",
        _shell(
            heading="Set up your attendance profile",
            body_html=body,
            preheader=f"Two minutes to enroll for {institution}.",
        ),
    )


def password_reset(*, name: str, reset_url: str) -> tuple[str, str]:
    minutes = Config.RESET_TOKEN_MAX_AGE_SECONDS // 60
    body = (
        _paragraph(f"Hi {escape(name)},")
        + _paragraph(f"Use the button below to choose a new {BRAND} password.")
        + _button(reset_url, "Reset password")
        + _expiry_note(
            f"This link expires in {minutes} minutes and can be used once. "
            f"If you did not request a reset you can safely ignore this email &mdash; "
            f"your password has not changed."
        )
    )
    return (
        f"Reset your {BRAND} password",
        _shell(heading="Reset your password", body_html=body, preheader="Link expires shortly."),
    )


def low_attendance_alert(
    *,
    name: str,
    institution: str,
    subject_name: str,
    percentage: float,
    threshold: float,
    present: int,
    total: int,
) -> tuple[str, str]:
    portal_url = f"{Config.FRONTEND_URL}/student"
    stat_block = f"""<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;border:1px solid {_BORDER};border-radius:8px;">
  <tr>
    <td style="padding:16px 20px;border-bottom:1px solid {_BORDER};">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:{_MUTED};">Subject</div>
      <div style="font-size:16px;font-weight:600;color:{_TEXT};margin-top:2px;">{escape(subject_name)}</div>
    </td>
  </tr>
  <tr>
    <td style="padding:16px 20px;">
      <div style="font-size:32px;font-weight:700;color:#dc2626;line-height:1;">{percentage:.1f}%</div>
      <div style="font-size:13px;color:{_MUTED};margin-top:6px;">
        {present} of {total} sessions attended &middot; required minimum {threshold:.0f}%
      </div>
    </td>
  </tr>
</table>"""
    body = (
        _paragraph(f"Hi {escape(name)},")
        + _paragraph(
            f"Your attendance at <strong>{escape(institution)}</strong> has fallen below the "
            f"required minimum for one of your subjects."
        )
        + stat_block
        + _paragraph("Speak to your teacher if you believe a session was recorded incorrectly.")
        + _button(portal_url, "View my attendance")
    )
    return (
        f"Attendance alert: {subject_name} is at {percentage:.0f}%",
        _shell(
            heading="Your attendance needs attention",
            body_html=body,
            preheader=f"{subject_name}: {percentage:.0f}% (minimum {threshold:.0f}%).",
        ),
    )


def admin_welcome(*, name: str, institution: str, slug: str) -> tuple[str, str]:
    dashboard_url = f"{Config.FRONTEND_URL}/admin"
    body = (
        _paragraph(f"Hi {escape(name)},")
        + _paragraph(
            f"<strong>{escape(institution)}</strong> is set up on {BRAND} and you are its "
            f"administrator."
        )
        + _paragraph(
            f'Your institution code is <code style="background:#f3f4f6;padding:2px 6px;'
            f'border-radius:4px;font-size:14px;">{escape(slug)}</code>.'
        )
        + _paragraph("Next: invite your teachers, create subjects, then import your students.")
        + _button(dashboard_url, "Open dashboard")
    )
    return (
        f"{institution} is ready on {BRAND}",
        _shell(
            heading=f"Welcome to {BRAND}",
            body_html=body,
            preheader="Invite teachers and import students to get started.",
        ),
    )
