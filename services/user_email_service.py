import re
import sqlite3
from typing import Any


EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def is_valid_contact_email(value: Any) -> bool:
    return bool(EMAIL_PATTERN.match(normalize_email(value)))


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row["name"] == column for row in rows)


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return bool(row)


def ensure_user_email_columns(conn: sqlite3.Connection) -> None:
    if not table_exists(conn, "users"):
        return
    if not column_exists(conn, "users", "contact_email"):
        conn.execute("ALTER TABLE users ADD COLUMN contact_email TEXT")


def backfill_user_email_fields(conn: sqlite3.Connection) -> None:
    ensure_user_email_columns(conn)
    if not table_exists(conn, "users"):
        return

    rows = conn.execute(
        """
        SELECT id, user_id, email, contact_email
        FROM users
        ORDER BY id ASC
        """
    ).fetchall()

    for row in rows:
        contact_email = normalize_email(row["contact_email"] or row["email"]) or None
        conn.execute(
            """
            UPDATE users
            SET
                contact_email = COALESCE(NULLIF(TRIM(contact_email), ''), ?),
                email = COALESCE(NULLIF(TRIM(email), ''), ?)
            WHERE user_id = ?
            """,
            (contact_email, contact_email, row["user_id"]),
        )


def get_user_contact_email(conn: sqlite3.Connection, user_id: str) -> str | None:
    ensure_user_email_columns(conn)
    row = conn.execute(
        """
        SELECT contact_email, email
        FROM users
        WHERE user_id = ?
        """,
        (user_id,),
    ).fetchone()
    if not row:
        return None
    return normalize_email(row["contact_email"] or row["email"]) or None


def save_user_contact_email(conn: sqlite3.Connection, user_id: str, email: str) -> str:
    clean_email = normalize_email(email)
    if not is_valid_contact_email(clean_email):
        raise ValueError("A valid contact email is required before your first payment.")

    ensure_user_email_columns(conn)
    conn.execute(
        """
        UPDATE users
        SET contact_email = ?, email = ?
        WHERE user_id = ?
        """,
        (clean_email, clean_email, user_id),
    )
    conn.commit()
    return clean_email
