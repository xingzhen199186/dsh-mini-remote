import base64
import json
import secrets
import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from control.app import create_app  # noqa: E402
from control.database import Database  # noqa: E402
from control.settings import Settings  # noqa: E402

CLIENT_SECRET = "a" * 43
OTHER_SECRET = "b" * 43
ADMIN_USER = "admin"
ADMIN_PASSWORD = "test-admin-password"


class FakeHelper:
    def __init__(self):
        self.create_calls = []
        self.delete_calls = []
        self.reload_calls = 0
        self.tokens = {}

    def create_tenant(self, tenant_id, control_port, vhost_port):
        token = "frp-" + secrets.token_urlsafe(24)
        self.tokens[tenant_id] = token
        self.create_calls.append((tenant_id, control_port, vhost_port))
        return token

    def delete_tenant(self, tenant_id):
        self.delete_calls.append(tenant_id)

    def reload_nginx(self):
        self.reload_calls += 1


def admin_header():
    raw = f"{ADMIN_USER}:{ADMIN_PASSWORD}".encode()
    return {"Authorization": "Basic " + base64.b64encode(raw).decode()}


def build_context(tmp_path, name="app", **overrides):
    base = tmp_path / name
    base.mkdir(parents=True, exist_ok=True)
    values = {
        "db_path": str(base / "control.db"),
        "pepper": "test-pepper",
        "domain": "relay.example.com",
        "admin_url": "https://admin.relay.example.com",
        "admin_user": ADMIN_USER,
        "default_max_tenants": 5,
        "claim_ip_limit": 100,
        "claim_global_limit": 100,
        "auth_failure_limit": 20,
    }
    values.update(overrides)
    settings = Settings(**values)
    helper = FakeHelper()
    app = create_app(settings, helper=helper)
    db = Database(settings.db_path)
    db.set_admin(ADMIN_USER, password=ADMIN_PASSWORD)
    client = TestClient(app)
    return settings, helper, db, client


def make_invite(client, days=7):
    response = client.post(
        "/admin/api/invites",
        json={"expiresInDays": days},
        headers=admin_header(),
    )
    assert response.status_code == 200, response.text
    return response.json()


def claim_body(invite_code=None, request_id="claim-request-0001", secret=CLIENT_SECRET, port=3090):
    body = {
        "clientSecret": secret,
        "originPort": port,
        "claimRequestId": request_id,
    }
    if invite_code is not None:
        body["inviteCode"] = invite_code
    return body


def open_registration(client):
    response = client.post(
        "/admin/api/config",
        json={"allowRegistration": True, "inviteRequired": False},
        headers=admin_header(),
    )
    assert response.status_code == 200, response.text


def test_health_public_and_admin_basic_auth(tmp_path):
    _, _, _, client = build_context(tmp_path)
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["ok"] is True

    denied = client.get("/admin/api/overview")
    assert denied.status_code == 401
    assert denied.headers["www-authenticate"].startswith("Basic")
    wrong = client.get(
        "/admin/api/overview",
        headers={"Authorization": "Basic " + base64.b64encode(b"admin:wrong").decode()},
    )
    assert wrong.status_code == 401

    root = client.get("/", follow_redirects=False)
    assert root.status_code == 307
    assert root.headers["location"] == "/admin"

    page = client.get("/admin", headers=admin_header())
    assert page.status_code == 200
    text = page.text
    for word in ("总览", "租户", "邀请", "配置", "审计"):
        assert word in text
    overview = client.get("/admin/api/overview", headers=admin_header())
    assert overview.status_code == 200
    assert overview.json()["capacity"]["maxTenants"] == 5


def test_config_defaults_and_update_are_audited(tmp_path):
    _, _, db, client = build_context(tmp_path, name="config")
    defaults = client.get("/admin/api/config", headers=admin_header()).json()
    assert defaults == {
        "ok": True,
        "allowRegistration": False,
        "inviteRequired": True,
        "maxTenants": 5,
    }

    changed = client.post(
        "/admin/api/config",
        json={"allowRegistration": True, "inviteRequired": False, "maxTenants": 4},
        headers=admin_header(),
    )
    assert changed.status_code == 200
    assert changed.json()["allowRegistration"] is True
    assert changed.json()["inviteRequired"] is False
    assert changed.json()["maxTenants"] == 4

    invalid = client.post(
        "/admin/api/config", json={"maxTenants": 0}, headers=admin_header()
    )
    assert invalid.status_code == 400
    conn = db.connect()
    try:
        actions = [row["action"] for row in conn.execute("SELECT action FROM audit").fetchall()]
    finally:
        conn.close()
    assert "config.update" in actions


def test_invite_creation_and_listing_do_not_expose_plaintext(tmp_path):
    _, _, db, client = build_context(tmp_path, name="invite")
    invite = make_invite(client)
    assert len(invite["code"]) >= 32
    assert invite["ticket"].startswith("relay1.")
    payload = json.loads(base64.urlsafe_b64decode(
        invite["ticket"][len("relay1."):] + "=" * (-len(invite["ticket"][len("relay1."):]) % 4)
    ))
    assert payload["u"] == "https://admin.relay.example.com"
    assert payload["c"] == invite["code"]
    conn = db.connect()
    try:
        row = conn.execute("SELECT * FROM invites").fetchone()
    finally:
        conn.close()
    assert row["code_hash"] != invite["code"]
    assert invite["code"] not in json.dumps(dict(row))

    listed = client.get("/admin/api/invites", headers=admin_header()).json()
    assert listed["invites"][0]["state"] == "available"
    body = json.dumps(listed)
    assert invite["code"] not in body
    assert row["code_hash"] not in body
    audit = client.get("/admin/api/audit", headers=admin_header()).json()
    assert invite["code"] not in json.dumps(audit)


