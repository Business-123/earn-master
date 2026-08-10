"""Small generic key/value settings store, used for admin-editable values
that don't warrant their own dedicated table/column (e.g. the one-time
withdrawal verification fee).
"""

import sqlite3

from services.db_service import fetch_one, now_iso

WITHDRAWAL_VERIFICATION_FEE_KEY = "withdrawal_verification_fee"
DEFAULT_WITHDRAWAL_VERIFICATION_FEE = 0.01


def ensure_app_settings_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT
        )
        """
    )


def get_setting(
    conn: sqlite3.Connection,
    key: str,
    default: str | None = None,
) -> str | None:
    ensure_app_settings_table(conn)
    row = fetch_one(conn, "SELECT value FROM app_settings WHERE key = ?", (key,))
    if not row or row.get("value") is None:
        return default
    return row["value"]


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    ensure_app_settings_table(conn)
    conn.execute(
        """
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        """,
        (key, value, now_iso()),
    )
    conn.commit()


def get_withdrawal_verification_fee(conn: sqlite3.Connection) -> float:
    raw = get_setting(
        conn,
        WITHDRAWAL_VERIFICATION_FEE_KEY,
        str(DEFAULT_WITHDRAWAL_VERIFICATION_FEE),
    )
    try:
        value = round(float(raw), 2)
    except (TypeError, ValueError):
        return DEFAULT_WITHDRAWAL_VERIFICATION_FEE
    return value if value >= 0 else DEFAULT_WITHDRAWAL_VERIFICATION_FEE


def set_withdrawal_verification_fee(conn: sqlite3.Connection, amount: float) -> float:
    try:
        clean_amount = round(float(amount), 2)
    except (TypeError, ValueError):
        raise ValueError("Invalid fee amount.")

    if clean_amount < 0:
        raise ValueError("Fee amount cannot be negative.")

    set_setting(conn, WITHDRAWAL_VERIFICATION_FEE_KEY, str(clean_amount))
    return clean_amount
