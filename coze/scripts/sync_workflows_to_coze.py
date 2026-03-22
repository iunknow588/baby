#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import sys
from typing import Any, Dict, List, Tuple


def _read_json(path: pathlib.Path) -> Dict[str, Any]:
  return json.loads(path.read_text(encoding="utf-8"))


def _read_private_key(raw_value: str, project_root: pathlib.Path) -> Tuple[str, Dict[str, Any]]:
  value = (raw_value or "").strip()
  if not value:
    return "", {"ok": False, "mode": "missing", "reason": "empty"}
  if "PRIVATE KEY" in value and "-----BEGIN" in value:
    return value, {"ok": True, "mode": "inline_pem"}

  normalized = value.strip("\"'")
  p = pathlib.Path(normalized)
  candidates = [p] if p.is_absolute() else [(pathlib.Path.cwd() / p).resolve(), (project_root / p).resolve()]
  for file_path in candidates:
    if not file_path.exists() or not file_path.is_file():
      continue
    content = file_path.read_text(encoding="utf-8").strip()
    if "PRIVATE KEY" in content and "-----BEGIN" in content:
      return content, {"ok": True, "mode": "file_path", "resolvedPath": str(file_path)}
    return "", {"ok": False, "mode": "file_path", "reason": "file_exists_but_not_pem", "resolvedPath": str(file_path)}

  return "", {"ok": False, "mode": "file_path", "reason": "file_not_found"}


def _short_msg(error: BaseException) -> str:
  msg = str(error).strip()
  return msg[:300] if msg else error.__class__.__name__


def _can_use_cozeloop() -> Tuple[bool, str]:
  try:
    import cozeloop  # noqa: F401
    return True, ""
  except Exception as error:
    return False, _short_msg(error)


def _build_client(project_root: pathlib.Path):
  import cozeloop  # type: ignore

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
    return None, {
      "ok": False,
      "stage": "env",
      "env": env,
      "privateKey": private_key_meta,
      "message": "缺少 CozeLoop 必需配置。",
    }

  try:
    cozeloop.set_log_level("CRITICAL")
  except Exception:
    pass

  client = cozeloop.new_client(
    api_base_url=api_base_url,
    workspace_id=workspace_id,
    jwt_oauth_client_id=client_id,
    jwt_oauth_private_key=private_key,
    jwt_oauth_public_key_id=public_key_id,
    timeout=8,
  )
  meta = {
    "ok": True,
    "apiBaseUrl": api_base_url,
    "workspaceId": workspace_id,
    "privateKey": private_key_meta,
  }
  return client, meta


def _index_workflows(registry: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
  workflows = registry.get("workflows", [])
  out: Dict[str, Dict[str, Any]] = {}
  for wf in workflows:
    wf_id = str(wf.get("id", "")).strip()
    if wf_id:
      out[wf_id] = wf
  return out


def _check_prompt_exists(client, prompt_key: str) -> Tuple[bool, str, str]:
  try:
    _ = client.get_prompt(prompt_key)
    return True, "exists_or_accessible", ""
  except Exception as error:
    msg = _short_msg(error)
    lowered = msg.lower()
    if "does not exist" in lowered or "error_code=4200" in lowered:
      return False, "not_found", msg
    return False, "error", msg


def run_sync_check(strict_required: bool) -> Dict[str, Any]:
  project_root = pathlib.Path(__file__).resolve().parents[2]
  registry_path = project_root / "coze" / "registry" / "workflows.json"
  bindings_path = project_root / "coze" / "registry" / "coze_bindings.json"
  registry = _read_json(registry_path)
  bindings = _read_json(bindings_path)
  workflow_index = _index_workflows(registry)

  sdk_ok, sdk_error = _can_use_cozeloop()
  if not sdk_ok:
    return {
      "ok": False,
      "stage": "sdk",
      "message": "cozeloop SDK 不可用，请先安装。",
      "error": sdk_error,
      "hint": "python3 -m pip install --user cozeloop",
    }

  client, client_meta = _build_client(project_root)
  if client is None:
    return {**client_meta, "ok": False}

  results: List[Dict[str, Any]] = []
  missing_required = 0
  missing_optional = 0
  invalid_binding = 0

  try:
    for item in bindings.get("bindings", []):
      workflow_id = str(item.get("workflowId", "")).strip()
      resource_type = str(item.get("resourceType", "")).strip()
      resource_key = str(item.get("resourceKey", "")).strip()
      required = bool(item.get("required", False))
      workflow = workflow_index.get(workflow_id)
      if workflow is None:
        invalid_binding += 1
        results.append(
          {
            "workflowId": workflow_id,
            "resourceType": resource_type,
            "resourceKey": resource_key,
            "required": required,
            "ok": False,
            "status": "invalid_workflow_id",
            "message": "绑定中的 workflowId 在 workflows.json 中不存在。",
          }
        )
        continue

      if resource_type != "prompt":
        invalid_binding += 1
        results.append(
          {
            "workflowId": workflow_id,
            "route": workflow.get("route", ""),
            "resourceType": resource_type,
            "resourceKey": resource_key,
            "required": required,
            "ok": False,
            "status": "unsupported_resource_type",
            "message": "当前仅支持 prompt 资源检查。",
          }
        )
        continue

      ok, status, message = _check_prompt_exists(client, resource_key)
      if not ok:
        if required:
          missing_required += 1
        else:
          missing_optional += 1

      results.append(
        {
          "workflowId": workflow_id,
          "route": workflow.get("route", ""),
          "provider": workflow.get("provider", ""),
          "resourceType": resource_type,
          "resourceKey": resource_key,
          "required": required,
          "ok": ok,
          "status": status,
          "message": message,
        }
      )
  finally:
    try:
      client.close()
    except Exception:
      pass

  ok = invalid_binding == 0 and missing_required == 0 and (not strict_required or missing_optional == 0)
  return {
    "ok": ok,
    "stage": "sync-check",
    "capability": {
      "autoCreateWorkflow": False,
      "reason": "当前公开 SDK 仅覆盖 Prompt/Trace 接口，未提供工作流创建发布 API。"
    },
    "client": client_meta,
    "summary": {
      "totalBindings": len(results),
      "invalidBinding": invalid_binding,
      "missingRequired": missing_required,
      "missingOptional": missing_optional,
      "strictRequired": strict_required,
    },
    "results": results,
    "suggestions": [
      "将 required=true 的资源先在 Coze 平台创建并记录 resourceKey。",
      "若需工作流自动创建，请补充官方可用 OpenAPI 后再接入 apply 模式。",
    ],
  }


def main() -> int:
  parser = argparse.ArgumentParser(description="Check local workflow bindings against CozeLoop resources.")
  parser.add_argument(
    "--strict-required",
    choices=["true", "false"],
    default="false",
    help="true: optional missing 也失败；false: 仅 required missing 失败。",
  )
  args = parser.parse_args()

  strict = args.strict_required == "true"
  out = run_sync_check(strict)
  print(json.dumps(out, ensure_ascii=False, indent=2))
  return 0 if out.get("ok") else 1


if __name__ == "__main__":
  sys.exit(main())
