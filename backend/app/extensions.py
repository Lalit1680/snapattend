"""Flask extension singletons.

Kept in their own module so blueprints can import ``limiter``/``mail`` without
importing the app factory (which would create a circular import).
"""
from __future__ import annotations

from flask_cors import CORS
from flask_jwt_extended import JWTManager
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_mail import Mail

jwt = JWTManager()
mail = Mail()
cors = CORS()

# Rate limiting is applied per-endpoint via decorators rather than a blanket
# default, so normal dashboard polling is never throttled while the sensitive
# endpoints (login, attendance marking, invite sending) are.
limiter = Limiter(key_func=get_remote_address, default_limits=[])
