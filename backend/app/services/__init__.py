"""Business logic services.

Routes stay thin: they validate input, call into a service, and serialise the
result. Anything that touches more than one collection, sends an email, or makes
an attendance decision lives here so the same rule cannot be implemented twice
with two different behaviours.
"""
