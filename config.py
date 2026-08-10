from pathlib import Path
from typing import Final
import os

from dotenv import load_dotenv

BASE_DIR: Final[Path] = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

ADMIN_USERNAME: Final[str] = os.getenv("ADMIN_USER", "").strip()
ADMIN_PASSWORD: Final[str] = os.getenv("ADMIN_PASS", "").strip()

# Validate admin credentials exist (will crash early if missing)
if not ADMIN_USERNAME or not ADMIN_PASSWORD:
    raise RuntimeError(
        "ADMIN_USER and ADMIN_PASS must be set in .env file. "
        "Create .env from .env.example and fill in the values."
    )

# Flask signs session cookies with this. If it isn't set explicitly, a
# random value would otherwise be generated on every process start, which
# invalidates every logged-in user's session cookie on every deploy AND on
# every restart/scale event/dyno cycle. Fail fast instead, the same way we
# do for admin credentials above, so this can never silently ship broken.
SECRET_KEY: Final[str] = os.getenv("SECRET_KEY", "").strip()
if not SECRET_KEY:
    raise RuntimeError(
        "SECRET_KEY must be set in .env (or your host's environment variables) "
        "and must stay the same across deploys/restarts. Generate one once with: "
        "python3 -c \"import secrets; print(secrets.token_hex(32))\" "
        "and store it as a permanent env var - never regenerate it on each deploy, "
        "or every user will be logged out each time you deploy."
    )

DATABASE_PATH: Final[Path] = Path(os.getenv("DATABASE_PATH") or (BASE_DIR / "database.db"))

PAYMENT_PROVIDER: Final[str] = "paystack"
PAYMENT_CURRENCY: Final[str] = "GHS"
MIN_WITHDRAWAL_AMOUNT: Final[float] = 50.0
MIN_RETAINED_BALANCE: Final[float] = 50.0

# --- Legacy direct-Paystack settings ---
# EarnMaster no longer talks to Paystack directly (see the "Payments (routed
# through our own Payment Hub)" block below) and does not hold its own
# Paystack keys. These are kept only because a handful of dead/unused legacy
# routes in
# server.py (the old wallet "/api/paystack/*" deposit flow, not wired up to
# any frontend) still reference them; they simply no-op/error out cleanly
# with these left blank. Do not fill these in for a new deployment.
PAYSTACK_SECRET_KEY: Final[str] = (
    os.getenv("PAYSTACK_SECRET_KEY")
    or os.getenv("paystack_secret_test_key")
    or os.getenv("PAYSTACK_SECRET_TEST_KEY")
    or ""
).strip()

PAYSTACK_PUBLIC_KEY: Final[str] = (
    os.getenv("PAYSTACK_PUBLIC_KEY")
    or os.getenv("paystack_public_test_key")
    or os.getenv("PAYSTACK_PUBLIC_TEST_KEY")
    or ""
).strip()

PAYSTACK_CALLBACK_URL: Final[str] = os.getenv("PAYSTACK_CALLBACK_URL", "").strip()
PAYSTACK_ALLOWED_CHANNELS: Final[list[str]] = []
PAYSTACK_SUBUNIT_MULTIPLIER: Final[int] = 100

# --- Payments (routed through our own Payment Hub) ---
# EarnMaster has no Paystack keys of its own and never calls Paystack
# directly. Level-unlock and final-stage payments are started and verified
# through the Payment Hub instead (see the payment-hub repo) — the hub is
# the only service that holds the Paystack secret key, and it fronts
# Paystack for all of our sites, not just this one. Get the API key/secret
# pair below by registering this site as a merchant on the hub (its admin
# dashboard, or `node src/scripts/createMerchant.js`) — they're shown once
# at creation time. Payments are disabled until these are set.

# The hub's public base URL, e.g. https://your-hub.up.railway.app
PAYMENT_HUB_URL: Final[str] = os.getenv("PAYMENT_HUB_URL", "").strip().rstrip("/")

# This site's merchant API key on the hub. Sent as the x-api-key header on
# every call to the hub's /api/v1/transaction/* endpoints.
PAYMENT_HUB_API_KEY: Final[str] = os.getenv("PAYMENT_HUB_API_KEY", "").strip()

# This site's merchant API secret on the hub. Used to HMAC-SHA512-sign every
# outgoing request to the hub (x-signature header) and to verify the
# x-hub-signature header on inbound webhooks the hub sends back to
# POST /api/payments/partner-webhook (see routes/payment_routes.py). Never
# sent over the wire — kept secret on both sides, mirroring how the hub
# itself never exposes the underlying Paystack secret key to us.
PAYMENT_HUB_API_SECRET: Final[str] = os.getenv("PAYMENT_HUB_API_SECRET", "").strip()

