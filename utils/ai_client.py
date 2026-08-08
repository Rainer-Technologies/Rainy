"""OpenAI-compatible chat client for Rainy's AI features.

Used by the AI-driven music discovery feed (and anything else that wants an
LLM). Configuration is stored in the `settings` table so users can point Rainy
at any OpenAI-compatible endpoint (base URL, model, API key) from the Settings
UI, with `.env` values as the initial/default fallback.

Handles reasoning models: some backends (e.g. DeepSeek-style) return
`reasoning_content` alongside `content`; we ask for enough `max_tokens` and
return the final `content` (JSON-stripped when requested).
"""
import json
import os

import requests

from models.settings import SettingsModel

DEFAULT_MAX_TOKENS = 1024
REQUEST_TIMEOUT = 60


def get_config():
    """Return {'base_url', 'model', 'api_key'} from settings, falling back to .env."""
    base_url = SettingsModel.get_setting('ai_base_url') or os.getenv(
        'AI_BASE_URL', 'https://opencode.ai/zen/go/v1/chat/completions')
    model = SettingsModel.get_setting('ai_model') or os.getenv(
        'AI_MODEL', 'deepseek-v4-flash')
    api_key = SettingsModel.get_setting('ai_api_key') or os.getenv(
        'AI_API_KEY', '')
    return {'base_url': base_url, 'model': model, 'api_key': api_key}


def save_config(base_url, model, api_key):
    """Persist AI config to the settings table (returns normalized dict)."""
    SettingsModel.set_setting('ai_base_url', (base_url or '').strip())
    SettingsModel.set_setting('ai_model', (model or '').strip())
    SettingsModel.set_setting('ai_api_key', (api_key or '').strip())
    return get_config()


def is_configured():
    cfg = get_config()
    return bool(cfg['base_url'] and cfg['model'] and cfg['api_key'])


def chat(messages, max_tokens=DEFAULT_MAX_TOKENS, temperature=0.7,
         json_mode=False, timeout=REQUEST_TIMEOUT, reasoning_effort='low'):
    """Send a chat completion, return the assistant's content string.

    Raises on network/HTTP errors so callers can fall back gracefully.
    `json_mode=True` asks the model for strict JSON and strips fences.
    `reasoning_effort` caps the model's thinking ('low'/'medium'/'high' or
    None to leave the backend default) — reasoning models can otherwise burn
    the whole token budget on `reasoning_content` and return empty answers.
    """
    cfg = get_config()
    if not cfg['api_key']:
        raise RuntimeError('AI API key not configured')

    payload = {
        'model': cfg['model'],
        'messages': messages,
        'max_tokens': max_tokens,
        'temperature': temperature,
    }
    if reasoning_effort:
        payload['reasoning_effort'] = reasoning_effort
    if json_mode:
        payload['response_format'] = {'type': 'json_object'}

    resp = requests.post(
        cfg['base_url'],
        headers={
            'Authorization': f"Bearer {cfg['api_key']}",
            'Content-Type': 'application/json',
        },
        json=payload,
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    try:
        content = data['choices'][0]['message'].get('content') or ''
    except (KeyError, IndexError, TypeError):
        content = ''
    if json_mode:
        content = _strip_json(content)
    return content


def chat_json(messages, max_tokens=DEFAULT_MAX_TOKENS, temperature=0.7,
              timeout=REQUEST_TIMEOUT, reasoning_effort='low'):
    """Like chat() but parse the content as JSON. Returns parsed object or None.

    Tries once with `response_format: json_object`; if the reply is
    unparseable (common with reasoning models that spend the token budget
    thinking and get truncated), retries WITHOUT the format hint, which lets
    the model answer more directly.
    """
    content = chat(messages, max_tokens=max_tokens, temperature=temperature,
                   json_mode=True, timeout=timeout,
                   reasoning_effort=reasoning_effort)
    parsed = _parse_json(content)
    if parsed is not None:
        return parsed
    # Retry without the json_object hint (more reliable for reasoning models).
    content = chat(messages, max_tokens=max_tokens, temperature=temperature,
                   json_mode=False, timeout=timeout,
                   reasoning_effort=reasoning_effort)
    return _parse_json(content)


def _parse_json(content):
    if not content:
        return None
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        # Last resort: try to find the first {...} or [...] block.
        start = min([i for i in (content.find('{'), content.find('[')) if i >= 0] or [-1])
        end = max(content.rfind('}'), content.rfind(']'))
        if 0 <= start < end:
            try:
                return json.loads(content[start:end + 1])
            except json.JSONDecodeError:
                return None
        return None


def test_connection():
    """Quick connectivity check; returns (ok, detail)."""
    try:
        content = chat(
            [{'role': 'user', 'content': 'Reply with exactly: OK'}],
            max_tokens=50,
        )
        ok = 'OK' in (content or '').upper()
        return ok, (content or '(empty reply)')[:120]
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def _strip_json(content):
    """Remove markdown fences / surrounding prose from a JSON reply."""
    content = content.strip()
    if content.startswith('```'):
        # Strip ```json ... ``` fence
        lines = content.splitlines()
        if lines and lines[0].startswith('```'):
            lines = lines[1:]
        if lines and lines[-1].strip() == '```':
            lines = lines[:-1]
        content = '\n'.join(lines).strip()
    return content
