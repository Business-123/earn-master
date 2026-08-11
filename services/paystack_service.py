import hashlib
import hmac
import json
import secrets
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from config import (
    PAYMENT_CURRENCY,
    PAYMENT_HUB_API_KEY,
    PAYMENT_HUB_API_SECRET,
    PAYMENT_HUB_REDIRECT_URL,
    PAYMENT_HUB_URL,
    PAYMENT_PROVIDER,
    PAYSTACK_ALLOWED_CHANNELS,
    PAYSTACK_SUBUNIT_MULTIPLIER,
)
from services.db_service import fetch_one, now_iso
from services.level_service import (
    get_level_by_id,
    get_user_level,
    mark_final_stage_unlocked,
    mark_level_unlocked,
)
from services.user_email_service import (
    get_user_contact_email,
    is_valid_contact_email,
    normalize_email,
    save_user_contact_email,
)
from utils.enums import PaymentStatus, PaymentType, UserLevelStatus

# EarnMaster holds no Paystack keys of its own and never calls Paystack
# directly. Our Payment Hub (a separate service — see the payment-hub repo)
# holds the real Paystack keys, starts/verifies transactions on our behalf
# via its /api/v1/transaction/* endpoints, and forwards the result to us
# once it knows it (see routes/payment_routes.py's /api/payments/
# partner-webhook, and the hub's own src/routes/paystackWebhook.js on the
# other side). This module talks to the hub, not Paystack — the function
# names are kept as-is so the rest of this file
# (initialize_level_unlock_payment, verify_and_apply_payment, etc.) didn't
# need to change.


def _ensure_hub_config() -> None:
    if not PAYMENT_HUB_URL:
        raise ValueError("Missing PAYMENT_HUB_URL in environment.")
    if not PAYMENT_HUB_API_KEY:
        raise ValueError("Missing PAYMENT_HUB_API_KEY in environment.")
    if not PAYMENT_HUB_API_SECRET:
        raise ValueError("Missing PAYMENT_HUB_API_SECRET in environment.")


def _hub_signature(raw_body: str) -> str:
    return hmac.new(
        PAYMENT_HUB_API_SECRET.encode("utf-8"),
        raw_body.encode("utf-8"),
        hashlib.sha512,
    ).hexdigest()


