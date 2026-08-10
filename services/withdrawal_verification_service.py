"""One-time withdrawal verification fee.

Before a user's very first withdrawal, they must pay a small, admin-editable
verification fee (see services/settings_service.py). This reuses the same
Payment Hub / Paystack rail as level payments (services/paystack_service.py)
but is tracked in its own table since it isn't tied to a level.
"""

import json
import secrets
import sqlite3
import time
from typing import Any

from config import PAYMENT_CURRENCY, PAYSTACK_SUBUNIT_MULTIPLIER
from services.db_service import fetch_one, now_iso
from services.paystack_service import (
    initialize_paystack_transaction,
    resolve_payment_emails,
    verify_paystack_transaction,
)
from services.settings_service import get_withdrawal_verification_fee
from utils.enums import PaymentStatus


def is_withdrawal_verification_paid(conn: sqlite3.Connection, user_id: str) -> bool:
    row = fetch_one(
        conn,
        "SELECT withdrawal_verification_paid FROM users WHERE user_id = ?",
        (user_id,),
    )
    if not row:
        raise ValueError("User not found.")
    return bool(row.get("withdrawal_verification_paid"))


def get_withdrawal_verification_status(
    conn: sqlite3.Connection,
    user_id: str,
) -> dict[str, Any]:
    fee = get_withdrawal_verification_fee(conn)
    paid = is_withdrawal_verification_paid(conn, user_id)
    return {
        "required": not paid,
        "paid": paid,
        "fee": fee,
        "currency": PAYMENT_CURRENCY,
    }


def mark_withdrawal_verification_paid(conn: sqlite3.Connection, user_id: str) -> None:
    conn.execute(
        """
        UPDATE users
        SET withdrawal_verification_paid = 1,
            withdrawal_verification_paid_at = ?
        WHERE user_id = ?
        """,
        (now_iso(), user_id),
    )
    conn.commit()


def _make_reference(user_id: str) -> str:
    # Placeholder only — the hub mints and returns its own reference, same
    # pattern as _make_reference in paystack_service.py.
    return f"EM_WVF_{user_id}_{int(time.time() * 1000)}_{secrets.token_hex(4)}"


def _update_status(
    conn: sqlite3.Connection,
    *,
    reference: str,
    status: str,
    provider_response_raw: dict[str, Any],
    verified_at: str | None = None,
) -> None:
    conn.execute(
        """
        UPDATE withdrawal_verification_payments
        SET status = ?,
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


def initialize_withdrawal_verification_payment(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    email: str | None = None,
    callback_url: str | None = None,
) -> dict[str, Any]:
    if is_withdrawal_verification_paid(conn, user_id):
        raise ValueError("Withdrawal verification fee has already been paid.")

    fee = get_withdrawal_verification_fee(conn)

    if fee <= 0:
        # Admin has set the fee to 0 — nothing to charge, just clear the gate.
        mark_withdrawal_verification_paid(conn, user_id)
        return {"waived": True, "amount": 0.0, "reference": None}

    contact_email = resolve_payment_emails(conn, user_id, email)
    placeholder_reference = _make_reference(user_id)

    metadata = {
        "user_id": user_id,
        "payment_type": "withdrawal_verification",
    }

    response = initialize_paystack_transaction(
        email=contact_email,
        amount=fee,
        reference=placeholder_reference,
        callback_url=callback_url,
        metadata=metadata,
    )

    if not response.get("status"):
        raise ValueError(response.get("message", "Payment initialization failed."))

    data = response.get("data") or {}
    reference = data.get("reference") or placeholder_reference
    timestamp = now_iso()

    conn.execute(
        """
        INSERT INTO withdrawal_verification_payments (
            user_id,
            reference,
            amount,
            currency,
            provider,
            status,
            provider_response_raw,
            verified_at,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user_id,
            reference,
            fee,
            PAYMENT_CURRENCY,
            "paystack",
            PaymentStatus.PENDING.value,
            json.dumps(response),
            None,
            timestamp,
            timestamp,
        ),
    )
    conn.commit()

    return {
        "waived": False,
        "reference": reference,
        "amount": fee,
        "currency": PAYMENT_CURRENCY,
        "authorization_url": data.get("authorization_url"),
        "payment_status": data.get("status"),
    }


def verify_withdrawal_verification_payment(
    conn: sqlite3.Connection,
    reference: str,
) -> dict[str, Any]:
    intent = fetch_one(
        conn,
        "SELECT * FROM withdrawal_verification_payments WHERE reference = ?",
        (reference,),
    )
    if not intent:
        raise ValueError("Verification payment not found.")

    if intent["status"] == PaymentStatus.SUCCESS.value:
        mark_withdrawal_verification_paid(conn, intent["user_id"])
        return {
            "success": True,
            "message": "Verification fee already paid.",
            "reference": reference,
            "already_verified": True,
        }

    verification = verify_paystack_transaction(reference)
    if not verification.get("status"):
        _update_status(
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

        _update_status(
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
        _update_status(
            conn,
            reference=reference,
            status=PaymentStatus.FAILED.value,
            provider_response_raw=verification,
        )
        raise ValueError("Verified amount does not match expected payment amount.")

    timestamp = now_iso()
    _update_status(
        conn,
        reference=reference,
        status=PaymentStatus.SUCCESS.value,
        provider_response_raw=verification,
        verified_at=timestamp,
    )
    mark_withdrawal_verification_paid(conn, intent["user_id"])

    return {
        "success": True,
        "message": "Withdrawal verification fee paid successfully.",
        "reference": reference,
        "payment_status": PaymentStatus.SUCCESS.value,
        "amount": stored_amount,
    }
