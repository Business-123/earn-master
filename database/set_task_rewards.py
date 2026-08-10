"""
One-time migration: set the reward for ALL existing bonus_task_catalog rows
to a fixed amount (default 0.01).

Server startup only inserts bonus tasks with `INSERT OR IGNORE`, so it never
overwrites the reward on rows that already exist - if the DB was seeded
before BONUS_TASK_REWARD changed, existing rows keep the old value forever
unless you run this once.

After this runs, rewards can be changed per-task any time from the Admin
console (Tasks tab), and this script will not overwrite those admin edits
unless you run it again on purpose.

Usage:
    python3 database/set_task_rewards.py
    python3 database/set_task_rewards.py 0.05   # optional custom amount
"""

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import DATABASE_PATH


def set_task_rewards(reward: float = 0.01) -> None:
    conn = sqlite3.connect(str(DATABASE_PATH))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, task_key, title, reward FROM bonus_task_catalog ORDER BY id ASC"
        ).fetchall()

        updated = 0
        for row in rows:
            if float(row["reward"] or 0) != float(reward):
                conn.execute(
                    "UPDATE bonus_task_catalog SET reward = ? WHERE id = ?",
                    (float(reward), row["id"]),
                )
                updated += 1

        conn.commit()
        print(f"Checked {len(rows)} task(s). Updated {updated} task reward(s) to {reward}.")
    finally:
        conn.close()


if __name__ == "__main__":
    amount = float(sys.argv[1]) if len(sys.argv) > 1 else 0.01
    set_task_rewards(amount)
