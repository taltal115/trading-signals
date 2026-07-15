"""Load entry/holding prompts from markdown under prompts/."""

from __future__ import annotations

from pathlib import Path

# scripts/ai_stock_eval → repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
PROMPTS_ROOT = REPO_ROOT / "prompts"


def load_prompt(relative: str) -> str:
    path = PROMPTS_ROOT / relative
    if not path.is_file():
        raise FileNotFoundError(f"Prompt file missing: {path}")
    return path.read_text(encoding="utf-8").strip()


def get_entry_prompts() -> tuple[str, str]:
    """Return (system_prompt, user_template) for entry evaluation."""
    guard = load_prompt("shared/system_guardrails.md")
    system = load_prompt("entry/entry_evaluator_system.md")
    user = load_prompt("entry/entry_evaluator_user_template.md")
    return f"{guard}\n\n{system}", user


def get_holding_prompts() -> tuple[str, str]:
    """Return (system_prompt, user_template) for holding advisor."""
    guard = load_prompt("shared/system_guardrails.md")
    system = load_prompt("holding/holding_advisor_system.md")
    user = load_prompt("holding/holding_advisor_user_template.md")
    return f"{guard}\n\n{system}", user


# Back-compat aliases used by older imports / --debug-prompt
SYSTEM_PROMPT, USER_PROMPT_TEMPLATE = get_entry_prompts()
