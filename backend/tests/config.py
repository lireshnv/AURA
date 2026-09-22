"""Where the running AURA server is.

Defaults to the usual development address. Set AURA_TEST_ORIGIN when port 8000
is occupied by something else, e.g.

    $env:AURA_TEST_ORIGIN = "http://localhost:8010"

so the suites can run without disturbing whatever else is bound to 8000.
"""
import os

ORIGIN = os.getenv("AURA_TEST_ORIGIN", "http://localhost:8000").rstrip("/")
