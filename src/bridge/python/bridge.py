#!/usr/bin/env python3
"""
BoxLite VS Code Extension Python Sidecar Bridge
Interacts with the BoxLite Cloud via Python SDK `boxlite==0.11.0` or
fallback REST client when the native wheel is not installed (e.g. Windows).
Communicates with the VS Code extension host over standard I/O using JSON-lines.
"""

import asyncio
import json
import os
import secrets as py_secrets
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

# Ensure standard output and input are UTF-8 encoded and unbuffered
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True, encoding="utf-8")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")


def log_debug(msg: str):
    sys.stderr.write(f"[boxlite-bridge] {msg}\n")
    sys.stderr.flush()


def send_response(req_id: str, success: bool, data: Any = None, error: Optional[Dict[str, Any]] = None):
    payload = {
        "id": req_id,
        "success": success,
        "data": data,
        "error": error
    }
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def extract_box_status(info: Any) -> str:
    if not info:
        return "unknown"
    if isinstance(info, dict):
        state_val = info.get("state")
        raw = info.get("status") or (state_val.get("status") if isinstance(state_val, dict) else state_val)
    else:
        state_attr = getattr(info, "state", None)
        raw = getattr(state_attr, "status", None) if state_attr is not None else getattr(info, "status", None)

    raw_str = str(getattr(raw, "value", getattr(raw, "name", raw))).lower() if raw else "unknown"
    if "." in raw_str:
        raw_str = raw_str.split(".")[-1]
    return raw_str.strip() or "unknown"


class TunnelResultFallback:
    def __init__(self, data: Dict[str, Any]):
        self._uri = data.get("uri") or data.get("url")
        self._is_public = data.get("is_public", data.get("isPublic", True))
        self._token = data.get("token")

    def uri(self) -> Optional[str]:
        return self._uri

    def is_public(self) -> bool:
        return self._is_public

    def token(self) -> Optional[str]:
        return self._token


class ExecResultFallback:
    def __init__(self, exit_code: int = 0, stdout: str = "", stderr: str = ""):
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr


class RestNetworkHandleFallback:
    def __init__(self, runtime: "RestRuntimeFallback", box_id: str):
        self.rt = runtime
        self.box_id = box_id

    async def revoke_tunnel(self, port: int):
        return await self.rt.revoke_tunnel(self.box_id, port)

    async def update_inbound(self, spec: Any):
        mode = getattr(spec, "mode", spec if isinstance(spec, str) else "enabled")
        return await self.rt.update_inbound(self.box_id, mode)

    async def update_outbound(self, spec: Any):
        mode = getattr(spec, "mode", "enabled")
        allow_net = getattr(spec, "allow_net", [])
        return await self.rt.update_outbound(self.box_id, mode, allow_net)


class RestBoxFallback:
    def __init__(self, runtime: "RestRuntimeFallback", box_id: str, name: str):
        self.rt = runtime
        self.id = box_id
        self.name = name
        self.network = RestNetworkHandleFallback(runtime, box_id)

    async def start(self):
        return await self.rt.start(self.id)

    async def stop(self):
        return await self.rt.stop(self.id)

    async def inspect(self):
        return await self.rt.inspect(self.id)

    async def exec(self, *cmd):
        if len(cmd) == 2 and isinstance(cmd[1], (list, tuple)):
            cmd_list = [cmd[0]] + list(cmd[1])
        else:
            cmd_list = list(cmd)
        return await self.rt.exec(self.id, cmd_list)

    async def copy_in(self, source: str, destination: str):
        return await self.rt.copy_in(self.id, source, destination)

    async def tunnel(self, target: Any, options: Any = None):
        port = target[1] if isinstance(target, (tuple, list)) else int(target)
        is_public = getattr(options, "is_public", True) if options is not None else True
        res = await self.rt.tunnel(self.id, port, is_public)
        return TunnelResultFallback(res)