def _hub_request(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    _ensure_hub_config()

    url = f"{PAYMENT_HUB_URL}{path}"

    # The hub verifies x-signature as an HMAC-SHA512 of the *exact* raw body
    # it received, so the string used to sign here must be byte-for-byte the
    # same as what's sent as the request body (an empty string for GETs with
    # no body, matching how the hub's own merchantAuth middleware treats
    # req.rawBody).
    raw_body = json.dumps(payload) if payload is not None else ""
    data = raw_body.encode("utf-8") if payload is not None else None

    headers = {
        "x-api-key": PAYMENT_HUB_API_KEY,
        "x-signature": _hub_signature(raw_body),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    print("PAYMENT HUB REQUEST URL:", url)
    print("PAYMENT HUB REQUEST METHOD:", method.upper())
    print("PAYMENT HUB REQUEST PAYLOAD:", payload)

    req = urllib.request.Request(
        url=url,
        data=data,
        headers=headers,
        method=method.upper(),
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = response.read().decode("utf-8")
            print("PAYMENT HUB RESPONSE STATUS:", response.status)
            print("PAYMENT HUB RESPONSE BODY:", body)
            return json.loads(body)

    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        print("PAYMENT HUB HTTP ERROR STATUS:", exc.code)
        print("PAYMENT HUB HTTP ERROR BODY:", body)

        try:
            parsed = json.loads(body)
            return {
                "status": False,
                "message": parsed.get("message", f"HTTP Error {exc.code}"),
                "raw": parsed,
            }
        except Exception:
            return {
                "status": False,
                "message": f"HTTP Error {exc.code}: {exc.reason}",
                "raw": body,
            }

    except Exception as exc:
        print("PAYMENT HUB REQUEST EXCEPTION:", str(exc))
        return {
            "status": False,
            "message": str(exc),
            "raw": None,
        }


def get_payment_config() -> dict[str, Any]:
    _ensure_hub_config()
    return {
        "provider": PAYMENT_PROVIDER,
        "currency": PAYMENT_CURRENCY,
        # No public key: checkout is a redirect to the hosted authorizationUrl
        # the hub hands back, not an inline Paystack popup, so the frontend
        # never needs a Paystack public key.
        "public_key": None,
        "channels": PAYSTACK_ALLOWED_CHANNELS,
        "checkout_mode": "hosted_checkout",
    }


def resolve_payment_emails(
    conn: sqlite3.Connection,
    user_id: str,
    submitted_contact_email: str | None,
) -> str:
    """Returns the user's own email to use for the transaction — this is
    sent straight to the hub/Paystack, no rotating pool of stand-in
    addresses. First payment requires the user to supply and save a valid
    contact email; every payment after that reuses whatever's on file."""
    contact_email = get_user_contact_email(conn, user_id)
    if not contact_email:
        clean_contact_email = normalize_email(submitted_contact_email)
        if not is_valid_contact_email(clean_contact_email):
            raise ValueError("A valid contact email is required before your first payment.")
        contact_email = save_user_contact_email(conn, user_id, clean_contact_email)

    return contact_email


def _make_reference(
    user_id: str,
    level_number: int,
    payment_type: str,
) -> str:
    # This is only ever used as a placeholder value passed into the hub's
    # initialize call (see initialize_level_unlock_payment /
    # initialize_final_stage_payment) — the hub mints and returns its own
    # 6-digit reference, which is what actually gets stored and used from
    # then on.
    kind = "LVL" if payment_type == PaymentType.LEVEL_UNLOCK.value else "FNL"
    random_part = secrets.token_hex(4)
    return f"EM_{kind}_{user_id}_{level_number}_{int(time.time() * 1000)}_{random_part}"


def _amount_to_subunit(amount: float) -> int:
    return int(round(float(amount) * PAYSTACK_SUBUNIT_MULTIPLIER))


def initialize_paystack_transaction(
    *,
    email: str,
    amount: float,
    reference: str,
    callback_url: str | None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Starts the transaction through the hub's POST /api/v1/transaction/initialize
    instead of Paystack's own /transaction/initialize. Returns a
    Paystack-shaped {status, data: {...}} dict so the callers below
    (initialize_level_unlock_payment / initialize_final_stage_payment)
    didn't need to change.

    Note: the hub generates its own 6-digit reference server-side rather than
    accepting one from us (it doesn't take a `reference` field at all), so
    the `reference` this function is called with is only used as the
    redirectUrl-building fallback below — the caller must use
    data["reference"] from the response as the authoritative reference going
    forward, not the one it passed in."""
    clean_email = (email or "").strip().lower()
    if not clean_email:
        raise ValueError("Email is required to initialize payment.")

    clean_redirect = (callback_url or PAYMENT_HUB_REDIRECT_URL or "").strip()
    if not clean_redirect:
        raise ValueError("A redirect URL is required to initialize payment.")

    payload: dict[str, Any] = {
        "email": clean_email,
        "amount": float(amount),
        "currency": PAYMENT_CURRENCY,
        "redirectUrl": clean_redirect,
    }

    if metadata is not None:
        payload["metadata"] = metadata

    resp = _hub_request("POST", "/api/v1/transaction/initialize", payload)

    if not resp.get("status"):
        return {"status": False, "message": resp.get("message", "Payment initialization failed.")}

    data = resp.get("data") or {}

    return {
        "status": True,
        "data": {
            # Use the hub's own branded interstitial (checkoutUrl) rather than
            # authorizationUrl, which points straight at Paystack's hosted
            # checkout and skips the hub's "redirecting to checkout" page
            # entirely. The key is still named authorization_url so the
            # callers below (initialize_level_unlock_payment /
            # initialize_final_stage_payment) and the frontend that reads
            # payment.authorization_url don't need to change.
            "authorization_url": data.get("checkoutUrl"),
            "access_code": None,
            "reference": data.get("reference") or reference,
            "status": "pending",
        },
    }


def verify_paystack_transaction(reference: str) -> dict[str, Any]:
    """Verifies through the hub's GET /api/v1/transaction/verify/:reference
    instead of Paystack's own /transaction/verify. Returns a Paystack-shaped
    {status, data: {status, amount, channel}} dict so verify_and_apply_payment
    below didn't need to change — note the hub reports amount in whole GHS
    (main currency unit, not kobo/pesewas), so it's converted back to subunit
    here to keep that downstream math intact."""
    safe_reference = urllib.parse.quote(reference, safe="")
    resp = _hub_request("GET", f"/api/v1/transaction/verify/{safe_reference}")

    if not resp.get("status"):
        return {"status": False, "message": resp.get("message", "Payment verification failed.")}

    data = resp.get("data") or {}

    # The hub's status vocabulary is PENDING | SUCCESS | FAILED | ABANDONED.
    hub_status = str(data.get("status") or "").strip().lower()

    return {
        "status": True,
        "data": {
            "status": hub_status or "pending",
            "amount": _amount_to_subunit(data.get("amount") or 0),
            "channel": None,
            "reference": data.get("reference") or reference,
        },
    }


def _insert_payment_intent(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    level_id: int,
    payment_type: str,
    amount: float,
    reference: str,
    provider_access_code: str | None,
    provider_response_raw: dict[str, Any],
    status: str,
    provider: str | None = None,
) -> dict[str, Any]:
    timestamp = now_iso()

    conn.execute(
        """
        INSERT INTO payment_intents (
            user_id,
            level_id,
            payment_type,
            amount,
            currency,
            reference,
            provider,
            provider_access_code,
            status,
            provider_response_raw,
            verified_at,
            expires_at,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user_id,
            level_id,
            payment_type,
            float(amount),
            PAYMENT_CURRENCY,
            reference,
            provider or PAYMENT_PROVIDER,
            provider_access_code,
            status,
            json.dumps(provider_response_raw),
            None,
            None,
            timestamp,
            timestamp,
        ),
    )
    conn.commit()

    row = fetch_one(
        conn,
        """
        SELECT *
        FROM payment_intents
        WHERE reference = ?
        """,
        (reference,),
    )
    if not row:
        raise ValueError("Failed to create payment intent.")
    return row


def initialize_level_unlock_payment(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    level_id: int,
    email: str | None = None,
    callback_url: str | None = None,
) -> dict[str, Any]:
    level = get_level_by_id(conn, level_id)
    if not level:
        raise ValueError("Level not found.")

    user_level = get_user_level(conn, user_id, level_id)
    if user_level and user_level["status"] != UserLevelStatus.LOCKED.value:
        raise ValueError("This level is already unlocked or completed.")

    contact_email = resolve_payment_emails(conn, user_id, email)

    # `_make_reference` is only a placeholder passed into
    # initialize_paystack_transaction below (unused by the hub, which mints
    # its own 6-digit reference) — the real reference used everywhere after
    # this point comes from the hub's response.
    placeholder_reference = _make_reference(
        user_id=user_id,
        level_number=int(level["level_number"]),
        payment_type=PaymentType.LEVEL_UNLOCK.value,
    )

    metadata = {
        "user_id": user_id,
        "level_id": level_id,
        "level_number": int(level["level_number"]),
        "payment_type": PaymentType.LEVEL_UNLOCK.value,
    }

    response = initialize_paystack_transaction(
        email=contact_email,
        amount=float(level["unlock_fee"]),
        reference=placeholder_reference,
        callback_url=callback_url,
        metadata=metadata,
    )

    if not response.get("status"):
        raise ValueError(response.get("message", "Payment initialization failed."))

    data = response.get("data") or {}
    reference = data.get("reference") or placeholder_reference

    intent = _insert_payment_intent(
        conn,
        user_id=user_id,
        level_id=level_id,
        payment_type=PaymentType.LEVEL_UNLOCK.value,
        amount=float(level["unlock_fee"]),
        reference=reference,
        provider_access_code=data.get("access_code"),
        provider_response_raw=response,
        status=PaymentStatus.PENDING.value,
    )

    return {
        "payment_intent": intent,
        "authorization_url": data.get("authorization_url"),
        "access_code": data.get("access_code"),
        "reference": reference,
        "amount": float(level["unlock_fee"]),
        "level_number": int(level["level_number"]),
        "public_key": None,
        "payment_status": data.get("status"),
        "payment_channel": data.get("channel"),
    }


def initialize_final_stage_payment(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    level_id: int,
    email: str | None = None,
    callback_url: str | None = None,
) -> dict[str, Any]:
    level = get_level_by_id(conn, level_id)
    if not level:
        raise ValueError("Level not found.")

    if int(level["final_stage_enabled"] or 0) != 1:
        raise ValueError("This level does not support final-stage unlock.")

    user_level = get_user_level(conn, user_id, level_id)
    if not user_level:
        raise ValueError("You have not unlocked this level yet.")

    if user_level["status"] != UserLevelStatus.ACTIVE_FINAL_STAGE_PENDING.value:
        raise ValueError("Final stage is not available for payment yet.")

    contact_email = resolve_payment_emails(conn, user_id, email)

    # `_make_reference` is only a placeholder passed into
    # initialize_paystack_transaction below (unused by the hub, which mints
    # its own 6-digit reference) — the real reference used everywhere after
    # this point comes from the hub's response.
    placeholder_reference = _make_reference(
        user_id=user_id,
        level_number=int(level["level_number"]),
        payment_type=PaymentType.FINAL_STAGE_UNLOCK.value,
    )

    metadata = {
        "user_id": user_id,
        "level_id": level_id,
        "level_number": int(level["level_number"]),
        "payment_type": PaymentType.FINAL_STAGE_UNLOCK.value,
    }

    response = initialize_paystack_transaction(
        email=contact_email,
        amount=float(level["final_stage_fee"]),
        reference=placeholder_reference,
        callback_url=callback_url,
        metadata=metadata,
    )

    if not response.get("status"):
        raise ValueError(response.get("message", "Payment initialization failed."))

    data = response.get("data") or {}
    reference = data.get("reference") or placeholder_reference

    intent = _insert_payment_intent(
        conn,
        user_id=user_id,
        level_id=level_id,
        payment_type=PaymentType.FINAL_STAGE_UNLOCK.value,
        amount=float(level["final_stage_fee"]),
        reference=reference,
        provider_access_code=data.get("access_code"),
        provider_response_raw=response,
        status=PaymentStatus.PENDING.value,
    )

    return {
        "payment_intent": intent,
        "authorization_url": data.get("authorization_url"),
        "access_code": data.get("access_code"),
        "reference": reference,
        "amount": float(level["final_stage_fee"]),
        "level_number": int(level["level_number"]),
        "public_key": None,
        "payment_status": data.get("status"),
        "payment_channel": data.get("channel"),
    }


def pay_level_fee_with_balance(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    level_id: int,
    payment_type: str,
) -> dict[str, Any]:
    """Settles a level-unlock or final-stage fee straight out of the user's
    account balance instead of routing through the Payment Hub/Paystack.
    Only usable when an admin has switched on `allow_balance_payment` for
    the level in question (see /api/admin/levels/<id>/toggle-balance-payment).
    """
    level = get_level_by_id(conn, level_id)
    if not level:
        raise ValueError("Level not found.")

    if not int(level["allow_balance_payment"] or 0):
        raise ValueError("Balance payment is not enabled for this level.")

    if payment_type == PaymentType.LEVEL_UNLOCK.value:
        user_level = get_user_level(conn, user_id, level_id)
        if user_level and user_level["status"] != UserLevelStatus.LOCKED.value:
            raise ValueError("This level is already unlocked or completed.")
        amount = float(level["unlock_fee"] or 0)
    elif payment_type == PaymentType.FINAL_STAGE_UNLOCK.value:
        if int(level["final_stage_enabled"] or 0) != 1:
            raise ValueError("This level does not support final-stage unlock.")
        user_level = get_user_level(conn, user_id, level_id)
        if not user_level:
            raise ValueError("You have not unlocked this level yet.")
        if user_level["status"] != UserLevelStatus.ACTIVE_FINAL_STAGE_PENDING.value:
            raise ValueError("Final stage is not available for payment yet.")
        amount = float(level["final_stage_fee"] or 0)
    else:
        raise ValueError("Unsupported payment type.")

    amount = round(amount, 2)

    if amount > 0:
        cursor = conn.execute(
            """
            UPDATE users
            SET balance = ROUND(balance - ?, 2)
            WHERE user_id = ?
              AND COALESCE(balance, 0) >= ?
            """,
            (amount, user_id, amount),
        )
        if cursor.rowcount == 0:
            conn.rollback()
            raise ValueError("Insufficient account balance to cover this fee.")

    reference = f"EM_BAL_{user_id}_{int(level['level_number'])}_{int(time.time() * 1000)}_{secrets.token_hex(3)}"

    _insert_payment_intent(
        conn,
        user_id=user_id,
        level_id=level_id,
        payment_type=payment_type,
        amount=amount,
        reference=reference,
        provider_access_code=None,
        provider_response_raw={"provider": "balance", "note": "Paid from account balance."},
        status=PaymentStatus.SUCCESS.value,
        provider="balance",
    )
    conn.execute(
        "UPDATE payment_intents SET verified_at = ? WHERE reference = ?",
        (now_iso(), reference),
    )
    conn.commit()

    if payment_type == PaymentType.LEVEL_UNLOCK.value:
        user_level = mark_level_unlocked(conn, user_id, level_id)
        message = "Level unlocked using your account balance."
    else:
        user_level = mark_final_stage_unlocked(conn, user_id, level_id)
        message = "Final stage unlocked using your account balance."

    return {
        "success": True,
        "message": message,
        "reference": reference,
        "payment_type": payment_type,
        "level_id": level_id,
        "user_level": user_level,
        "payment_status": PaymentStatus.SUCCESS.value,
        "amount": amount,
    }


def _update_payment_intent_status(
    conn: sqlite3.Connection,
    *,
    reference: str,
    status: str,
    provider_response_raw: dict[str, Any],
    verified_at: str | None = None,
) -> None:
    conn.execute(
        """
        UPDATE payment_intents
        SET
            status = ?,
            provider_response_raw = ?,
            verified_at = COALESCE(?, verified_at),
            updated_at = ?
        WHERE reference = ?
        """,
        (
            status,
            json.dumps(provider_response_raw),
            verified_at,
            now_iso(),
            reference,
        ),
    )
    conn.commit()


def verify_and_apply_payment(
    conn: sqlite3.Connection,
    reference: str,
) -> dict[str, Any]:
    intent = fetch_one(
        conn,
        """
        SELECT *
        FROM payment_intents
        WHERE reference = ?
        """,
        (reference,),
    )
    if not intent:
        raise ValueError("Payment intent not found.")

    if intent["status"] == PaymentStatus.SUCCESS.value:
        return {
            "success": True,
            "message": "Payment already verified.",
            "reference": reference,
            "payment_type": intent["payment_type"],
            "level_id": intent["level_id"],
            "already_verified": True,
        }

    verification = verify_paystack_transaction(reference)
    if not verification.get("status"):
        _update_payment_intent_status(
            conn,
            reference=reference,
            status=PaymentStatus.FAILED.value,
            provider_response_raw=verification,
        )
        raise ValueError(verification.get("message", "Payment verification failed."))

    data = verification.get("data") or {}
    paystack_status = (data.get("status") or "").strip().lower()

    if paystack_status != "success":
        mapped_status = {
            "abandoned": PaymentStatus.ABANDONED.value,
            "failed": PaymentStatus.FAILED.value,
        }.get(paystack_status, PaymentStatus.PENDING.value)

        _update_payment_intent_status(
            conn,
            reference=reference,
            status=mapped_status,
            provider_response_raw=verification,
        )

        failure_reason = (
            data.get("message")
            or data.get("gateway_response")
            or f"Payment is not successful yet. Current status: {paystack_status or 'unknown'}"
        )

        return {
            "success": False,
            "message": failure_reason,
            "reference": reference,
            "payment_status": mapped_status,
        }

    verified_amount = float(data.get("amount", 0)) / float(PAYSTACK_SUBUNIT_MULTIPLIER)
    stored_amount = float(intent["amount"] or 0)

    if round(verified_amount, 2) != round(stored_amount, 2):
        _update_payment_intent_status(
            conn,
            reference=reference,
            status=PaymentStatus.FAILED.value,
            provider_response_raw=verification,
        )
        raise ValueError("Verified amount does not match expected payment amount.")

    timestamp = now_iso()
    _update_payment_intent_status(
        conn,
        reference=reference,
        status=PaymentStatus.SUCCESS.value,
        provider_response_raw=verification,
        verified_at=timestamp,
    )

    if intent["payment_type"] == PaymentType.LEVEL_UNLOCK.value:
        user_level = mark_level_unlocked(conn, intent["user_id"], int(intent["level_id"]))
        return {
            "success": True,
            "message": "Level unlock payment verified successfully.",
            "reference": reference,
            "payment_type": intent["payment_type"],
            "level_id": int(intent["level_id"]),
            "user_level": user_level,
            "payment_status": PaymentStatus.SUCCESS.value,
        }

    if intent["payment_type"] == PaymentType.FINAL_STAGE_UNLOCK.value:
        user_level = mark_final_stage_unlocked(conn, intent["user_id"], int(intent["level_id"]))
        return {
            "success": True,
            "message": "Final-stage payment verified successfully.",
            "reference": reference,
            "payment_type": intent["payment_type"],
            "level_id": int(intent["level_id"]),
            "user_level": user_level,
            "payment_status": PaymentStatus.SUCCESS.value,
        }

    raise ValueError("Unsupported payment type.")


def apply_partner_webhook_result(
    conn: sqlite3.Connection,
    *,
    reference: str,
    status: str | None,
    amount_ghs: float | None,
) -> dict[str, Any]:
    """Applies a payment result the Payment Hub pushed to us server-to-server,
    once Paystack's own webhook (which only ever calls the hub — Paystack
    supports one webhook URL per account) has confirmed it there. This is
    authenticated by an x-hub-signature HMAC over the raw body, verified with
    our PAYMENT_HUB_API_SECRET at the route level (see
    routes/payment_routes.py) — the same signature scheme used for outgoing
    hub requests, not a Paystack signature, since we never see Paystack's
    payload ourselves.

    Idempotent: an intent already marked SUCCESS is never re-applied, no
    matter how many times this runs — same guarantee as
    verify_and_apply_payment, whichever path lands first wins.
    """
    intent = fetch_one(
        conn,
        "SELECT * FROM payment_intents WHERE reference = ?",
        (reference,),
    )
    if not intent:
        # Not a reference EarnMaster created (or a stale/foreign call) - ignore.
        return {"success": False, "message": "Unknown reference.", "reference": reference}

    if intent["status"] == PaymentStatus.SUCCESS.value:
        return {
            "success": True,
            "message": "Already processed.",
            "reference": reference,
            "already_verified": True,
        }

    provider_response_raw = {
        "source": "payment_hub_webhook",
        "status": status,
        "amountGHS": amount_ghs,
    }

    # The hub sends status as "SUCCESS" / "FAILED" (see its
    # src/routes/paystackWebhook.js) — compare case-insensitively.
    if str(status or "").strip().upper() != "SUCCESS":
        _update_payment_intent_status(
            conn,
            reference=reference,
            status=PaymentStatus.FAILED.value,
            provider_response_raw=provider_response_raw,
        )
        return {"success": False, "message": "Payment not successful.", "reference": reference}

    stored_amount = float(intent["amount"] or 0)
    if amount_ghs is not None and round(float(amount_ghs), 2) != round(stored_amount, 2):
        _update_payment_intent_status(
            conn,
            reference=reference,
            status=PaymentStatus.FAILED.value,
            provider_response_raw=provider_response_raw,
        )
        return {"success": False, "message": "Amount mismatch.", "reference": reference}

    timestamp = now_iso()
    _update_payment_intent_status(
        conn,
        reference=reference,
        status=PaymentStatus.SUCCESS.value,
        provider_response_raw=provider_response_raw,
        verified_at=timestamp,
    )

    if intent["payment_type"] == PaymentType.LEVEL_UNLOCK.value:
        mark_level_unlocked(conn, intent["user_id"], int(intent["level_id"]))
    elif intent["payment_type"] == PaymentType.FINAL_STAGE_UNLOCK.value:
        mark_final_stage_unlocked(conn, intent["user_id"], int(intent["level_id"]))

    return {
        "success": True,
        "message": "Payment credited via partner webhook.",
        "reference": reference,
        "payment_type": intent["payment_type"],
        "level_id": int(intent["level_id"]),
        "payment_status": PaymentStatus.SUCCESS.value,
    }
