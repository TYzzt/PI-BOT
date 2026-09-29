"""Cloud chat: API + DeepAgents worker against a fake OpenAI-compatible endpoint (C-01 .. C-09)."""
import base64
import json
import os
import threading
import time
import uuid

import pytest
from langchain_core.tools import tool
from langgraph.checkpoint.postgres import PostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from sqlalchemy import text

from tagent_server.realtime import _libpq_url
from tagent_server.worker.runner import ERR_LOST, ERR_MODEL, Worker
from tests.fake_openai import PROVIDER_SECRET_ERROR, FakeOpenAI
from tests.helpers import bearer, login
from tests.test_phase2 import device_call, setup_mac

CLOUD_KEY = "cloud-key-do-not-leak"
TAVILY_KEY = "tvly-do-not-leak"


@pytest.fixture(scope="session")
def fake_openai():
    with FakeOpenAI() as fake:
        yield fake


@pytest.fixture(scope="session")
def checkpointer(database_url):
    pool = ConnectionPool(_libpq_url(database_url), min_size=1, max_size=8, open=True,
                          kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row})
    saver = PostgresSaver(pool)
    saver.setup()
    yield saver
    pool.close()


@pytest.fixture
def cloud(client, tmp_path, fake_openai, checkpointer):
    path = tmp_path / "keys.json"
    path.write_text(json.dumps({"active": "k1", "keys": {"k1": base64.b64encode(os.urandom(32)).decode()}}))
    settings = client.app.state.settings
    settings.sync_key_file = path
    settings.worker_lease_seconds = 4
    token = login(client)
    model_id = str(uuid.uuid4())
    r = client.put(f"/cloud/models/{model_id}", headers=bearer(token), json=cloud_model_body(fake_openai.url))
    assert r.status_code == 200, r.text
    return Cloud(client, token, model_id, checkpointer)


def cloud_model_body(url, version=0, api_key=CLOUD_KEY):
    return {"expected_version": version, "request_id": str(uuid.uuid4()), "api_key": api_key,
            "config": {"name": "fake", "base_url": url, "model_id": "fake-model", "context_window": 32000, "max_tokens": 1024, "is_default": True}}


class Cloud:
    def __init__(self, client, token, model_id, checkpointer):
        self.client, self.token, self.model_id, self.checkpointer = client, token, model_id, checkpointer

    def worker(self, name="w1", search=None):
        return Worker(self.client.app.state.settings, self.client.app.state.engine, worker_id=name,
                      search=lambda _settings: search, checkpointer=self.checkpointer)

    def conversation(self, title="云端"):
        id = str(uuid.uuid4())
        r = self.client.put(f"/cloud/conversations/{id}", headers=bearer(self.token),
                            json={"expected_version": 0, "request_id": str(uuid.uuid4()), "title": title, "model_config_id": self.model_id})
        assert r.status_code == 200, r.text
        return id

    def send(self, conversation_id, question):
        r = self.client.post(f"/conversations/{conversation_id}/messages", headers=bearer(self.token), json={"text": question, "request_id": str(uuid.uuid4())})
        assert r.status_code == 200, r.text
        return r.json()

    def run(self, run_id):
        return self.client.get(f"/chat-runs/{run_id}", headers=bearer(self.token)).json()

    def messages(self, conversation_id):
        return self.client.get(f"/conversations/{conversation_id}/messages", headers=bearer(self.token)).json()

    def answer(self, conversation_id):
        return [m for m in self.messages(conversation_id)["messages"] if m["role"] == "assistant"][-1]