class RestRuntimeFallback:
    """Pure-Python REST client for BoxLite Cloud when native boxlite package is not installed."""

    def __init__(self, rest_url: str, api_key: str):
        self.rest_url = rest_url.rstrip("/")
        self.api_key = api_key

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        url = f"{self.rest_url}/v1{path}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "rc-boxlite-vscode/0.1.0"
        }
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                content = resp.read().decode("utf-8")
                if content:
                    return json.loads(content)
                return {}
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            try:
                err_json = json.loads(err_body)
                msg = err_json.get("message") or err_json.get("error") or str(e)
            except Exception:
                msg = f"HTTP {e.code}: {err_body or e.reason}"
            raise RuntimeError(f"BoxLite Cloud API error ({e.code}): {msg}")
        except urllib.error.URLError as e:
            raise RuntimeError(f"NetworkError connecting to BoxLite Cloud ({self.rest_url}): {e.reason}")

    async def list(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, self._request, "GET", "/boxes")
        if isinstance(res, dict) and "boxes" in res:
            return res["boxes"]
        if isinstance(res, list):
            return res
        return []

    async def list_info(self) -> List[Dict[str, Any]]:
        return await self.list()

    async def inspect(self, box_id: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._request, "GET", f"/boxes/{box_id}")

    async def create(self, **kwargs) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._request, "POST", "/boxes", kwargs)

    async def start(self, box_id: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._request, "POST", f"/boxes/{box_id}/start")

    async def stop(self, box_id: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._request, "POST", f"/boxes/{box_id}/stop")

    async def remove(self, box_id: str, force: bool = False) -> None:
        loop = asyncio.get_running_loop()
        path = f"/boxes/{box_id}?force=true" if force else f"/boxes/{box_id}"
        await loop.run_in_executor(None, self._request, "DELETE", path)

    async def exec(self, box_id: str, cmd: List[str]) -> ExecResultFallback:
        loop = asyncio.get_running_loop()
        command = cmd[0] if cmd else "sh"
        args = list(cmd[1:]) if len(cmd) > 1 else []
        body = {"command": command, "args": args}
        res = await loop.run_in_executor(None, self._request, "POST", f"/boxes/{box_id}/exec", body)
        if not isinstance(res, dict):
            return ExecResultFallback(exit_code=0, stdout=str(res) if res is not None else "", stderr="")
        stdout = res.get("stdout") or res.get("stdOut") or res.get("output") or ""
        stderr = res.get("stderr") or res.get("stdErr") or ""
        if isinstance(res.get("result"), dict):
            stdout = stdout or res["result"].get("stdout") or res["result"].get("output") or ""
            stderr = stderr or res["result"].get("stderr") or ""
        exit_code = res.get("exit_code", res.get("exitCode", res.get("result", {}).get("exit_code", 0) if isinstance(res.get("result"), dict) else 0))
        return ExecResultFallback(
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr
        )

    async def copy_in(self, box_id: str, source: str, destination: str) -> bool:
        loop = asyncio.get_running_loop()
        try:
            body = {"source": source, "destination": destination}
            await loop.run_in_executor(None, self._request, "POST", f"/boxes/{box_id}/copy-in", body)
            return True
        except Exception as e:
            raise RuntimeError(
                f"File copy_in failed in REST fallback: {e}. "
                "Local-to-cloud file uploads require the official 'boxlite' native SDK wheel (boxlite==0.11.0). "
                "Please configure a supported Python environment (Linux/macOS or WSL) to deploy local directories."
            )

    async def tunnel(self, box_id: str, port: int, is_public: bool) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        path = f"/boxes/{box_id}/network/tunnel?port={port}"
        # OpenAPI schema requires camelCase 'isPublic' and additionalProperties: false
        body = {"isPublic": is_public} if not is_public else None
        res = await loop.run_in_executor(None, self._request, "POST", path, body)
        return res

    async def revoke_tunnel(self, box_id: str, port: int) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        path = f"/boxes/{box_id}/network/tunnel?port={port}"
        await loop.run_in_executor(None, self._request, "DELETE", path)
        return {"revoked": True}

    async def update_inbound(self, box_id: str, mode: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        body = {"mode": mode, "allow_net": []}
        await loop.run_in_executor(None, self._request, "PUT", f"/boxes/{box_id}/network/inbound", body)
        return {"mode": mode}

    async def update_outbound(self, box_id: str, mode: str, allow_net: List[str]) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        body = {"mode": mode, "allow_net": allow_net}
        await loop.run_in_executor(None, self._request, "PUT", f"/boxes/{box_id}/network/outbound", body)
        return {"mode": mode, "allow_net": allow_net}

    async def list_volumes(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, self._request, "GET", "/volumes")
        if isinstance(res, dict) and "volumes" in res:
            return res["volumes"]
        if isinstance(res, list):
            return res
        return []

    async def get_volume(self, volume_id: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._request, "GET", f"/volumes/{volume_id}")

    async def create_volume(self, name: Optional[str] = None) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        body = {"name": name} if name else {}
        return await loop.run_in_executor(None, self._request, "POST", "/volumes", body)

    async def remove_volume(self, volume_id: str, force: bool = False) -> None:
        loop = asyncio.get_running_loop()
        path = f"/volumes/{volume_id}?force=true" if force else f"/volumes/{volume_id}"
        await loop.run_in_executor(None, self._request, "DELETE", path)

    async def list_images(self) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        try:
            res = await loop.run_in_executor(None, self._request, "GET", "/images")
            if isinstance(res, dict):
                raw_images = res.get("images")
                if not isinstance(raw_images, list):
                    raw_images = (
                        res.get("items")
                        if isinstance(res.get("items"), list)
                        else (res.get("data") if isinstance(res.get("data"), list) else [])
                    )
                images = raw_images
            elif isinstance(res, list):
                images = res
            else:
                images = []
            usage = None
            try:
                usage_res = await loop.run_in_executor(None, self._request, "GET", "/images/usage")
                if isinstance(usage_res, dict):
                    usage = usage_res
            except Exception:
                pass
            return {"images": images, "usage": usage}
        except Exception as e:
            log_debug(f"RestRuntimeFallback.list_images failed: {e}")
            return {"images": [], "usage": None}

    async def get_image(self, name: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._request, "GET", f"/images/{name}")

    async def remove_image(self, name: str) -> None:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._request, "DELETE", f"/images/{name}")

    async def create_image_alias(self, name: str, alias: str, digest: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        body = {"alias": alias, "digest": digest}
        return await loop.run_in_executor(None, self._request, "POST", f"/images/{name}/aliases", body)

    async def delete_image_alias(self, name: str, alias: str) -> None:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._request, "DELETE", f"/images/{name}/aliases/{alias}")

    async def create_registry_login(self, registry_host: str, username: str, password: str, repository_prefix: Optional[str] = None) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        body = {
            "registry_host": registry_host,
            "username": username,
            "password": password
        }
        if repository_prefix:
            body["repository_prefix"] = repository_prefix
        return await loop.run_in_executor(None, self._request, "POST", "/images/registries", body)

    async def list_checkpoints(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_running_loop()
        checkpoints: List[Dict[str, Any]] = []
        page_token: Optional[str] = None
        while True:
            path = "/checkpoints"
            if page_token:
                path = f"/checkpoints?pageToken={urllib.parse.quote(page_token, safe='')}"
            res = await loop.run_in_executor(None, self._request, "GET", path)
            if isinstance(res, dict):
                page_items = res.get("checkpoints")
                if isinstance(page_items, list):
                    checkpoints.extend(page_items)
                next_token = res.get("next_page_token") or res.get("nextPageToken")
                if not next_token:
                    break
                page_token = next_token
            elif isinstance(res, list):
                checkpoints.extend(res)
                break
            else:
                break
        return checkpoints

    async def get_checkpoint(self, key: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        encoded_key = urllib.parse.quote(key, safe="")
        return await loop.run_in_executor(None, self._request, "GET", f"/checkpoints/{encoded_key}")

    async def create_checkpoint(self, source_box_id: str, name: Optional[str] = None) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        body: Dict[str, Any] = {"source_box_id": source_box_id}
        if name:
            body["name"] = name
        return await loop.run_in_executor(None, self._request, "POST", "/checkpoints", body)

    async def remove_checkpoint(self, key: str, force: bool = False) -> None:
        loop = asyncio.get_running_loop()
        encoded_key = urllib.parse.quote(key, safe="")
        path = f"/checkpoints/{encoded_key}?force=true" if force else f"/checkpoints/{encoded_key}"
        await loop.run_in_executor(None, self._request, "DELETE", path)


class BoxLiteBridge:
    def __init__(self):
        self.rt = None
        self.boxes: Dict[str, Any] = {}
        self.box_secrets: Dict[str, List[Dict[str, Any]]] = {}

    def _redact_secrets(self, raw_secrets: Any) -> List[Dict[str, Any]]:
        if not raw_secrets or not isinstance(raw_secrets, list):
            return []
        redacted: List[Dict[str, Any]] = []
        for s in raw_secrets:
            if isinstance(s, dict):
                s_name = s.get("name") or ""
                s_hosts = list(s.get("hosts") or [])
                s_headers = dict(s.get("headers") or {"Authorization": "Bearer {value}"})
            else:
                s_name = getattr(s, "name", "") or ""
                s_hosts = list(getattr(s, "hosts", []) or [])
                s_headers = dict(getattr(s, "headers", None) or {"Authorization": "Bearer {value}"})
            if s_name:
                redacted.append({
                    "name": s_name,
                    "hosts": s_hosts,
                    "headers": s_headers
                })
        return redacted

    def _format_secrets_payload(self, raw_secrets: Any) -> List[Dict[str, Any]]:
        if not raw_secrets or not isinstance(raw_secrets, list):
            return []
        formatted: List[Dict[str, Any]] = []
        for s in raw_secrets:
            if not isinstance(s, dict):
                continue
            name = (s.get("name") or "").strip()
            value = s.get("value") or ""
            hosts = [str(h).strip() for h in (s.get("hosts") or []) if str(h).strip()]
            headers = dict(s.get("headers") or {"Authorization": "Bearer {value}"})
            if name and value:
                formatted.append({
                    "name": name,
                    "value": value,
                    "hosts": hosts,
                    "headers": headers
                })
        return formatted

    def ensure_runtime(self):
        if self.rt is not None:
            return self.rt

        api_key = os.environ.get("BOXLITE_API_KEY")
        rest_url = os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai")
        if not api_key:
            raise ValueError("BOXLITE_API_KEY environment variable is not set. Use 'BoxLite: Sign In / Set API Key' to configure.")

        try:
            import boxlite
            # Use official Boxlite.rest with environment options
            self.rt = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions.from_env())
            log_debug("Initialized official boxlite SDK runtime.")
            return self.rt
        except (ImportError, Exception) as e:
            log_debug(f"Official boxlite SDK not available ({e}); using built-in REST client for {rest_url}.")
            self.rt = RestRuntimeFallback(rest_url, api_key)
            return self.rt

    def get_or_attach_box(self, box_id: str, name: Optional[str] = None):
        if box_id in self.boxes:
            return self.boxes[box_id]

        rt = self.ensure_runtime()
        box_name = name or f"box-{box_id[:8]}"

        try:
            import boxlite
            if not isinstance(rt, RestRuntimeFallback):
                box = boxlite.SimpleBox(runtime=rt, id=box_id, name=box_name)
                self.boxes[box_id] = box
                return box
        except ImportError:
            pass

        box = RestBoxFallback(rt, box_id, box_name)
        self.boxes[box_id] = box
        return box

    async def handle_ping(self, args: Dict[str, Any]) -> Dict[str, Any]:
        return {"pong": True}

    async def handle_check_credentials(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        boxes = await (rt.list_info() if hasattr(rt, "list_info") else rt.list())
        items = []
        for b in boxes:
            if isinstance(b, dict):
                b_id = b.get("id") or b.get("box_id") or ""
                b_name = b.get("name") or ""
            else:
                b_id = getattr(b, "id", None) or getattr(b, "box_id", None) or str(b)
                b_name = getattr(b, "name", "") or ""
            items.append({"id": b_id, "name": b_name})
        return {"valid": True, "boxCount": len(items)}

    async def handle_list_boxes(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        boxes = await (rt.list_info() if hasattr(rt, "list_info") else rt.list())
        result = []
        for b in boxes:
            if isinstance(b, dict):
                b_id = b.get("id") or b.get("box_id") or ""
                b_name = b.get("name") or ""
                b_image = b.get("image") or "python"
                b_tunnels = b.get("tunnels")
            else:
                b_id = getattr(b, "id", None) or getattr(b, "box_id", None) or str(b)
                b_name = getattr(b, "name", "") or ""
                b_image = getattr(b, "image", None) or "python"
                b_tunnels = getattr(b, "tunnels", None)

            b_volumes = b.get("volumes") if isinstance(b, dict) else getattr(b, "volumes", None)
            b_secrets_raw = b.get("secrets") if isinstance(b, dict) else getattr(b, "secrets", None)
            b_secrets = self._redact_secrets(b_secrets_raw) or self.box_secrets.get(b_id, [])

            b_status = extract_box_status(b)

            box_info = {
                "id": b_id,
                "name": b_name,
                "status": b_status,
                "image": b_image,
            }
            if b_tunnels is not None:
                box_info["tunnels"] = b_tunnels
            if b_volumes:
                box_info["volumes"] = b_volumes
            if b_secrets:
                box_info["secrets"] = b_secrets
            result.append(box_info)
        return {"boxes": result}

    async def handle_inspect_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        box_id = args["boxId"]
        box = self.get_or_attach_box(box_id)
        if hasattr(box, "inspect"):
            info = await box.inspect()
        else:
            info = await rt.inspect(box_id)

        if hasattr(info, "to_dict"):
            data = info.to_dict()
        elif hasattr(info, "__dict__"):
            data = {k: v for k, v in info.__dict__.items() if not k.startswith("_")}
        elif isinstance(info, dict):
            data = dict(info)
        else:
            data = {"id": box_id, "raw": str(info)}

        if isinstance(data, dict):
            if "secrets" in data and data["secrets"]:
                data["secrets"] = self._redact_secrets(data["secrets"])
            elif box_id in self.box_secrets and self.box_secrets[box_id]:
                data["secrets"] = self.box_secrets[box_id]
        return {"box": data}

    async def handle_create_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args.get("name")
        checkpoint = args.get("checkpoint") or args.get("checkpointId") or args.get("checkpoint_id")
        if checkpoint:
            # Restored boxes inherit all saved execution/resource/lifecycle/network settings.
            # BoxLite Cloud rejects any creation option other than checkpoint_id and optional name.
            if isinstance(rt, RestRuntimeFallback):
                rest_kwargs: Dict[str, Any] = {"checkpoint_id": checkpoint}
                if name:
                    rest_kwargs["name"] = name
                res = await rt.create(**rest_kwargs)
                box_id = res.get("box_id") or res.get("id") or name or checkpoint
                await rt.start(box_id)
                box = RestBoxFallback(rt, box_id, name or box_id)
                self.boxes[box_id] = box
                return {"boxId": box_id, "name": name or box_id, "status": "running"}

            try:
                import boxlite
                create_kwargs: Dict[str, Any] = {}
                if name:
                    create_kwargs["name"] = name
                box = await rt.create(boxlite.BoxOptions(checkpoint=checkpoint), **create_kwargs)
                await box.start()
                box_id = box.id
                self.boxes[box_id] = box
                return {
                    "boxId": box_id,
                    "name": name or getattr(box, "name", None) or box_id,
                    "status": "running"
                }
            except TypeError as e:
                log_debug(f"BoxOptions(checkpoint=...) not supported in installed wheel ({e}); falling back to REST")
                fallback = RestRuntimeFallback(
                    os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
                    os.environ.get("BOXLITE_API_KEY", "")
                )
                rest_kwargs = {"checkpoint_id": checkpoint}
                if name:
                    rest_kwargs["name"] = name
                res = await fallback.create(**rest_kwargs)
                box_id = res.get("box_id") or res.get("id") or name or checkpoint
                await fallback.start(box_id)
                box = RestBoxFallback(fallback, box_id, name or box_id)
                self.boxes[box_id] = box
                return {"boxId": box_id, "name": name or box_id, "status": "running"}

        image = args.get("image", "python")
        auto_remove = args.get("autoRemove", False)
        auto_stop = args.get("autoStop", args.get("auto_stop", 0))
        auto_delete = args.get("autoDelete", args.get("auto_delete", 0))
        auto_resume = args.get("autoResume", args.get("auto_resume", True))
        cpus = args.get("cpus", args.get("cpu"))
        memory_mib = args.get("memoryMib", args.get("memory_mib"))
        disk_size_gb = args.get("diskSizeGb", args.get("disk_size_gb"))
        entrypoint = args.get("entrypoint")
        cmd = args.get("cmd")
        env = args.get("env")
        network_spec = args.get("network")
        volumes = args.get("volumes")
        secrets_payload = self._format_secrets_payload(args.get("secrets"))
        redacted_secrets = self._redact_secrets(secrets_payload)

        if isinstance(rt, RestRuntimeFallback):
            # BoxLite Cloud REST API conforms to OpenAPI CreateBoxRequest.
            # 'auto_remove' is deprecated/client-side and MUST NOT be sent across the wire.
            kwargs: Dict[str, Any] = {
                "image": image or "python",
            }
            if name:
                kwargs["name"] = name
            if auto_stop is not None:
                # Boxlite Cloud requires auto_stop to be 0 (disabled) or >= 60 seconds
                if 0 < auto_stop < 60:
                    auto_stop = 60
                kwargs["auto_stop"] = auto_stop
            if auto_delete is not None and auto_delete > 0:
                kwargs["auto_delete"] = auto_delete
            if auto_resume is not None:
                kwargs["auto_resume"] = auto_resume
            if cpus is not None:
                kwargs["cpus"] = cpus
            if memory_mib is not None:
                kwargs["memory_mib"] = memory_mib
            if disk_size_gb is not None:
                kwargs["disk_size_gb"] = disk_size_gb
            if env:
                kwargs["env"] = env
            if cmd:
                kwargs["cmd"] = cmd
            if entrypoint:
                kwargs["entrypoint"] = entrypoint
            if network_spec:
                kwargs["network"] = network_spec
            if volumes:
                kwargs["volumes"] = volumes
            if secrets_payload:
                kwargs["secrets"] = secrets_payload

            res = await rt.create(**kwargs)
            box_id = res.get("box_id") or res.get("id") or name
            await rt.start(box_id)
            box = RestBoxFallback(rt, box_id, name or box_id)
            self.boxes[box_id] = box
            if redacted_secrets:
                self.box_secrets[box_id] = redacted_secrets
            return {"boxId": box_id, "name": name or box_id, "status": "running"}

        import boxlite
        outbound_spec = None
        inbound_spec = None

        if network_spec:
            outbound_cfg = network_spec.get("outbound", {})
            out_mode = outbound_cfg.get("mode", "enabled")
            allow_net = outbound_cfg.get("allow_net", [])
            outbound_spec = boxlite.OutboundNetworkSpec(mode=out_mode, allow_net=allow_net)

            inbound_cfg = network_spec.get("inbound", {})
            in_mode = inbound_cfg.get("mode", "enabled")
            inbound_spec = boxlite.InboundNetworkSpec(mode=in_mode)

        net = None
        if outbound_spec or inbound_spec:
            net = boxlite.NetworkSpec(
                outbound=outbound_spec or boxlite.OutboundNetworkSpec(mode="enabled", allow_net=[]),
                inbound=inbound_spec or boxlite.InboundNetworkSpec(mode="enabled")
            )

        sdk_secrets = None
        if secrets_payload:
            sdk_secrets = [
                boxlite.Secret(
                    name=s["name"],
                    value=s["value"],
                    hosts=s["hosts"],
                    headers=s["headers"]
                )
                for s in secrets_payload
            ]

        kwargs = {
            "runtime": rt,
            "image": image,
            "auto_remove": auto_remove,
        }
        if name:
            kwargs["name"] = name
        if auto_stop is not None:
            kwargs["auto_stop"] = auto_stop
        if auto_delete is not None and auto_delete > 0:
            kwargs["auto_delete"] = auto_delete
        if auto_resume is not None:
            kwargs["auto_resume"] = auto_resume
        if cpus is not None:
            kwargs["cpus"] = cpus
        if memory_mib is not None:
            kwargs["memory_mib"] = memory_mib
        if disk_size_gb is not None:
            kwargs["disk_size_gb"] = disk_size_gb
        if env:
            kwargs["env"] = list(env.items()) if isinstance(env, dict) else env
        if cmd:
            kwargs["cmd"] = cmd
        if entrypoint:
            kwargs["entrypoint"] = entrypoint
        if net:
            kwargs["network"] = net
        if volumes:
            kwargs["volumes"] = [
                {
                    "managed_volume": v.get("managed_volume") or v.get("managedVolume"),
                    "guest_path": v.get("guest_path") or v.get("guestPath"),
                    "read_only": v.get("read_only", v.get("readOnly", False))
                }
                for v in volumes
            ]
        if sdk_secrets:
            kwargs["secrets"] = sdk_secrets

        try:
            box = boxlite.SimpleBox(**kwargs)
            await box.start()
            box_id = box.id
            self.boxes[box_id] = box
        except TypeError as e:
            if sdk_secrets:
                # Never silently drop secrets; try rt.create(BoxOptions(...)) or REST fallback
                log_debug(f"SimpleBox with secrets failed ({e}); trying BoxOptions / REST fallback.")
                try:
                    box_opts_kwargs: Dict[str, Any] = {
                        "image": image,
                        "secrets": sdk_secrets,
                    }
                    if auto_stop is not None:
                        box_opts_kwargs["auto_stop"] = auto_stop
                    if auto_delete is not None and auto_delete > 0:
                        box_opts_kwargs["auto_delete"] = auto_delete
                    if auto_resume is not None:
                        box_opts_kwargs["auto_resume"] = auto_resume
                    if cpus is not None:
                        box_opts_kwargs["cpus"] = cpus
                    if memory_mib is not None:
                        box_opts_kwargs["memory_mib"] = memory_mib
                    if disk_size_gb is not None:
                        box_opts_kwargs["disk_size_gb"] = disk_size_gb
                    if env:
                        box_opts_kwargs["env"] = list(env.items()) if isinstance(env, dict) else env
                    if cmd:
                        box_opts_kwargs["cmd"] = cmd
                    if entrypoint:
                        box_opts_kwargs["entrypoint"] = entrypoint
                    if net:
                        box_opts_kwargs["network"] = net
                    if volumes:
                        box_opts_kwargs["volumes"] = kwargs["volumes"]
                    create_kwargs = {"name": name} if name else {}
                    box = await rt.create(boxlite.BoxOptions(**box_opts_kwargs), **create_kwargs)
                    await box.start()
                    box_id = box.id
                    self.boxes[box_id] = box
                except Exception as inner_e:
                    log_debug(f"BoxOptions with secrets failed ({inner_e}); falling back to REST")
                    fallback = RestRuntimeFallback(
                        os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
                        os.environ.get("BOXLITE_API_KEY", "")
                    )
                    rest_kwargs: Dict[str, Any] = {
                        "image": image or "python",
                        "secrets": secrets_payload
                    }
                    if name:
                        rest_kwargs["name"] = name
                    if auto_stop is not None:
                        rest_kwargs["auto_stop"] = 60 if 0 < auto_stop < 60 else auto_stop
                    if auto_delete is not None and auto_delete > 0:
                        rest_kwargs["auto_delete"] = auto_delete
                    if auto_resume is not None:
                        rest_kwargs["auto_resume"] = auto_resume
                    if cpus is not None:
                        rest_kwargs["cpus"] = cpus
                    if memory_mib is not None:
                        rest_kwargs["memory_mib"] = memory_mib
                    if disk_size_gb is not None:
                        rest_kwargs["disk_size_gb"] = disk_size_gb
                    if env:
                        rest_kwargs["env"] = env
                    if cmd:
                        rest_kwargs["cmd"] = cmd
                    if entrypoint:
                        rest_kwargs["entrypoint"] = entrypoint
                    if network_spec:
                        rest_kwargs["network"] = network_spec
                    if volumes:
                        rest_kwargs["volumes"] = volumes
                    res = await fallback.create(**rest_kwargs)
                    box_id = res.get("box_id") or res.get("id") or name
                    await fallback.start(box_id)
                    box = RestBoxFallback(fallback, box_id, name or box_id)
                    self.boxes[box_id] = box
            else:
                # Drop newer optional kwargs if the installed wheel rejects them
                log_debug(f"SimpleBox init with all options failed ({e}); falling back with core options.")
                for key in ["auto_resume", "auto_delete", "disk_size_gb", "memory_mib", "cpus", "env", "cmd", "volumes"]:
                    kwargs.pop(key, None)
                try:
                    box = boxlite.SimpleBox(**kwargs)
                except TypeError:
                    kwargs.pop("auto_stop", None)
                    box = boxlite.SimpleBox(**kwargs)
                await box.start()
                box_id = box.id
                self.boxes[box_id] = box

        if redacted_secrets:
            self.box_secrets[box_id] = redacted_secrets

        return {
            "boxId": box_id,
            "name": name or box_id,
            "status": "running"
        }

    async def handle_start_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        box = self.get_or_attach_box(box_id)
        await box.start()

        rt = self.ensure_runtime()
        for _ in range(16):
            try:
                info = await rt.inspect(box_id) if hasattr(rt, "inspect") else None
                st = extract_box_status(info)
                if st in ("running", "ready", "active"):
                    return {"boxId": box_id, "status": st}
            except Exception:
                pass
            await asyncio.sleep(0.5)

        return {"boxId": box_id, "status": "running"}

    async def handle_stop_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        box = self.get_or_attach_box(box_id)
        if hasattr(box, "stop"):
            await box.stop()
        else:
            rt = self.ensure_runtime()
            if hasattr(rt, "stop"):
                await rt.stop(box_id)

        rt = self.ensure_runtime()
        for _ in range(16):
            try:
                info = await rt.inspect(box_id) if hasattr(rt, "inspect") else None
                st = extract_box_status(info)
                if st in ("stopped", "terminated", "exited", "configured", "paused", "inactive", "shutdown"):
                    return {"boxId": box_id, "status": st}
            except Exception:
                pass
            await asyncio.sleep(0.5)

        return {"boxId": box_id, "status": "stopped"}

    async def handle_remove_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        rt = self.ensure_runtime()
        await rt.remove(box_id, force=True)
        if box_id in self.boxes:
            del self.boxes[box_id]
        return {"boxId": box_id, "removed": True}

    async def handle_exec(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        cmd = args["command"]
        cmd_args = args.get("args", [])
        box = self.get_or_attach_box(box_id)

        full_cmd = [cmd] + cmd_args if cmd_args else [cmd]
        res = await box.exec(*full_cmd)
        if hasattr(res, "wait") and callable(res.wait):
            res = await res.wait()

        exit_code = getattr(res, "exit_code", getattr(res, "exitCode", 0))
        stdout = getattr(res, "stdout", "")
        stderr = getattr(res, "stderr", "")

        if callable(stdout):
            stdout = stdout()
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")

        if callable(stderr):
            stderr = stderr()
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")

        return {
            "exitCode": exit_code,
            "stdout": stdout,
            "stderr": stderr
        }

    async def handle_copy_in(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        source = args["source"]
        destination = args["destination"]
        box = self.get_or_attach_box(box_id)

        await box.copy_in(source, destination)
        return {
            "boxId": box_id,
            "source": source,
            "destination": destination,
            "success": True
        }

    async def handle_tunnel(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        port = int(args.get("port", 8080))
        is_public = args.get("isPublic", True)

        box = self.get_or_attach_box(box_id)
        target = ("127.0.0.1", port)

        try:
            import boxlite
            if not isinstance(self.rt, RestRuntimeFallback):
                if is_public:
                    tunnel = await box.tunnel(target)
                else:
                    tunnel = await box.tunnel(target, boxlite.TunnelOptions(is_public=False))
                url = tunnel.uri() if hasattr(tunnel, "uri") else str(tunnel)
                token = tunnel.token() if hasattr(tunnel, "token") else None
                return {
                    "boxId": box_id,
                    "port": port,
                    "isPublic": is_public,
                    "url": url,
                    "token": token
                }
        except ImportError:
            pass

        tunnel = await box.tunnel(target, TunnelResultFallback({"is_public": is_public}))
        url = tunnel.uri() if hasattr(tunnel, "uri") else str(tunnel)
        token = tunnel.token() if hasattr(tunnel, "token") else None

        return {
            "boxId": box_id,
            "port": port,
            "isPublic": is_public,
            "url": url,
            "token": token
        }

    async def handle_revoke_tunnel(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        port = int(args.get("port", 8080))
        box = self.get_or_attach_box(box_id)
        await box.network.revoke_tunnel(port)
        return {"boxId": box_id, "port": port, "revoked": True}

    async def handle_update_inbound(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        mode = args.get("mode", "enabled")
        box = self.get_or_attach_box(box_id)

        try:
            import boxlite
            if not isinstance(self.rt, RestRuntimeFallback):
                await box.network.update_inbound(boxlite.InboundNetworkSpec(mode=mode))
                return {"boxId": box_id, "inbound": mode}
        except ImportError:
            pass

        await box.network.update_inbound(mode)
        return {"boxId": box_id, "inbound": mode}

    async def handle_update_outbound(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        mode = args.get("mode", "enabled")
        allow_net = args.get("allowNet", [])
        box = self.get_or_attach_box(box_id)

        try:
            import boxlite
            if not isinstance(self.rt, RestRuntimeFallback):
                if allow_net:
                    spec = boxlite.OutboundNetworkSpec(mode=mode, allow_net=allow_net)
                else:
                    spec = boxlite.OutboundNetworkSpec(mode=mode)
                await box.network.update_outbound(spec)
                return {"boxId": box_id, "outbound": mode, "allowNet": allow_net}
        except ImportError:
            pass

        class OutboundSpecStub:
            def __init__(self, m, an):
                self.mode = m
                self.allow_net = an

        await box.network.update_outbound(OutboundSpecStub(mode, allow_net))
        return {"boxId": box_id, "outbound": mode, "allowNet": allow_net}

    async def handle_tail_log(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        log_file = args.get("logFile", "/tmp/server.log")
        lines = int(args.get("lines", 100))
        rt = self.ensure_runtime()

        # Prevent waking up stopped boxes with tail execution
        try:
            info = await rt.inspect(box_id) if hasattr(rt, "inspect") else None
            status = extract_box_status(info)
            if status not in ("running", "ready", "active"):
                return {
                    "boxId": box_id,
                    "content": "",
                    "exitCode": 0,
                    "status": status,
                    "stopped": True
                }
        except Exception:
            return {
                "boxId": box_id,
                "content": "",
                "exitCode": 0,
                "status": "stopped",
                "stopped": True
            }

        box = self.get_or_attach_box(box_id)

        res = await box.exec("tail", f"-n{lines}", log_file)
        if hasattr(res, "wait") and callable(res.wait):
            res = await res.wait()

        stdout = getattr(res, "stdout", "")
        if callable(stdout):
            stdout = stdout()
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")

        exit_code = getattr(res, "exit_code", getattr(res, "exitCode", 0))
        return {
            "boxId": box_id,
            "content": stdout,
            "exitCode": exit_code
        }

    async def handle_list_volumes(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        volumes = []
        if hasattr(rt, "volumes") and callable(rt.volumes):
            try:
                handle = rt.volumes()
                volumes = await handle.list()
            except Exception as e:
                log_debug(f"rt.volumes().list() failed ({e}), falling back to REST")
                fallback = RestRuntimeFallback(
                    os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
                    os.environ.get("BOXLITE_API_KEY", "")
                )
                volumes = await fallback.list_volumes()
        elif hasattr(rt, "list_volumes"):
            volumes = await rt.list_volumes()

        result = []
        for v in volumes:
            if isinstance(v, dict):
                v_id = v.get("id") or v.get("volume_id") or ""
                v_name = v.get("name") or v_id
                v_state = v.get("state") or "ready"
                v_created = v.get("created_at") or v.get("createdAt")
                v_updated = v.get("updated_at") or v.get("updatedAt")
                v_size = v.get("size_bytes") or v.get("sizeBytes")
            else:
                v_id = getattr(v, "id", None) or getattr(v, "volume_id", "") or str(v)
                v_name = getattr(v, "name", "") or v_id
                v_state = getattr(v, "state", "ready")
                v_created = getattr(v, "created_at", None)
                if hasattr(v_created, "to_rfc3339"):
                    v_created = v_created.to_rfc3339()
                elif hasattr(v_created, "isoformat"):
                    v_created = v_created.isoformat()
                else:
                    v_created = str(v_created) if v_created else None
                v_updated = getattr(v, "updated_at", None)
                if hasattr(v_updated, "to_rfc3339"):
                    v_updated = v_updated.to_rfc3339()
                elif hasattr(v_updated, "isoformat"):
                    v_updated = v_updated.isoformat()
                else:
                    v_updated = str(v_updated) if v_updated else None
                v_size = getattr(v, "size_bytes", None)

            result.append({
                "id": v_id,
                "name": v_name,
                "state": str(v_state).lower() if v_state else "ready",
                "createdAt": v_created,
                "updatedAt": v_updated,
                "sizeBytes": v_size
            })
        return {"volumes": result}

    async def handle_create_volume(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args.get("name")
        if hasattr(rt, "volumes") and callable(rt.volumes):
            try:
                handle = rt.volumes()
                info = await handle.create(name=name)
                v_id = getattr(info, "id", None) or getattr(info, "volume_id", "")
                v_name = getattr(info, "name", "") or v_id
                v_state = getattr(info, "state", "ready")
                v_created = getattr(info, "created_at", None)
                if hasattr(v_created, "to_rfc3339"):
                    v_created = v_created.to_rfc3339()
                elif hasattr(v_created, "isoformat"):
                    v_created = v_created.isoformat()
                else:
                    v_created = str(v_created) if v_created else None
                return {
                    "id": v_id,
                    "name": v_name,
                    "state": str(v_state).lower() if v_state else "ready",
                    "createdAt": v_created
                }
            except Exception as e:
                log_debug(f"rt.volumes().create() failed ({e}), falling back to REST")

        fallback = RestRuntimeFallback(
            os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
            os.environ.get("BOXLITE_API_KEY", "")
        )
        res = await fallback.create_volume(name=name)
        v_id = res.get("id") or res.get("volume_id") or ""
        v_name = res.get("name") or v_id
        v_state = res.get("state") or "ready"
        v_created = res.get("created_at") or res.get("createdAt")
        return {
            "id": v_id,
            "name": v_name,
            "state": str(v_state).lower() if v_state else "ready",
            "createdAt": v_created
        }

    async def handle_inspect_volume(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        volume_id = args["volumeId"]
        if hasattr(rt, "volumes") and callable(rt.volumes):
            try:
                handle = rt.volumes()
                info = await handle.get(volume_id)
                if hasattr(info, "to_dict"):
                    data = info.to_dict()
                elif hasattr(info, "__dict__"):
                    data = {k: v for k, v in info.__dict__.items() if not k.startswith("_")}
                else:
                    data = {
                        "id": getattr(info, "id", volume_id),
                        "name": getattr(info, "name", volume_id),
                        "state": getattr(info, "state", "ready"),
                        "created_at": getattr(info, "created_at", None),
                        "size_bytes": getattr(info, "size_bytes", None)
                    }
                return {"volume": data}
            except Exception as e:
                log_debug(f"rt.volumes().get() failed ({e}), falling back to REST")

        fallback = RestRuntimeFallback(
            os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
            os.environ.get("BOXLITE_API_KEY", "")
        )
        res = await fallback.get_volume(volume_id)
        return {"volume": res}

    async def handle_remove_volume(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        volume_id = args["volumeId"]
        force = bool(args.get("force", False))
        if hasattr(rt, "volumes") and callable(rt.volumes):
            try:
                handle = rt.volumes()
                await handle.remove(volume_id, force=force)
                return {"volumeId": volume_id, "removed": True}
            except Exception as e:
                log_debug(f"rt.volumes().remove() failed ({e}), falling back to REST")

        fallback = RestRuntimeFallback(
            os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
            os.environ.get("BOXLITE_API_KEY", "")
        )
        await fallback.remove_volume(volume_id, force=force)
        return {"volumeId": volume_id, "removed": True}

    def _serialize_timestamp(self, val: Any) -> Optional[str]:
        if val is None:
            return None
        if isinstance(val, str):
            return val
        if hasattr(val, "to_rfc3339"):
            return val.to_rfc3339()
        if hasattr(val, "isoformat"):
            return val.isoformat()
        return str(val)

    def _format_image_item(self, img: Any) -> Optional[Dict[str, Any]]:
        if img is None:
            return None
        if isinstance(img, str):
            name = img.strip()
            return {"name": name} if name else None

        def get_field(key: str, default: Any = None) -> Any:
            if isinstance(img, dict):
                return img.get(key, default)
            return getattr(img, key, default)

        name = ""
        for field in ("name", "image_name", "imageName", "reference", "image"):
            val = get_field(field)
            if isinstance(val, str) and val.strip():
                name = val.strip()
                break

        raw_tag = get_field("tag")
        tag_str = raw_tag.strip() if isinstance(raw_tag, str) else ""

        if not name:
            raw_repo = get_field("repository")
            if isinstance(raw_repo, str) and raw_repo.strip():
                repo = raw_repo.strip()
                if tag_str and tag_str != "<none>" and ":" not in repo:
                    name = f"{repo}:{tag_str}"
                else:
                    name = repo

        if not name:
            raw_id = get_field("id")
            if isinstance(raw_id, str) and raw_id.strip():
                name = raw_id.strip()

        if not name:
            return None

        raw_tags = get_field("tags")
        if raw_tags is None:
            raw_tags = get_field("aliases")
        if isinstance(raw_tags, (list, tuple, set)):
            tags = [t if isinstance(t, str) else str(t) for t in raw_tags]
        elif tag_str and tag_str != "<none>":
            tags = [tag_str]
        else:
            tags = []

        box_count = get_field("boxCount")
        if box_count is None:
            box_count = get_field("box_count", 0)

        last_used_raw = (
            get_field("lastUsedAt")
            or get_field("last_used_at")
            or get_field("createdAt")
            or get_field("created_at")
        )
        last_used = self._serialize_timestamp(last_used_raw)

        size_bytes = get_field("sizeBytes")
        if size_bytes is None:
            size_bytes = get_field("size_bytes")

        formatted: Dict[str, Any] = dict(img) if isinstance(img, dict) else {}
        formatted.update({
            "name": name,
            "tags": tags,
            "boxCount": box_count if box_count is not None else 0,
            "lastUsedAt": last_used,
            "sizeBytes": size_bytes,
        })
        return formatted

    async def handle_list_images(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        images = []
        usage = None

        if hasattr(rt, "images"):
            img_mgr = getattr(rt, "images")
            if hasattr(img_mgr, "list") and callable(img_mgr.list):
                try:
                    images = await img_mgr.list()
                except Exception as e:
                    log_debug(f"rt.images.list() failed: {e}")
            if hasattr(img_mgr, "usage") and callable(img_mgr.usage):
                try:
                    u = await img_mgr.usage()
                    usage = {
                        "count": getattr(u, "count", 0),
                        "limit": getattr(u, "limit", 20),
                        "knownBytes": getattr(u, "known_bytes", getattr(u, "knownBytes", 0))
                    }
                except Exception as e:
                    log_debug(f"rt.images.usage() failed: {e}")

        if not images and not usage:
            fallback = RestRuntimeFallback(
                os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
                os.environ.get("BOXLITE_API_KEY", "")
            )
            fallback_res = await fallback.list_images()
            images = fallback_res.get("images", [])
            usage = fallback_res.get("usage")

        formatted_images = []
        for img in (images or []):
            item = self._format_image_item(img)
            if item is not None:
                formatted_images.append(item)

        if isinstance(usage, dict):
            known_bytes = usage.get("knownBytes")
            if known_bytes is None:
                known_bytes = usage.get("known_bytes", 0)
            usage = {
                "count": usage.get("count", len(formatted_images)),
                "limit": usage.get("limit", 20),
                "knownBytes": known_bytes if known_bytes is not None else 0,
            }

        return {
            "images": formatted_images,
            "usage": usage or {"count": len(formatted_images), "limit": 20, "knownBytes": 0}
        }

    async def handle_inspect_image(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args["name"]
        data = None

        if hasattr(rt, "images") and hasattr(getattr(rt, "images"), "get"):
            try:
                img_mgr = getattr(rt, "images")
                detail = await img_mgr.get(name)
                if hasattr(detail, "to_dict"):
                    data = detail.to_dict()
                elif hasattr(detail, "__dict__"):
                    data = {k: v for k, v in detail.__dict__.items() if not k.startswith("_")}
                else:
                    data = {
                        "name": getattr(detail, "name", name),
                        "versions": [
                            {
                                "digest": getattr(v, "digest", ""),
                                "lastUsedAt": getattr(v, "last_used_at", getattr(v, "lastUsedAt", None)),
                                "sizeBytes": getattr(v, "size_bytes", getattr(v, "sizeBytes", None))
                            }
                            for v in getattr(detail, "versions", [])
                        ],
                        "aliases": [
                            {
                                "alias": getattr(a, "alias", ""),
                                "digest": getattr(a, "digest", "")
                            }
                            for a in getattr(detail, "aliases", [])
                        ],
                        "history": [
                            {
                                "alias": getattr(h, "alias", ""),
                                "fromDigest": getattr(h, "from_digest", getattr(h, "fromDigest", None)),
                                "toDigest": getattr(h, "to_digest", getattr(h, "toDigest", "")),
                                "recordedAt": getattr(h, "recorded_at", getattr(h, "recordedAt", None))
                            }
                            for h in getattr(detail, "history", [])
                        ]
                    }
            except Exception as e:
                log_debug(f"rt.images.get() failed ({e}), falling back to REST")

        if data is None:
            fallback = RestRuntimeFallback(
                os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
                os.environ.get("BOXLITE_API_KEY", "")
            )
            try:
                data = await fallback.get_image(name)
            except Exception as e:
                data = {"name": name, "versions": [], "aliases": [], "history": []}

        return {"image": data}

    async def handle_remove_image(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args["name"]
        if hasattr(rt, "images"):
            img_mgr = getattr(rt, "images")
            if hasattr(img_mgr, "remove") and callable(img_mgr.remove):
                try:
                    await img_mgr.remove(name)
                    return {"name": name, "removed": True}
                except Exception as e:
                    log_debug(f"rt.images.remove() failed ({e}), falling back to REST")

        fallback = RestRuntimeFallback(
            os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
            os.environ.get("BOXLITE_API_KEY", "")
        )
        await fallback.remove_image(name)
        return {"name": name, "removed": True}

    async def handle_create_image_alias(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args["name"]
        alias = args["alias"]
        digest = args["digest"]
        if hasattr(rt, "images"):
            img_mgr = getattr(rt, "images")
            if hasattr(img_mgr, "create_alias") and callable(img_mgr.create_alias):
                try:
                    await img_mgr.create_alias(name=name, alias=alias, digest=digest)
                    return {"name": name, "alias": alias, "digest": digest}
                except Exception as e:
                    log_debug(f"rt.images.create_alias() failed ({e}), falling back to REST")

        fallback = RestRuntimeFallback(
            os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
            os.environ.get("BOXLITE_API_KEY", "")
        )
        res = await fallback.create_image_alias(name, alias, digest)
        return {"name": name, "alias": alias, "digest": digest}

    async def handle_delete_image_alias(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args["name"]
        alias = args["alias"]
        if hasattr(rt, "images"):
            img_mgr = getattr(rt, "images")
            if hasattr(img_mgr, "delete_alias") and callable(img_mgr.delete_alias):
                try:
                    await img_mgr.delete_alias(name=name, alias=alias)
                    return {"name": name, "alias": alias, "deleted": True}
                except Exception as e:
                    log_debug(f"rt.images.delete_alias() failed ({e}), falling back to REST")

        fallback = RestRuntimeFallback(
            os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
            os.environ.get("BOXLITE_API_KEY", "")
        )
        await fallback.delete_image_alias(name, alias)
        return {"name": name, "alias": alias, "deleted": True}

    async def handle_create_registry_login(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        registry_host = args["registryHost"]
        username = args["username"]
        password = args["password"]
        prefix = args.get("repositoryPrefix")
        log_debug(f"Registering registry login for {registry_host} (user: {username})")

        if hasattr(rt, "images") and hasattr(getattr(rt, "images"), "registries"):
            reg_mgr = getattr(getattr(rt, "images"), "registries")
            if hasattr(reg_mgr, "create") and callable(reg_mgr.create):
                try:
                    kwargs = {
                        "registry_host": registry_host,
                        "username": username,
                        "password": password
                    }
                    if prefix:
                        kwargs["repository_prefix"] = prefix
                    await reg_mgr.create(**kwargs)
                    return {"success": True, "registryHost": registry_host}
                except Exception as e:
                    log_debug(f"rt.images.registries.create() failed ({e}), falling back to REST")

        fallback = RestRuntimeFallback(
            os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
            os.environ.get("BOXLITE_API_KEY", "")
        )
        await fallback.create_registry_login(registry_host, username, password, prefix)
        return {"success": True, "registryHost": registry_host}

    def _format_checkpoint(self, c: Any) -> Dict[str, Any]:
        if isinstance(c, dict):
            c_id = c.get("id") or c.get("checkpoint_id") or ""
            c_name = c.get("name") or c_id
            c_source = c.get("source_box_id") or c.get("sourceBoxId") or ""
            c_state = c.get("state") or "ready"
            c_created = c.get("created_at") or c.get("createdAt")
            c_size = c.get("size_bytes") if c.get("size_bytes") is not None else c.get("sizeBytes")
            c_error = c.get("error_reason") or c.get("errorReason")
        else:
            c_id = getattr(c, "id", None) or getattr(c, "checkpoint_id", "") or str(c)
            c_name = getattr(c, "name", "") or c_id
            c_source = getattr(c, "source_box_id", None) or getattr(c, "sourceBoxId", "") or ""
            c_state = getattr(c, "state", "ready")
            c_created = getattr(c, "created_at", None) or getattr(c, "createdAt", None)
            if hasattr(c_created, "to_rfc3339"):
                c_created = c_created.to_rfc3339()
            elif hasattr(c_created, "isoformat"):
                c_created = c_created.isoformat()
            elif c_created is not None:
                c_created = str(c_created)
            c_size = getattr(c, "size_bytes", None)
            if c_size is None:
                c_size = getattr(c, "sizeBytes", None)
            c_error = getattr(c, "error_reason", None) or getattr(c, "errorReason", None)

        item: Dict[str, Any] = {
            "id": c_id,
            "name": c_name,
            "sourceBoxId": c_source,
            "state": str(c_state).lower().strip() if c_state else "ready",
            "createdAt": c_created,
            "sizeBytes": c_size if c_size is not None else 0,
        }
        if c_error:
            item["errorReason"] = c_error
        return item

    def _get_checkpoint_handle(self, rt: Any) -> Any:
        if hasattr(rt, "checkpoints"):
            attr = getattr(rt, "checkpoints")
            return attr() if callable(attr) else attr
        return None

    async def handle_list_checkpoints(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        checkpoints = None
        handle = self._get_checkpoint_handle(rt)
        if handle is not None and hasattr(handle, "list") and callable(handle.list):
            try:
                checkpoints = await handle.list()
            except Exception as e:
                log_debug(f"rt.checkpoints.list() failed ({e}), falling back to REST")

        if checkpoints is None:
            if isinstance(rt, RestRuntimeFallback):
                checkpoints = await rt.list_checkpoints()
            else:
                fallback = RestRuntimeFallback(
                    os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
                    os.environ.get("BOXLITE_API_KEY", "")
                )
                checkpoints = await fallback.list_checkpoints()

        return {"checkpoints": [self._format_checkpoint(c) for c in (checkpoints or [])]}

    async def handle_create_checkpoint(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        source_box_id = args["sourceBoxId"]
        name = args.get("name")

        handle = self._get_checkpoint_handle(rt)
        if handle is not None and hasattr(handle, "create") and callable(handle.create):
            try:
                if name:
                    info = await handle.create(source_box_id, name=name)
                else:
                    info = await handle.create(source_box_id)
                return self._format_checkpoint(info)
            except Exception as e:
                log_debug(f"rt.checkpoints.create() failed ({e}), falling back to REST")

        if isinstance(rt, RestRuntimeFallback):
            res = await rt.create_checkpoint(source_box_id, name=name)
            return self._format_checkpoint(res)

        fallback = RestRuntimeFallback(
            os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
            os.environ.get("BOXLITE_API_KEY", "")
        )
        res = await fallback.create_checkpoint(source_box_id, name=name)
        return self._format_checkpoint(res)

    async def handle_inspect_checkpoint(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        key = args["checkpointKey"]

        handle = self._get_checkpoint_handle(rt)
        if handle is not None and hasattr(handle, "get") and callable(handle.get):
            try:
                info = await handle.get(key)
                if hasattr(info, "to_dict"):
                    data = info.to_dict()
                elif hasattr(info, "__dict__"):
                    data = {k: v for k, v in info.__dict__.items() if not k.startswith("_")}
                else:
                    data = self._format_checkpoint(info)
                return {"checkpoint": data}
            except Exception as e:
                log_debug(f"rt.checkpoints.get() failed ({e}), falling back to REST")

        if isinstance(rt, RestRuntimeFallback):
            res = await rt.get_checkpoint(key)
            return {"checkpoint": res}

        fallback = RestRuntimeFallback(
            os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
            os.environ.get("BOXLITE_API_KEY", "")
        )
        res = await fallback.get_checkpoint(key)
        return {"checkpoint": res}

    async def handle_remove_checkpoint(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        key = args["checkpointKey"]
        force = bool(args.get("force", False))

        handle = self._get_checkpoint_handle(rt)
        if handle is not None and hasattr(handle, "remove") and callable(handle.remove):
            try:
                await handle.remove(key, force=force)
                return {"checkpointKey": key, "removed": True}
            except Exception as e:
                log_debug(f"rt.checkpoints.remove() failed ({e}), falling back to REST")

        if isinstance(rt, RestRuntimeFallback):
            await rt.remove_checkpoint(key, force=force)
            return {"checkpointKey": key, "removed": True}

        fallback = RestRuntimeFallback(
            os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
            os.environ.get("BOXLITE_API_KEY", "")
        )
        await fallback.remove_checkpoint(key, force=force)
        return {"checkpointKey": key, "removed": True}

    async def handle_verify_secret_injection(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        image = args.get("image") or "python:alpine"
        host = args.get("host") or "httpbingo.org"
        token = "demo-not-a-real-key-" + py_secrets.token_hex(16)
        box_id = None
        cleaned_up = False

        try:
            created = await self.handle_create_box({
                "image": image,
                "autoStop": 0,
                "autoDelete": 0,
                "secrets": [{
                    "name": "demo",
                    "value": token,
                    "hosts": [host],
                    "headers": {"Authorization": "Bearer {value}"}
                }]
            })
            box_id = created["boxId"]

            env_res = await self.handle_exec({
                "boxId": box_id,
                "command": "env",
                "args": []
            })
            env_out = env_res.get("stdout", "")
            if env_res.get("exitCode", 0) != 0 or not env_out.strip() or token in env_out:
                raise RuntimeError("Guest environment check failed: test token appeared in guest environment or env failed.")

            request_code = (
                "import json, ssl, urllib.request\n"
                f'req = urllib.request.Request("https://{host}/headers", headers={{"Authorization": "Bearer <BOXLITE_SECRET:demo>"}})\n'
                'ctx = ssl.create_default_context(cafile="/etc/ssl/certs/ca-certificates.crt")\n'
                "with urllib.request.urlopen(req, context=ctx, timeout=30) as response:\n"
                "    print(response.read().decode())\n"
            )
            echo_res = await self.handle_exec({
                "boxId": box_id,
                "command": "python",
                "args": ["-c", request_code]
            })
            if echo_res.get("exitCode", 0) != 0:
                raise RuntimeError(f"Header injection probe failed (exit {echo_res.get('exitCode')}): {echo_res.get('stderr', '')}")

            echoed = json.loads(echo_res.get("stdout", "{}"))
            echo_headers = {str(k).lower(): v for k, v in (echoed.get("headers") or {}).items()}
            authorization = echo_headers.get("authorization")
            if isinstance(authorization, list):
                authorization = authorization[0] if authorization else None
            if authorization != f"Bearer {token}":
                raise RuntimeError("Upstream did not receive the injected Authorization header")

            return {
                "boxId": box_id,
                "envCheckPassed": True,
                "headerInjectionPassed": True,
                "cleanedUp": True,
                "summary": "PASS: guest environment clean; PASS: upstream received injected Authorization header"
            }
        finally:
            if box_id is not None:
                try:
                    await rt.remove(box_id, force=True)
                    if box_id in self.boxes:
                        del self.boxes[box_id]
                    if box_id in self.box_secrets:
                        del self.box_secrets[box_id]
                    cleaned_up = True
                except Exception as cleanup_err:
                    log_debug(f"Failed to remove verification box {box_id}: {cleanup_err}")

    async def dispatch(self, req: Dict[str, Any]):
        req_id = req.get("id", "none")
        op = req.get("op", "")
        args = req.get("args", {})

        handler_name = f"handle_{op}"
        handler = getattr(self, handler_name, None)

        if not handler:
            send_response(
                req_id,
                False,
                error={
                    "code": "UnknownOperation",
                    "message": f"Operation '{op}' is not supported by BoxLite bridge"
                }
            )
            return

        try:
            result = await handler(args)
            send_response(req_id, True, data=result)
        except Exception as e:
            tb = traceback.format_exc()
            error_class = e.__class__.__name__
            message = str(e)

            # Formulate structured diagnostic guidance according to §5
            diagnosis = None
            if "502" in message or "unreachable" in message.lower():
                diagnosis = "502 Bad Gateway / Box unreachable: Check app listener on 0.0.0.0, /tmp/server.log, network inbound mode, and tunnel declaration (agent.md §5)."
            elif "401" in message or "unauthorized" in message.lower() or ("invalid credentials" in message.lower() and "403" not in message):
                diagnosis = "401 Unauthorized: Invalid credentials or missing token. Check credentials and BOXLITE_API_KEY via 'BoxLite: Sign In / Set API Key' (agent.md §5)."
            elif "403" in message or "forbidden" in message.lower():
                diagnosis = "403 Forbidden: Check authentication/token and requested URL; do not assume either app health or one particular policy cause (agent.md §5). Note: do not infer managed database or shared-volume support (agent.md §4). For private images or registries, ensure API key has Full access (docs.boxlite.ai/cloud/private-images)."
            elif "409" in message or "already ran" in message.lower() or "conflict" in message.lower():
                diagnosis = "409 Conflict: Process already ran or name conflict. Check supervisor entrypoint and box lifecycle (agent.md §5)."
            elif "400" in message or "bad request" in message.lower():
                diagnosis = "400 Bad Request: Check schema validation and parameters; ensure deprecated or unsupported fields (such as auto_remove) are omitted (agent.md §5)."
            elif "NetworkError" in error_class or "network" in message.lower():
                diagnosis = "BoxLite NetworkError: Connection failure talking to BoxLite Cloud. Check API key and BOXLITE_REST_URL (agent.md §5)."
            elif "BOXLITE_API_KEY" in message:
                diagnosis = "Missing API key: Configure your BoxLite Cloud API key with 'BoxLite: Sign In / Set API Key'."

            send_response(
                req_id,
                False,
                error={
                    "code": error_class,
                    "message": message,
                    "diagnosis": diagnosis,
                    "stack": tb
                }
            )


async def read_stdin_line() -> str:
    """Read a single line from sys.stdin in an executor thread, cross-platform."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, sys.stdin.readline)


async def main():
    bridge = BoxLiteBridge()
    log_debug("BoxLite Python bridge started. Listening on stdin...")

    while True:
        line = await read_stdin_line()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            asyncio.create_task(bridge.dispatch(req))
        except json.JSONDecodeError as err:
            log_debug(f"JSON decode error: {err}")
            send_response("error", False, error={"code": "InvalidJson", "message": str(err)})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        pass
