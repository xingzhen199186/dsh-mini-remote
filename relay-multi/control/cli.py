"""安装与运维用的最小命令行。不会回显密码。"""

from __future__ import annotations

import argparse
import sys

from .database import Database


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m control.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init-db")
    init.add_argument("--db", required=True)
    init.add_argument("--max-tenants", type=int, default=20)

    has_admin = sub.add_parser("has-admin")
    has_admin.add_argument("--db", required=True)
    has_admin.add_argument("--username", default="admin")

    set_admin = sub.add_parser("set-admin")
    set_admin.add_argument("--db", required=True)
    set_admin.add_argument("--username", default="admin")
    set_admin.add_argument("--password-stdin", action="store_true")

    check = sub.add_parser("check-db")
    check.add_argument("--db", required=True)

    args = parser.parse_args(argv)
    db = Database(args.db)

    if args.command == "init-db":
        if not 1 <= args.max_tenants <= 100:
            print("max-tenants 必须在 1..100", file=sys.stderr)
            return 2
        db.initialize(args.max_tenants)
        print("database ready")
        return 0

    if args.command == "has-admin":
        print("yes" if db.has_admin(args.username) else "no")
        return 0

    if args.command == "set-admin":
        if not args.password_stdin:
            print("密码必须从标准输入提供", file=sys.stderr)
            return 2
        password = sys.stdin.read().rstrip("\n")
        if len(password) < 12:
            print("管理员密码至少 12 位", file=sys.stderr)
            return 2
        db.initialize()
        db.set_admin(args.username, password=password)
        print("admin updated")
        return 0

    if args.command == "check-db":
        print(db.integrity_check())
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
