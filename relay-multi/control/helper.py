"""root helper 的薄客户端。helper 只接受固定动作。"""

from __future__ import annotations

import json
import subprocess


class HelperError(RuntimeError):
    pass


class SudoHelper:
    def __init__(self, path: str, runner=subprocess.run):
        self.path = path
        self.runner = runner

    def create_tenant(self, tenant_id: str, control_port: int, vhost_port: int) -> str:
        payload = self._run(
            "create-tenant", tenant_id, str(control_port), str(vhost_port)
        )
        token = payload.get("token")
        if not isinstance(token, str) or len(token) < 20:
            raise HelperError("helper 没有返回有效 token")
        return token

    def delete_tenant(self, tenant_id: str) -> None:
        self._run("delete-tenant", tenant_id)

    def reload_nginx(self) -> None:
        self._run("reload-nginx")

    def _run(self, *args: str) -> dict:
        try:
            completed = self.runner(
                ["sudo", "-n", self.path, *args],
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise HelperError("root helper 无法执行") from exc
        if completed.returncode != 0:
            raise HelperError("root helper 返回失败")
        line = (completed.stdout or "").strip().splitlines()
        if not line:
            raise HelperError("root helper 没有输出")
        try:
            payload = json.loads(line[-1])
        except json.JSONDecodeError as exc:
            raise HelperError("root helper 输出格式不对") from exc
        if not payload.get("ok"):
            raise HelperError("root helper 拒绝了操作")
        return payload
