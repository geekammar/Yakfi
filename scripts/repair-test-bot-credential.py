#!/usr/bin/env python3
"""Masked launcher. Defaults to diagnosis; never reads/writes .env files.
Supply the EXACT current Preview master key (hex or base64), not a new key.
A local success still requires verification through the actual Preview app.
"""
import argparse
import getpass
import json
import os
import subprocess
import sys
import warnings
from pathlib import Path


def hidden(label):
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        return getpass.getpass(label).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Repair the fixed test connection using the supplied bot token")
    parser.add_argument("--from-environment", action="store_true", help="Read DATABASE_URL, CREDENTIAL_MASTER_KEY and optional TEST_BOT_TOKEN from an authorized secret-bearing environment")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    payload = {
        "databaseUrl": os.environ.get("DATABASE_URL", "") if args.from_environment else hidden("Authorized test DATABASE_URL (hidden): "),
        "masterKey": os.environ.get("CREDENTIAL_MASTER_KEY", "") if args.from_environment else hidden("EXACT current Preview CREDENTIAL_MASTER_KEY (hidden): "),
        "apply": args.apply,
    }
    if args.apply:
        payload["token"] = os.environ.get("TEST_BOT_TOKEN", "") if args.from_environment else hidden("Existing @Drafnanafnanbot token (hidden): ")
    try:
        result = subprocess.run(
            ["node", "--import", "tsx", str(root / "scripts/repair-test-bot-credential.ts")],
            cwd=root, input=json.dumps(payload), capture_output=True,
            text=True, timeout=75, check=False,
        )
        report = json.loads(result.stdout)
        # Only allow known output fields. Never print raw worker stdout/stderr.
        for field in ("ok", "status", "code", "diagnosis", "previousReference", "newReference", "previewVerified"):
            if field in report:
                print(f"{field}: {report[field]}")
        return 0 if result.returncode == 0 and report.get("ok") else 1
    except subprocess.TimeoutExpired:
        print("RECOVERY_TIMEOUT: outcome may be unknown; diagnose before retrying.")
        return 1
    except Exception:
        print("WORKER_FAILED: no raw output displayed. Check dependencies and use the reviewed files together.")
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (getpass.GetPassWarning, EOFError, KeyboardInterrupt):
        sys.exit("MASKED_INPUT_UNAVAILABLE_OR_CANCELLED")