def test_claim_status_release_and_frp_token_only_once(tmp_path):
    _, helper, db, client = build_context(tmp_path, name="claim")
    invite = make_invite(client)
    first = client.post("/api/claim", json=claim_body(invite["code"]))
    assert first.status_code == 200, first.text
    data = first.json()
    assert data["ok"] is True
    assert data["publicHost"] == f"{data['id']}.relay.example.com"
    assert data["controlHost"] == f"frp-{data['id']}.relay.example.com"
    assert data["frpsPort"] == 443
    assert data["transport"] == "wss"
    assert len(data["frpToken"]) >= 20
    token = data["frpToken"]
    assert helper.create_calls == [(data["id"], 7101, 8101)]

    conn = db.connect()
    try:
        tenant = conn.execute("SELECT * FROM tenants").fetchone()
        everything = json.dumps([dict(row) for row in conn.execute("SELECT * FROM tenants").fetchall()])
        audits = json.dumps([dict(row) for row in conn.execute("SELECT * FROM audit").fetchall()])
    finally:
        conn.close()
    assert tenant["state"] == "active"
    assert tenant["token_hash"] != token
    assert token not in everything
    assert token not in audits
    assert CLIENT_SECRET not in everything

    retry = client.post("/api/claim", json=claim_body(invite["code"]))
    assert retry.status_code == 200
    assert retry.json()["id"] == data["id"]
    assert retry.json()["tokenIssued"] is False
    assert "frpToken" not in retry.json()
    assert len(helper.create_calls) == 1

    listed = client.get("/admin/api/tenants", headers=admin_header()).json()
    assert token not in json.dumps(listed)

    wrong = client.post("/api/claim", json=claim_body(invite["code"], secret=OTHER_SECRET))
    assert wrong.status_code == 403
    assert wrong.json()["error"] == "auth_failed"

    status = client.post(
        "/api/status", json={"id": data["id"], "clientSecret": CLIENT_SECRET}
    )
    assert status.status_code == 200
    assert status.json()["tenant"]["state"] == "active"
    assert "frpToken" not in json.dumps(status.json())

    released = client.post(
        "/api/release", json={"id": data["id"], "clientSecret": CLIENT_SECRET}
    )
    assert released.status_code == 200
    assert released.json()["tenant"]["state"] == "released"
    assert "frpToken" not in json.dumps(released.json())
    status_after = client.post(
        "/api/status", json={"id": data["id"], "clientSecret": CLIENT_SECRET}
    )
    assert status_after.json()["tenant"]["state"] == "released"

    reused_invite = client.post(
        "/api/claim", json=claim_body(invite["code"], request_id="claim-request-0002")
    )
    assert reused_invite.status_code == 409
    assert reused_invite.json()["error"] == "invite_used"


def test_invite_required_default_and_registration_closed(tmp_path):
    _, _, _, client = build_context(tmp_path, name="gates")
    no_invite = client.post("/api/claim", json=claim_body())
    assert no_invite.status_code == 403
    assert no_invite.json()["error"] == "invite_required"

    client.post(
        "/admin/api/config",
        json={"allowRegistration": False, "inviteRequired": False},
        headers=admin_header(),
    )
    closed = client.post("/api/claim", json=claim_body())
    assert closed.status_code == 403
    assert closed.json()["error"] == "registration_closed"

    open_registration(client)
    allowed = client.post("/api/claim", json=claim_body(request_id="self-service-0001"))
    assert allowed.status_code == 200
    assert allowed.json()["tokenIssued"] is True


def test_capacity_limit_and_rate_limit(tmp_path):
    _, _, _, capacity_client = build_context(
        tmp_path, name="capacity", default_max_tenants=2
    )
    for index in range(2):
        invite = make_invite(capacity_client)
        response = capacity_client.post(
            "/api/claim", json=claim_body(invite["code"], request_id=f"capacity-{index:04d}")
        )
        assert response.status_code == 200
    third_invite = make_invite(capacity_client)
    full = capacity_client.post(
        "/api/claim",
        json=claim_body(third_invite["code"], request_id="capacity-0003"),
    )
    assert full.status_code == 409
    assert full.json()["error"] == "capacity_exhausted"

    _, _, _, rate_client = build_context(
        tmp_path, name="rate", claim_ip_limit=2, claim_global_limit=100
    )
    open_registration(rate_client)
    for index in range(2):
        response = rate_client.post(
            "/api/claim", json=claim_body(request_id=f"rate-{index:04d}")
        )
        assert response.status_code == 200
    limited = rate_client.post("/api/claim", json=claim_body(request_id="rate-0003"))
    assert limited.status_code == 429
    assert limited.json()["error"] == "rate_limited"
    assert int(limited.headers["retry-after"]) > 0


def test_admin_revoke_calls_helper_and_keeps_audit(tmp_path):
    _, helper, _, client = build_context(tmp_path, name="revoke")
    invite = make_invite(client)
    claimed = client.post("/api/claim", json=claim_body(invite["code"])).json()
    tenant_id = claimed["id"]

    revoked = client.post(
        f"/admin/api/tenants/{tenant_id}/revoke", headers=admin_header()
    )
    assert revoked.status_code == 200
    assert revoked.json()["tenant"]["state"] == "revoked"
    assert helper.delete_calls == [tenant_id]
    assert helper.reload_calls == 1

    tenants = client.get("/admin/api/tenants", headers=admin_header()).json()["tenants"]
    assert tenants[0]["state"] == "revoked"
    assert "frpToken" not in json.dumps(tenants)
    audit = client.get("/admin/api/audit", headers=admin_header()).json()["audit"]
    assert any(item["action"] == "tenant.revoke" for item in audit)