def test_cloud_answer_without_mac_and_checkpoint_context(cloud, fake_openai):
    """C-01 + C-03: no Mac is paired at all; the second question sees the first through the checkpoint."""
    conversation = cloud.conversation()
    [listed] = [c for c in cloud.client.get("/conversations", headers=bearer(cloud.token)).json() if c["id"] == conversation]
    assert listed["target"] == "cloud" and listed["device_id"] is None and listed["handoff"] is None
    assert listed["updated_at"] > 0
    worker = cloud.worker()
    first = cloud.send(conversation, "第一问：北京在哪里")
    assert first["state"] == "queued" and first["device_id"] is None
    assert worker.run_once()
    assert cloud.run(first["id"])["state"] == "completed"
    refreshed = next(c for c in cloud.client.get("/conversations", headers=bearer(cloud.token)).json() if c["id"] == conversation)
    assert refreshed["updated_at"] > listed["updated_at"]
    page = cloud.messages(conversation)
    assert [(m["role"], m["sequence"], m["status"]) for m in page["messages"]] == [("user", 1, "completed"), ("assistant", 2, "completed")]
    assert page["messages"][1]["content"] == "收到：第一问：北京在哪里。之前问过：无"
    second = cloud.send(conversation, "第二问")
    before = len(fake_openai.requests)
    assert worker.run_once()
    assert cloud.run(second["id"])["state"] == "completed"
    assert "第一问：北京在哪里" in cloud.answer(conversation)["content"]
    # The seeded thread only receives the new question; history comes from the Postgres checkpoint.
    assert sum(m["role"] == "user" for m in fake_openai.requests[before]["messages"]) == 2
    assert not worker.run_once()


def test_streaming_snapshots_and_cancel(cloud):
    """C-02 + C-05."""
    conversation = cloud.conversation()
    run = cloud.send(conversation, "请慢慢回答")
    worker = cloud.worker()
    thread = threading.Thread(target=worker.run_once)
    thread.start()
    snapshot = None
    deadline = time.time() + 20
    while time.time() < deadline:
        answers = [m for m in cloud.messages(conversation)["messages"] if m["role"] == "assistant"]
        if answers and answers[0]["status"] == "running" and answers[0]["content"]:
            snapshot = answers[0]
            break
        time.sleep(0.2)
    assert snapshot is not None, "no intermediate snapshot"
    cancelled = cloud.client.post(f"/chat-runs/{run['id']}/cancel", headers=bearer(cloud.token)).json()
    assert cancelled["cancel_requested"]
    thread.join(timeout=30)
    assert not thread.is_alive()
    final = cloud.run(run["id"])
    assert final["state"] == "cancelled"
    answer = cloud.answer(conversation)
    assert answer["status"] == "cancelled" and answer["content"].startswith("第0段。")
    assert len(answer["content"]) >= len(snapshot["content"]) and "第59段" not in answer["content"]
    again = cloud.client.post(f"/chat-runs/{run['id']}/cancel", headers=bearer(cloud.token))
    assert again.status_code == 200 and again.json()["state"] == "cancelled"
    # A cancelled run starts a new checkpoint generation; the next question is answered normally.
    nxt = cloud.send(conversation, "继续")
    assert worker.run_once() and cloud.run(nxt["id"])["state"] == "completed"
    assert "请慢慢回答" in cloud.answer(conversation)["content"]


def test_streaming_full_text(cloud):
    """C-02: the final text is complete."""
    conversation = cloud.conversation()
    run = cloud.send(conversation, "慢一点也没关系")
    worker = cloud.worker()
    seen = []
    thread = threading.Thread(target=worker.run_once)
    thread.start()
    while thread.is_alive():
        answers = [m for m in cloud.messages(conversation)["messages"] if m["role"] == "assistant"]
        if answers and answers[0]["status"] == "running":
            seen.append(answers[0]["content"])
        time.sleep(0.3)
    assert cloud.run(run["id"])["state"] == "completed"
    assert cloud.answer(conversation)["content"] == "".join(f"第{i}段。" for i in range(60))
    assert any(0 < len(s) < len(cloud.answer(conversation)["content"]) for s in seen)


def test_queued_cancel_never_reaches_worker(cloud):
    conversation = cloud.conversation()
    run = cloud.send(conversation, "排队中取消")
    assert cloud.client.post(f"/chat-runs/{run['id']}/cancel", headers=bearer(cloud.token)).json()["state"] == "cancelled"
    assert not cloud.worker().run_once()
    assert cloud.messages(conversation)["pending_messages"][0]["status"] == "cancelled"


