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
import sys
import traceback
import urllib.error
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
        return await self.rt.exec(self.id, list(cmd))

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
        return ExecResultFallback(
            exit_code=res.get("exit_code", res.get("exitCode", 0)),
            stdout=res.get("stdout", ""),
            stderr=res.get("stderr", "")
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


class BoxLiteBridge:
    def __init__(self):
        self.rt = None
        self.boxes: Dict[str, Any] = {}

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
        boxes = await rt.list()
        items = []
        for b in boxes:
            b_id = getattr(b, "id", None) or (b.get("id") or b.get("box_id") if isinstance(b, dict) else str(b))
            b_name = getattr(b, "name", "") or (b.get("name") if isinstance(b, dict) else "")
            items.append({"id": b_id, "name": b_name})
        return {"valid": True, "boxCount": len(items)}

    async def handle_list_boxes(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        boxes = await rt.list()
        result = []
        for b in boxes:
            b_id = getattr(b, "id", None) or (b.get("id") or b.get("box_id") if isinstance(b, dict) else str(b))
            b_name = getattr(b, "name", "") or (b.get("name") if isinstance(b, dict) else "")
            b_status = getattr(b, "status", "unknown") or (b.get("status") if isinstance(b, dict) else "unknown")
            b_image = getattr(b, "image", "python") or (b.get("image") if isinstance(b, dict) else "python")

            box_info = {
                "id": b_id,
                "name": b_name,
                "status": b_status,
                "image": b_image,
            }
            if hasattr(b, "tunnels"):
                box_info["tunnels"] = getattr(b, "tunnels")
            elif isinstance(b, dict) and "tunnels" in b:
                box_info["tunnels"] = b["tunnels"]
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
            data = info
        else:
            data = {"id": box_id, "raw": str(info)}
        return {"box": data}

    async def handle_create_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args.get("name")
        image = args.get("image", "python")
        auto_remove = args.get("autoRemove", False)
        auto_stop = args.get("autoStop", args.get("auto_stop", 0))
        entrypoint = args.get("entrypoint")
        network_spec = args.get("network")

        if isinstance(rt, RestRuntimeFallback):
            # BoxLite Cloud REST API conforms to OpenAPI CreateBoxRequest (additionalProperties: false).
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
            if "autoDelete" in args and args["autoDelete"] is not None:
                kwargs["auto_delete"] = args["autoDelete"]
            elif "auto_delete" in args and args["auto_delete"] is not None:
                kwargs["auto_delete"] = args["auto_delete"]
            if entrypoint:
                kwargs["entrypoint"] = entrypoint
            if network_spec:
                kwargs["network"] = network_spec

            res = await rt.create(**kwargs)
            box_id = res.get("box_id") or res.get("id") or name
            await rt.start(box_id)
            box = RestBoxFallback(rt, box_id, name or box_id)
            self.boxes[box_id] = box
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

        kwargs = {
            "runtime": rt,
            "image": image,
            "auto_remove": auto_remove,
        }
        if name:
            kwargs["name"] = name
        if auto_stop is not None:
            kwargs["auto_stop"] = auto_stop
        if entrypoint:
            kwargs["entrypoint"] = entrypoint
        if net:
            kwargs["network"] = net

        try:
            box = boxlite.SimpleBox(**kwargs)
        except TypeError:
            # Fallback if installed boxlite wheel rejects auto_stop or other kwargs
            kwargs.pop("auto_stop", None)
            box = boxlite.SimpleBox(**kwargs)

        await box.start()
        box_id = box.id
        self.boxes[box_id] = box

        return {
            "boxId": box_id,
            "name": name or box_id,
            "status": "running"
        }

    async def handle_start_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        box = self.get_or_attach_box(box_id)
        await box.start()
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

        exit_code = getattr(res, "exit_code", 0)
        stdout = getattr(res, "stdout", "")
        stderr = getattr(res, "stderr", "")

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
        box = self.get_or_attach_box(box_id)

        res = await box.exec("tail", f"-n{lines}", log_file)
        return {
            "boxId": box_id,
            "content": getattr(res, "stdout", ""),
            "exitCode": getattr(res, "exit_code", 0)
        }

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
                diagnosis = "502 Bad Gateway / Box unreachable: Check app listener on 0.0.0.0, /tmp/server.log, network inbound mode, and tunnel declaration."
            elif "403" in message or "401" in message or "login" in message.lower() or "credentials" in message.lower() or "unauthorized" in message.lower():
                diagnosis = "401/403 Unauthorized: Invalid credentials. Ensure your BOXLITE_API_KEY is configured via 'BoxLite: Sign In / Set API Key'."
            elif "409" in message:
                diagnosis = "409 Conflict: Process already ran or name conflict. Check supervisor entrypoint and box lifecycle."
            elif "NetworkError" in error_class or "network" in message.lower():
                diagnosis = "BoxLite NetworkError: Connection failure talking to BoxLite Cloud. Check API key and BOXLITE_REST_URL."
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