# Where the hub should send the customer's browser back to after paying
# (appended with ?reference=...&status=...). Falls back to
# {request.host_url}/?paystack_return=1 at call time if left blank — see
# services/paystack_service.py.
PAYMENT_HUB_REDIRECT_URL: Final[str] = os.getenv("PAYMENT_HUB_REDIRECT_URL", "").strip()

AVATAR_PATH_PREFIX: Final[str] = "/static/images/avatars/"
AVATAR_FILENAMES: Final[list[str]] = [
    "avatar-female.svg",
    "avatar-male.svg",
]

TASK_CATEGORIES = [
    {
        "category_key": "headline_classifier",
        "display_name": "Headline Classifier",
        "source_type": "semi_dynamic_api",
    },
    {
        "category_key": "flag_country_match",
        "display_name": "Flag / Country Match",
        "source_type": "semi_dynamic_api",
    },
    {
        "category_key": "caption_match",
        "display_name": "Caption Match",
        "source_type": "native",
    },
    {
        "category_key": "duplicate_detection",
        "display_name": "Duplicate Detection",
        "source_type": "native",
    },
    {
        "category_key": "book_cover_match",
        "display_name": "Book Cover Match",
        "source_type": "semi_dynamic_api",
    },
    {
        "category_key": "recipe_ingredient_match",
        "display_name": "Recipe Ingredient Match",
        "source_type": "semi_dynamic_api",
    },
]

LEVEL_CATALOG = [
    {
        "level_number": 1,
        "unlock_fee": 50.0,
        "final_stage_fee": 0.0,
        "completion_reward": 115.0,
        "base_task_count": 4,
        "total_task_count": 4,
        "final_stage_enabled": 0,
    },
    {
        "level_number": 2,
        "unlock_fee": 70.0,
        "final_stage_fee": 0.0,
        "completion_reward": 161.0,
        "base_task_count": 4,
        "total_task_count": 4,
        "final_stage_enabled": 0,
    },
    {
        "level_number": 3,
        "unlock_fee": 90.0,
        "final_stage_fee": 0.0,
        "completion_reward": 207.0,
        "base_task_count": 4,
        "total_task_count": 4,
        "final_stage_enabled": 0,
    },
    {
        "level_number": 4,
        "unlock_fee": 120.0,
        "final_stage_fee": 30.0,
        "completion_reward": 276.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
    {
        "level_number": 5,
        "unlock_fee": 160.0,
        "final_stage_fee": 35.0,
        "completion_reward": 368.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
    {
        "level_number": 6,
        "unlock_fee": 200.0,
        "final_stage_fee": 40.0,
        "completion_reward": 460.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
    {
        "level_number": 7,
        "unlock_fee": 250.0,
        "final_stage_fee": 45.0,
        "completion_reward": 575.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
    {
        "level_number": 8,
        "unlock_fee": 300.0,
        "final_stage_fee": 50.0,
        "completion_reward": 690.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
    {
        "level_number": 9,
        "unlock_fee": 400.0,
        "final_stage_fee": 60.0,
        "completion_reward": 1495.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
    {
        "level_number": 10,
        "unlock_fee": 500.0,
        "final_stage_fee": 70.0,
        "completion_reward": 1150.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
    {
        "level_number": 11,
        "unlock_fee": 650.0,
        "final_stage_fee": 80.0,
        "completion_reward": 920.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
    {
        "level_number": 12,
        "unlock_fee": 800.0,
        "final_stage_fee": 90.0,
        "completion_reward": 1840.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
    {
        "level_number": 13,
        "unlock_fee": 1000.0,
        "final_stage_fee": 100.0,
        "completion_reward": 2300.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
    {
        "level_number": 14,
        "unlock_fee": 1200.0,
        "final_stage_fee": 120.0,
        "completion_reward": 2760.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
    {
        "level_number": 15,
        "unlock_fee": 1500.0,
        "final_stage_fee": 150.0,
        "completion_reward": 3450.0,
        "base_task_count": 4,
        "total_task_count": 6,
        "final_stage_enabled": 1,
    },
]

TOTAL_LEVELS: Final[int] = len(LEVEL_CATALOG)
LEVEL_LOOKUP_BY_NUMBER = {level["level_number"]: level for level in LEVEL_CATALOG}
TASK_CATEGORY_LOOKUP = {category["category_key"]: category for category in TASK_CATEGORIES}