def test_search_tool_registered_only_with_key(cloud, fake_openai):
    """C-04: search tool is offered and used when configured, absent otherwise."""
    calls = []

    @tool
    def tavily_search(query: str) -> str:
        """Search the web."""
        calls.append(query)
        return "今日新闻：示例。来源 https://example.com/news"

    conversation = cloud.conversation()
    run = cloud.send(conversation, "请搜索今天的新闻")
    worker = cloud.worker(search=tavily_search)
    assert worker.run_once() and cloud.run(run["id"])["state"] == "completed"
    assert calls == ["请搜索今天的新闻"]
    assert "https://example.com/news" in cloud.answer(conversation)["content"]
    assert "联网搜索" in fake_openai.requests[-1]["messages"][0]["content"]

    other = cloud.conversation()
    before = len(fake_openai.requests)
    run = cloud.send(other, "请搜索别的")
    assert cloud.worker().run_once() and cloud.run(run["id"])["state"] == "completed"
    request = fake_openai.requests[before]
    assert "tavily_search" not in [t["function"]["name"] for t in request.get("tools", [])]
    assert "没有启用联网搜索" in request["messages"][0]["content"]
    # Built-in DeepAgents tools stay virtual: there is no shell backend.
    assert cloud.answer(other)["content"].startswith("收到：")


def test_lease_expiry_interrupts_without_rerun(cloud):
    """C-06: a crashed worker's run becomes interrupted and is not retried; the next question works."""
    conversation = cloud.conversation()
    run = cloud.send(conversation, "worker 会崩溃")
    crashed = cloud.worker("crashed")
    assert crashed.claim() is not None  # claimed, then the process "dies" without heartbeats
    assert cloud.run(run["id"])["state"] == "running"
    survivor = cloud.worker("survivor")
    assert survivor.expire_leases() == 0
    time.sleep(4.5)
    assert survivor.expire_leases() == 1
    final = cloud.run(run["id"])
    assert final["state"] == "interrupted" and final["error"] == ERR_LOST
    assert cloud.answer(conversation)["status"] == "interrupted"
    assert not survivor.run_once()
    nxt = cloud.send(conversation, "再问一次")
    assert survivor.run_once() and cloud.run(nxt["id"])["state"] == "completed"
    assert "worker 会崩溃" in cloud.answer(conversation)["content"]


def test_concurrent_workers_claim_once(cloud):
    """C-07."""
    conversations = [cloud.conversation(f"c{i}") for i in range(3)]
    runs = [cloud.send(c, f"问题{i}") for i, c in enumerate(conversations)]
    workers = [cloud.worker(f"w{i}") for i in range(6)]
    claimed, barrier = [], threading.Barrier(len(workers))

    def grab(worker):
        barrier.wait()
        job = worker.claim()
        if job:
            claimed.append(job.run_id)

    threads = [threading.Thread(target=grab, args=(w,)) for w in workers]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(map(str, claimed)) == sorted(r["id"] for r in runs)
    with cloud.client.app.state.engine.connect() as s:
        owners = s.execute(text("SELECT data->>'worker_id' FROM shared_documents WHERE kind='chat_run' AND device_id IS NULL")).scalars().all()
    assert len(set(owners)) == 3


