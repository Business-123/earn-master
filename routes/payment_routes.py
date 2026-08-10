import hashlib
import hmac

from flask import Blueprint, jsonify, request

from config import PAYMENT_HUB_API_SECRET
from services.db_service import get_connection
from services.payment_history_service import get_user_payment_history
from services.paystack_service import (
    apply_partner_webhook_result,
    get_payment_config,
    initialize_final_stage_payment,
    initialize_level_unlock_payment,
    verify_and_apply_payment,
)
from utils.auth import json_error as auth_json_error, require_user_access

payment_bp = Blueprint("payment_bp", __name__)


def _json_error(
    message: str,
    status_code: int = 400,
    *,
    session_invalidated: bool = False,
    blocked: bool = False,
    restriction: str | None = None,
):
    return auth_json_error(
        message,
        status_code,
        session_invalidated=session_invalidated,
        blocked=blocked,
        restriction=restriction,
    )


@payment_bp.get("/api/payments/config")
def payments_config():
    try:
        config = get_payment_config()
        return jsonify({"success": True, "config": config})
    except ValueError as exc:
        return _json_error(str(exc), 500)


@payment_bp.post("/api/payments/level-unlock/init")
def payments_level_unlock_init():
    data = request.get_json(silent=True) or {}

    user, _payload, error = require_user_access("deposit", data)
    if error:
        return error

    level_id = data.get("level_id")
    contact_email = data.get("contact_email") or data.get("email")
    callback_url = data.get("callback_url")

    if not level_id:
        return _json_error("Missing level_id.")

    try:
        level_id = int(level_id)
    except Exception:
        return _json_error("Invalid level_id.")

    try:
        with get_connection() as conn:
            result = initialize_level_unlock_payment(
                conn=conn,
                user_id=user["user_id"],
                level_id=level_id,
                email=contact_email,
                callback_url=callback_url,
            )
        return jsonify({"success": True, "payment": result})
    except ValueError as exc:
        return _json_error(str(exc), 400)


@payment_bp.post("/api/payments/final-stage/init")
def payments_final_stage_init():
    data = request.get_json(silent=True) or {}

    user, _payload, error = require_user_access("deposit", data)
    if error:
        return error

    level_id = data.get("level_id")
    contact_email = data.get("contact_email") or data.get("email")
    callback_url = data.get("callback_url")

    if not level_id:
        return _json_error("Missing level_id.")

    try:
        level_id = int(level_id)
    except Exception:
        return _json_error("Invalid level_id.")

    try:
        with get_connection() as conn:
            result = initialize_final_stage_payment(
                conn=conn,
                user_id=user["user_id"],
                level_id=level_id,
                email=contact_email,
                callback_url=callback_url,
            )
        return jsonify({"success": True, "payment": result})
    except ValueError as exc:
        return _json_error(str(exc), 400)


@payment_bp.post("/api/payments/level-unlock/verify")
def payments_level_unlock_verify():
    data = request.get_json(silent=True) or {}
    reference = (data.get("reference") or "").strip()

    if not reference:
        return _json_error("Missing reference.")

    try:
        with get_connection() as conn:
            result = verify_and_apply_payment(conn, reference)
        return jsonify(result)
    except ValueError as exc:
        return _json_error(str(exc), 400)


@payment_bp.post("/api/payments/final-stage/verify")
def payments_final_stage_verify():
    data = request.get_json(silent=True) or {}
    reference = (data.get("reference") or "").strip()

    if not reference:
        return _json_error("Missing reference.")

    try:
        with get_connection() as conn:
            result = verify_and_apply_payment(conn, reference)
        return jsonify(result)
    except ValueError as exc:
        return _json_error(str(exc), 400)


@payment_bp.get("/api/payments/verify/<reference>")
def payments_verify_reference(reference: str):
    try:
        with get_connection() as conn:
            result = verify_and_apply_payment(conn, reference.strip())
        return jsonify(result)
    except ValueError as exc:
        return _json_error(str(exc), 400)


@payment_bp.post("/api/payments/partner-webhook")
def payments_partner_webhook():
    # The Payment Hub holds the real Paystack keys for this Paystack account
    # and is the only URL Paystack itself ever calls. Once its own webhook
    # (src/routes/paystackWebhook.js over there) confirms a payment for one
    # of our references, it POSTs the result to this URL (registered as this
    # site's webhookUrl when we were set up as a merchant on the hub),
    # signed with our shared PAYMENT_HUB_API_SECRET — not a Paystack
    # signature, since we never see Paystack's payload ourselves.
    raw_body = request.get_data() or b""
    signature = request.headers.get("x-hub-signature", "")

    expected_signature = hmac.new(
        PAYMENT_HUB_API_SECRET.encode("utf-8"),
        raw_body,
        hashlib.sha512,
    ).hexdigest()

    if (
        not PAYMENT_HUB_API_SECRET
        or not signature
        or not hmac.compare_digest(signature, expected_signature)
    ):
        return "", 401

    data = request.get_json(silent=True) or {}
    reference = (data.get("reference") or "").strip()
    status = data.get("status")
    amount_ghs = data.get("amount")

    if not reference:
        return jsonify({"error": "reference is required."}), 400

    with get_connection() as conn:
        apply_partner_webhook_result(
            conn,
            reference=reference,
            status=status,
            amount_ghs=amount_ghs,
        )

    # Always 200 once we've handled it (even "unknown reference" or
    # "already processed") so the hub doesn't keep retrying.
    return "", 200


@payment_bp.get("/api/payments/history")
def payments_history():
    user, _payload, error = require_user_access()
    if error:
        return error

    with get_connection() as conn:
        transactions = get_user_payment_history(conn, user["user_id"])
    return jsonify({"success": True, "transactions": transactions})
