#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import sys
from typing import Any, Dict, Tuple


def _read_private_key(raw_value: str, project_root: pathlib.Path) -> Tuple[str, Dict[str, Any]]:
  value = (raw_value or "").strip()
  if not value:
    return "", {"ok": False, "mode": "missing", "reason": "empty"}

  if "PRIVATE KEY" in value and "-----BEGIN" in value:
    return value, {"ok": True, "mode": "inline_pem"}

  normalized = value.strip("\"'")
  candidates = []
  p = pathlib.Path(normalized)
  if p.is_absolute():
    candidates.append(p)
  else:
    candidates.append((pathlib.Path.cwd() / p).resolve())
    candidates.append((project_root / p).resolve())

  for file_path in candidates:
    if not file_path.exists() or not file_path.is_file():
      continue
    content = file_path.read_text(encoding="utf-8").strip()
    if "PRIVATE KEY" in content and "-----BEGIN" in content:
      return content, {"ok": True, "mode": "file_path", "resolvedPath": str(file_path)}
    return "", {
      "ok": False,
      "mode": "file_path",
      "reason": "file_exists_but_not_pem",
      "resolvedPath": str(file_path),
    }

  return "", {"ok": False, "mode": "file_path", "reason": "file_not_found"}


def _short_msg(err: BaseException) -> str:
  msg = str(err).strip()
  return msg[:300] if msg else err.__class__.__name__


def run_probe(prompt_key: str) -> Dict[str, Any]:
  project_root = pathlib.Path(__file__).resolve().parents[2]

  try:
    import cozeloop  # type: ignore
  except Exception as error:
    return {
      "ok": False,
      "stage": "import",
      "errorType": error.__class__.__name__,
      "message": _short_msg(error),
      "hint": "请先安装: python3 -m pip install --user cozeloop",
    }

  try:
    cozeloop.set_log_level("CRITICAL")
  except Exception:
    pass

  api_base_url = (os.getenv("COZE_API_BASE_URL", "https://api.coze.cn") or "").strip()
  workspace_id = (os.getenv("COZELOOP_WORKSPACE_ID", "") or "").strip()
  client_id = (os.getenv("COZELOOP_JWT_OAUTH_CLIENT_ID", "") or "").strip()
  public_key_id = (os.getenv("COZELOOP_JWT_OAUTH_PUBLIC_KEY_ID", "") or "").strip()
  private_key_raw = os.getenv("COZELOOP_JWT_OAUTH_PRIVATE_KEY", "")
  private_key, private_key_meta = _read_private_key(private_key_raw, project_root)

  env = {
    "COZE_API_BASE_URL": bool(api_base_url),
    "COZELOOP_WORKSPACE_ID": bool(workspace_id),
    "COZELOOP_JWT_OAUTH_CLIENT_ID": bool(client_id),
    "COZELOOP_JWT_OAUTH_PUBLIC_KEY_ID": bool(public_key_id),
    "COZELOOP_JWT_OAUTH_PRIVATE_KEY": bool(private_key),
  }
  if not all(env.values()):
    return {
      "ok": False,
      "stage": "env",
      "env": env,
      "privateKey": private_key_meta,
      "message": "缺少 CozeLoop 必需配置。",
    }

  client = None
  try:
    client = cozeloop.new_client(
      api_base_url=api_base_url,
      workspace_id=workspace_id,
      jwt_oauth_client_id=client_id,
      jwt_oauth_private_key=private_key,
      jwt_oauth_public_key_id=public_key_id,
      timeout=8,
    )

    try:
      _ = client.get_prompt(prompt_key)
      return {
        "ok": True,
        "stage": "probe",
        "apiBaseUrl": api_base_url,
        "workspaceId": workspace_id,
        "privateKey": private_key_meta,
        "probe": {
          "endpoint": "/v1/loop/prompts/mget",
          "promptKey": prompt_key,
          "result": "found_or_empty",
        },
      }
    except Exception as error:
      msg = _short_msg(error)
      is_expected_not_found = ("does not exist" in msg.lower()) or ("error_code=4200" in msg)
      return {
        "ok": is_expected_not_found,
        "stage": "probe",
        "apiBaseUrl": api_base_url,
        "workspaceId": workspace_id,
        "privateKey": private_key_meta,
        "probe": {
          "endpoint": "/v1/loop/prompts/mget",
          "promptKey": prompt_key,
          "result": "not_found_but_connected" if is_expected_not_found else "request_failed",
        },
        "errorType": error.__class__.__name__,
        "message": msg,
      }
  except Exception as error:
    return {
      "ok": False,
      "stage": "auth_or_client_init",
      "errorType": error.__class__.__name__,
      "message": _short_msg(error),
      "privateKey": private_key_meta,
    }
  finally:
    if client is not None:
      try:
        client.close()
      except Exception:
        pass


def main() -> int:
  parser = argparse.ArgumentParser(description="Probe CozeLoop JWT auth and API connectivity.")
  parser.add_argument(
    "--prompt-key",
    default="baby_probe_non_existing_prompt_key",
    help="Prompt key used for connectivity probe. default: baby_probe_non_existing_prompt_key",
  )
  args = parser.parse_args()

  out = run_probe(args.prompt_key)
  print(json.dumps(out, ensure_ascii=False, indent=2))
  return 0 if out.get("ok") else 1


if __name__ == "__main__":
  sys.exit(main())