def test_handoff_copies_shared_messages_only(cloud, fake_openai):
    """C-08."""
    c, t = cloud.client, cloud.token
    mac = setup_mac(c, t)
    device_call(c, mac, "POST", "/device/shared/enable")
    mac_model = str(uuid.uuid4())
    body = {"device_id": mac.device_id, "expected_version": 0, "request_id": str(uuid.uuid4()), "api_key": "mac-key-do-not-leak",
            "config": {"name": "mac", "base_url": fake_openai.url, "model_id": "fake-model", "context_window": 32000, "max_tokens": 1024, "is_default": True}}
    assert device_call(c, mac, "PUT", f"/device/configs/models/{mac_model}", body).status_code == 200
    source = str(uuid.uuid4())
    conv = {"device_id": mac.device_id, "title": "Mac 会话", "kind": "read_code", "model_config_id": mac_model, "project_id": mac.project_id,
            "expected_version": 0, "request_id": str(uuid.uuid4())}
    assert device_call(c, mac, "PUT", f"/device/conversations/{source}", conv).status_code == 200
    run = str(uuid.uuid4())
    history = [{"id": str(uuid.uuid4()), "run_id": run, "role": role, "content": content, "status": "completed", "sequence": i + 1, "revision": 1}
               for i, (role, content) in enumerate([("user", "项目用什么数据库"), ("assistant", "PostgreSQL 16"), ("user", "x" * 70000), ("assistant", "太长了")])]
    assert device_call(c, mac, "POST", f"/device/conversations/{source}/messages", {"share_version": 1, "messages": history}).status_code == 200
    before = c.get(f"/conversations/{source}/messages", headers=bearer(t)).json()

    target = str(uuid.uuid4())
    r = c.post(f"/cloud/conversations/{target}/handoff-from/{source}", headers=bearer(t), json={"request_id": str(uuid.uuid4()), "model_config_id": cloud.model_id})
    assert r.status_code == 200, r.text
    handed = r.json()
    assert handed["target"] == "cloud" and handed["kind"] == "ask" and handed["project_id"] is None
    # The 70k message exceeds the character budget, so only the one after it survives.
    assert handed["handoff"] == {"from_conversation_id": source, "message_count": 1}
    assert [m["content"] for m in cloud.messages(target)["messages"]] == ["太长了"]
    assert c.get(f"/conversations/{source}/messages", headers=bearer(t)).json() == before

    small, short = str(uuid.uuid4()), str(uuid.uuid4())
    assert device_call(c, mac, "PUT", f"/device/conversations/{short}", conv | {"request_id": str(uuid.uuid4())}).status_code == 200
    history = [m | {"id": str(uuid.uuid4()), "content": "第三句" if m["content"].startswith("x") else m["content"]} for m in history]
    assert device_call(c, mac, "POST", f"/device/conversations/{short}/messages", {"share_version": 1, "messages": history}).status_code == 200
    r = device_call(c, mac, "POST", f"/device/cloud/conversations/{small}/handoff-from/{short}", {"request_id": str(uuid.uuid4()), "model_config_id": cloud.model_id})
    assert r.status_code == 200 and r.json()["handoff"]["message_count"] == 4
    question = cloud.send(small, "继续聊")
    before_requests = len(fake_openai.requests)
    assert cloud.worker().run_once() and cloud.run(question["id"])["state"] == "completed"
    request = fake_openai.requests[before_requests]
    assert "项目用什么数据库" in cloud.answer(small)["content"]
    assert "转来" in request["messages"][0]["content"]
    assert "mac-key-do-not-leak" not in json.dumps(request)

    # Cloud runs are invisible to devices: no ack, no device changes, no project access.
    assert device_call(c, mac, "POST", f"/device/chat-runs/{question['id']}/ack").status_code == 404
    changes = device_call(c, mac, "GET", "/device/shared/changes").json()
    assert all(item["id"] not in {small, target} for item in changes["changes"])
    other = setup_mac(c, t, label="Other")
    denied = device_call(c, other, "POST", f"/device/cloud/conversations/{uuid.uuid4()}/handoff-from/{source}", {"request_id": str(uuid.uuid4()), "model_config_id": cloud.model_id})
    assert denied.status_code == 404
    conv.update(expected_version=1, request_id=str(uuid.uuid4()), shared=False)
    assert c.put(f"/conversations/{source}", headers=bearer(t), json=conv).status_code == 200
    unshared = c.post(f"/cloud/conversations/{uuid.uuid4()}/handoff-from/{source}", headers=bearer(t), json={"request_id": str(uuid.uuid4()), "model_config_id": cloud.model_id})
    assert unshared.status_code == 409
    wrong = c.put(f"/conversations/{small}", headers=bearer(t), json=conv | {"request_id": str(uuid.uuid4())})
    assert wrong.status_code == 409


