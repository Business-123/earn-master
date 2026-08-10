"""
One-time migration: reassign payment_email for ALL existing users using the
current PAYMENT_EMAIL_POOL (services/user_email_service.py).

Use this after changing PAYMENT_EMAIL_POOL, since ensure_user_payment_email()
only fills in an email the first time and never overwrites an existing value -
so users created before the pool was changed keep their old address forever
unless you run this.

Usage:
    python3 database/reset_payment_emails.py
"""

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import DATABASE_PATH
from services.user_email_service import payment_email_for_index


def reset_payment_emails() -> None:
    conn = sqlite3.connect(str(DATABASE_PATH))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT id, user_id, payment_email FROM users ORDER BY id ASC").fetchall()
        updated = 0
        for row in rows:
            new_email = payment_email_for_index(row["id"] or 1)
            if (row["payment_email"] or "").strip().lower() != new_email:
                conn.execute(
                    "UPDATE users SET payment_email = ? WHERE user_id = ?",
                    (new_email, row["user_id"]),
                )
                updated += 1
        conn.commit()
        print(f"Checked {len(rows)} users. Updated {updated} payment_email value(s).")
    finally:
        conn.close()


if __name__ == "__main__":
    reset_payment_emails()
