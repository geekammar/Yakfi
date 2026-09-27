#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="$HOME/.config/opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.json"

echo
echo "======================================================"
echo " Fix APMIX GPT-6 Luna Free for OpenCode"
echo "======================================================"
echo

if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 is required."
    exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: OpenCode config not found:"
    echo "       $CONFIG_FILE"
    exit 1
fi

# ------------------------------------------------------
# Backup
# ------------------------------------------------------

BACKUP_FILE="$CONFIG_FILE.backup.$(date +%Y%m%d_%H%M%S)"

cp "$CONFIG_FILE" "$BACKUP_FILE"

echo "[OK] Backup created:"
echo "     $BACKUP_FILE"
echo

# ------------------------------------------------------
# Modify APMIX provider
# ------------------------------------------------------

python3 <<'PY'
import json
from pathlib import Path

config_file = Path.home() / ".config/opencode/opencode.json"

with config_file.open("r", encoding="utf-8") as f:
    config = json.load(f)

if not isinstance(config, dict):
    raise SystemExit("Invalid opencode.json root.")

providers = config.setdefault("provider", {})

if not isinstance(providers, dict):
    raise SystemExit("'provider' must be an object.")

apmix = providers.get("apmix")

if not isinstance(apmix, dict):
    raise SystemExit(
        "APMIX provider was not found in opencode.json."
    )

# ------------------------------------------------------
# Make sure APMIX uses the correct OpenAI-compatible SDK
# ------------------------------------------------------

apmix["npm"] = "@ai-sdk/openai-compatible"
apmix["name"] = "APMIX"

# ------------------------------------------------------
# Make sure API key is NOT stored in config
# ------------------------------------------------------

options = apmix.get("options", {})

if not isinstance(options, dict):
    options = {}

options.pop("apiKey", None)
options.pop("apikey", None)

options["baseURL"] = "https://api.apmix.ai/v1"

apmix["options"] = options

# ------------------------------------------------------
# Models
# ------------------------------------------------------

models = apmix.get("models", {})

if not isinstance(models, dict):
    models = {}

# Remove the WRONG event model ID that was used previously.
wrong_ids = [
    "openai/gpt-6-luna-free"
]

for model_id in wrong_ids:
    if model_id in models:
        del models[model_id]
        print(f"[REMOVED] {model_id}")

# ------------------------------------------------------
# Add the OFFICIAL event model ID.
#
# Official APMIX event page:
#   gpt-6-luna-free
#
# The event page explicitly says:
#   "Type it exactly"
# ------------------------------------------------------

models["gpt-6-luna-free"] = {
    "name": "GPT-6 Luna Free",
    "limit": {
        "context": 1100000,
        "output": 65536
    }
}

# ------------------------------------------------------
# Also ensure the currently listed free DeepSeek model
# remains available when already supported by APMIX.
# ------------------------------------------------------

if "deepseek/deepseek-v4-flash-free" not in models:
    models["deepseek/deepseek-v4-flash-free"] = {
        "name": "DeepSeek V4 Flash Free",
        "limit": {
            "context": 128000,
            "output": 65536
        }
    }

# Current APMIX Models page also lists Space Bunny Free.
if "stealth/space-bunny-free" not in models:
    models["stealth/space-bunny-free"] = {
        "name": "Space Bunny Free",
        "limit": {
            "context": 128000,
            "output": 65536
        }
    }

apmix["models"] = models

providers["apmix"] = apmix

# ------------------------------------------------------
# Atomic write
# ------------------------------------------------------

tmp_file = config_file.with_suffix(".tmp")

with tmp_file.open("w", encoding="utf-8") as f:
    json.dump(
        config,
        f,
        ensure_ascii=False,
        indent=2
    )
    f.write("\n")

tmp_file.replace(config_file)

print()
print("[OK] APMIX configuration repaired.")
print("[OK] Removed incorrect model ID:")
print("     openai/gpt-6-luna-free")
print()
print("[OK] Added correct model ID:")
print("     gpt-6-luna-free")
print()
print("[OK] Added/kept free models:")
print("     gpt-6-luna-free")
print("     deepseek/deepseek-v4-flash-free")
print("     stealth/space-bunny-free")
print()
print("[OK] API key was NOT added.")
PY

echo
echo "======================================================"
echo " FIX COMPLETE"
echo "======================================================"
echo

echo "APMIX endpoint:"
echo "  https://api.apmix.ai/v1"
echo

echo "Correct event model:"
echo "  gpt-6-luna-free"
echo

echo "Now start OpenCode:"
echo
echo "  opencode"
echo

echo "Then:"
echo
echo "  /models"
echo

echo "Look for:"
echo
echo "  apmix / GPT-6 Luna Free"
echo

echo "======================================================"