def test_keys_never_leak_and_model_errors_are_fixed_text(cloud, fake_openai, caplog):
    """C-09: keys stay out of API responses, events, revisions and logs; provider errors are not copied."""
    c, t = cloud.client, cloud.token
    settings = c.app.state.settings
    from pydantic import SecretStr
    settings.tavily_api_key = SecretStr(TAVILY_KEY)
    try:
        mac = setup_mac(c, t)
        device_call(c, mac, "POST", "/device/shared/enable")
        mac_model = str(uuid.uuid4())
        body = {"device_id": mac.device_id, "expected_version": 0, "request_id": str(uuid.uuid4()), "api_key": "mac-key-do-not-leak",
                "config": {"name": "mac", "base_url": fake_openai.url, "model_id": "fake-model", "context_window": 32000, "max_tokens": 1024, "is_default": True}}
        device_call(c, mac, "PUT", f"/device/configs/models/{mac_model}", body)
        copied = device_call(c, mac, "POST", "/device/cloud/models/from-mac", {"request_id": str(uuid.uuid4()), "model_id": mac_model})
        assert copied.status_code == 200, copied.text
        assert copied.json()["source_model_id"] == mac_model and copied.json()["has_key"] and not copied.json()["config"]["is_default"]
        other = setup_mac(c, t, label="Other")
        assert device_call(c, other, "POST", "/device/cloud/models/from-mac", {"request_id": str(uuid.uuid4()), "model_id": mac_model}).status_code == 404

        conversation = str(uuid.uuid4())
        c.put(f"/cloud/conversations/{conversation}", headers=bearer(t), json={"expected_version": 0, "request_id": str(uuid.uuid4()), "title": "copied", "model_config_id": copied.json()["id"]})
        ok = cloud.send(conversation, "用复制的模型回答")
        caplog.set_level("DEBUG")
        worker = Worker(settings, c.app.state.engine, worker_id="real-search", checkpointer=cloud.checkpointer)
        assert worker.run_once() and cloud.run(ok["id"])["state"] == "completed"
        assert fake_openai.requests[-1]["model"] == "fake-model"

        bad = cloud.conversation("失败")
        run = cloud.send(bad, "请失败")
        assert cloud.worker().run_once()
        failed = cloud.run(run["id"])
        assert failed["state"] == "failed" and failed["error"] == ERR_MODEL

        blob = json.dumps([
            c.get("/cloud/models", headers=bearer(t)).json(), c.get("/configs/models", headers=bearer(t)).json(),
            c.get("/conversations", headers=bearer(t)).json(), cloud.messages(bad), cloud.messages(conversation), failed,
            device_call(c, mac, "GET", "/device/cloud/models").json(), c.get("/events?after=0&limit=500", headers=bearer(t)).json(),
        ], ensure_ascii=False)
        with c.app.state.engine.connect() as s:
            stored = "".join(s.execute(text("SELECT data::text FROM shared_documents UNION ALL SELECT data::text FROM shared_revisions UNION ALL SELECT payload::text FROM events")).scalars().all())
        for secret in (CLOUD_KEY, "mac-key-do-not-leak", TAVILY_KEY, PROVIDER_SECRET_ERROR):
            assert secret not in blob
            assert secret not in stored
            assert secret not in caplog.text
        assert TAVILY_KEY not in json.dumps(fake_openai.requests)
    finally:
        settings.tavily_api_key = None


def test_saving_a_mac_model_mirrors_it_for_cloud(cloud, fake_openai):
    c, t = cloud.client, cloud.token
    mac = setup_mac(c, t)
    device_call(c, mac, "POST", "/device/shared/enable")
    mac_model = str(uuid.uuid4())
    body = {"device_id": mac.device_id, "expected_version": 0, "request_id": str(uuid.uuid4()), "api_key": "mirror-key-do-not-leak",
            "config": {"name": "两边可用", "base_url": fake_openai.url, "model_id": "fake-model", "context_window": 32000, "max_tokens": 1024, "is_default": True}}
    assert device_call(c, mac, "PUT", f"/device/configs/models/{mac_model}", body).status_code == 200
    listed = [m for m in c.get("/cloud/models", headers=bearer(t)).json() if m.get("source_model_id") == mac_model and not m["deleted"]]
    assert len(listed) == 1 and listed[0]["config"]["name"] == "两边可用" and listed[0]["has_key"]
    assert "mirror-key-do-not-leak" not in json.dumps(listed)
    body = {**body, "expected_version": 1, "request_id": str(uuid.uuid4()), "api_key": "mirror-key-replaced", "config": {**body["config"], "name": "改名后"}}
    assert device_call(c, mac, "PUT", f"/device/configs/models/{mac_model}", body).status_code == 200
    again = [m for m in c.get("/cloud/models", headers=bearer(t)).json() if m.get("source_model_id") == mac_model and not m["deleted"]]
    assert len(again) == 1 and again[0]["id"] == listed[0]["id"] and again[0]["config"]["name"] == "改名后"
    removed = device_call(c, mac, "POST", f"/device/configs/models/{mac_model}/delete", {"expected_version": 2, "request_id": str(uuid.uuid4())})
    assert removed.status_code == 200, removed.text
    gone = [m for m in c.get("/cloud/models", headers=bearer(t)).json() if m["id"] == listed[0]["id"]]
    assert gone[0]["deleted"] and "mirror-key" not in json.dumps(gone)


def test_cloud_model_lifecycle(cloud, fake_openai):
    c, t = cloud.client, cloud.token
    models = c.get("/cloud/models", headers=bearer(t)).json()
    assert len(models) == 1 and models[0]["has_key"] and "secret" not in models[0] and "api_key" not in models[0]
    second = str(uuid.uuid4())
    assert c.put(f"/cloud/models/{second}", headers=bearer(t), json=cloud_model_body(fake_openai.url) | {"api_key": None}).status_code == 422
    assert c.put(f"/cloud/models/{second}", headers=bearer(t), json=cloud_model_body(fake_openai.url)).status_code == 200
    assert [m["config"]["is_default"] for m in c.get("/cloud/models", headers=bearer(t)).json()] == [False, True]
    stale = c.put(f"/cloud/models/{second}", headers=bearer(t), json=cloud_model_body(fake_openai.url))
    assert stale.status_code == 409
    conversation = cloud.conversation()
    delete = {"expected_version": 2, "request_id": str(uuid.uuid4())}
    assert c.post(f"/cloud/models/{cloud.model_id}/delete", headers=bearer(t), json=delete).status_code == 409
    moved = c.post(f"/cloud/models/{cloud.model_id}/delete", headers=bearer(t), json=delete | {"replacement_id": second})
    assert moved.status_code == 200, moved.text
    assert [x for x in c.get("/conversations", headers=bearer(t)).json() if x["id"] == conversation][0]["model_config_id"] == second
    removed = c.put(f"/cloud/conversations/{conversation}", headers=bearer(t), json={"expected_version": 2, "request_id": str(uuid.uuid4()), "title": "x", "model_config_id": second, "deleted": True})
    assert removed.status_code == 200 and removed.json()["deleted"]


def test_migration_0005_keeps_data(database_url, monkeypatch):
    """C-10: upgrading a 0004 database keeps shared data and only relaxes device_id."""
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine
    from sqlalchemy.engine import make_url

    name = f"migration_{uuid.uuid4().hex[:8]}"
    admin = create_engine(database_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as s:
        s.execute(text(f"CREATE DATABASE {name}"))
    url = make_url(database_url).set(database=name).render_as_string(hide_password=False)
    monkeypatch.setenv("T_AGNET_DATABASE_URL", url)
    monkeypatch.setenv("T_AGNET_ADMIN_PASSWORD", "test-password")
    monkeypatch.setenv("T_AGNET_JWT_SECRET", "test-jwt-secret-must-be-32-characters")
    cfg = Config("alembic.ini")
    engine = create_engine(url)
    try:
        command.upgrade(cfg, "20260926_0004")
        device, doc = uuid.uuid4(), uuid.uuid4()
        with engine.begin() as s:
            # Databases created before this change have NOT NULL columns.
            s.execute(text("ALTER TABLE shared_documents ALTER COLUMN device_id SET NOT NULL"))
            s.execute(text("ALTER TABLE shared_changes ALTER COLUMN device_id SET NOT NULL"))
            s.execute(text("INSERT INTO devices (device_id, label, public_key, capabilities, created_at) VALUES (:d, 'Mac', 'k', '[]', now())"), {"d": device})
            s.execute(text("INSERT INTO shared_documents (id, kind, device_id, version, data) VALUES (:id, 'conversation', :d, 3, '{\"title\": \"旧会话\"}')"), {"id": doc, "d": device})
        command.upgrade(cfg, "head")
        with engine.begin() as s:
            assert s.execute(text("SELECT data->>'title', version FROM shared_documents WHERE id = :id"), {"id": doc}).one() == ("旧会话", 3)
            nullable = s.execute(text("SELECT is_nullable FROM information_schema.columns WHERE table_name IN ('shared_documents', 'shared_changes') AND column_name = 'device_id'")).scalars().all()
            assert nullable == ["YES", "YES"]
            s.execute(text("INSERT INTO shared_documents (id, kind, device_id, version, data) VALUES (:id, 'cloud_model', NULL, 1, '{}')"), {"id": uuid.uuid4()})
        command.downgrade(cfg, "20260926_0004")
        with engine.begin() as s:
            assert s.execute(text("SELECT count(*) FROM shared_documents")).scalar() == 1
    finally:
        engine.dispose()
        with admin.connect() as s:
            s.execute(text(f"DROP DATABASE {name} WITH (FORCE)"))
        admin.dispose()
