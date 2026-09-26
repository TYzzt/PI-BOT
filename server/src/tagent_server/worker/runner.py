"""DeepAgents worker: claims queued cloud chat runs, streams answers into shared messages.

One run at a time per process; run several processes for parallelism. All document writes go through
the same advisory write lock and change() as the API, so cursors and events keep their ordering.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from tagent_server.config import Settings, utcnow
from tagent_server.routers.shared import TERMINAL, change
from tagent_server.sync_models import SharedDocument as Doc
from tagent_server.tasks_service import write_lock
from tagent_server.vault import Vault

logger = logging.getLogger("tagent_server.worker")
SNAPSHOT_SECONDS = 1.0

# Fixed, user-facing errors: provider responses, URLs and keys are never copied into messages or logs.
ERR_MODEL = "模型请求失败，请检查云端模型配置后重试"
ERR_KEY = "云端模型密钥不可用，请重新保存模型"
ERR_UNAVAILABLE = "云端模型不可用，请更换模型"
ERR_LOST = "云端执行中断，请重新提问"


@dataclass
class Job:
    run_id: uuid.UUID
    conversation_id: uuid.UUID
    assistant_id: uuid.UUID
    thread_id: str
    question: str
    history: list[dict]
    model: dict
    api_key: str
    handoff: dict | None
    cancel: threading.Event = field(default_factory=threading.Event)
    lost: threading.Event = field(default_factory=threading.Event)


SearchFactory = Callable[[Settings], object | None]
ModelFactory = Callable[[dict, str], object]


def default_search(settings: Settings):
    key = settings.tavily_api_key.get_secret_value().strip() if settings.tavily_api_key else ""
    if not key:
        return None
    from langchain_tavily import TavilySearch
    return TavilySearch(max_results=5, tavily_api_key=key)


def default_model(config: dict, api_key: str):
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(base_url=config["base_url"], api_key=api_key, model=config["model_id"], max_tokens=config["max_tokens"],
                      streaming=True, max_retries=0, timeout=180, use_responses_api=False)


def system_prompt(search: bool, handoff: dict | None) -> str:
    lines = [
        "你是 T-AGNET 的云端助手，用中文回答，除非用户要求其他语言。",
        f"今天是 {utcnow().date().isoformat()}（UTC）。",
        "你运行在云端，无法访问用户 Mac 上的项目、文件、终端或浏览器；需要本地代码时，请用户在 Mac 的项目会话里提问，或把可以分享的内容贴给你。",
        "你可以使用待办和虚拟文件工具整理思路，它们只存在于本次会话中，不是真实磁盘。",
        "需要最新信息时使用联网搜索，并在回答中注明来源链接。" if search else "当前没有启用联网搜索；涉及最新信息时，请说明你的信息可能过时。",
    ]
    if handoff:
        lines.append(f"本会话由 Mac 会话转来，开头的 {handoff['message_count']} 条消息是交接的共享聊天历史；原会话中的代码和工具结果没有带过来。")
    return "\n".join(lines)


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in content)
    return ""


class Worker:
    def __init__(self, settings: Settings, engine, *, worker_id: str | None = None, search: SearchFactory = default_search,
                 model: ModelFactory = default_model, checkpointer=None) -> None:
        self.settings = settings
        self.sessions = sessionmaker(bind=engine)
        self.worker_id = worker_id or f"worker-{uuid.uuid4()}"
        self.search_factory = search
        self.model_factory = model
        self.checkpointer = checkpointer
        self.stop = threading.Event()

    # ---- lifecycle -------------------------------------------------------------------------------
    def run_forever(self) -> None:
        logger.info("cloud worker started")
        while not self.stop.is_set():
            try:
                if not self.run_once():
                    self.stop.wait(self.settings.worker_poll_seconds)
            except Exception:
                logger.exception("cloud worker loop error")
                self.stop.wait(self.settings.worker_poll_seconds)
        logger.info("cloud worker stopped")

    def run_once(self) -> bool:
        self.expire_leases()
        job = self.claim()
        if job is None:
            return False
        self.execute(job)
        return True

    # ---- database transitions ---------------------------------------------------------------------
    def _lease(self) -> str:
        return (utcnow() + timedelta(seconds=self.settings.worker_lease_seconds)).isoformat()

    def expire_leases(self) -> int:
        now = utcnow()
        with self.sessions.begin() as s:
            write_lock(s)
            expired = [r for r in cloud_runs(s, "running") if datetime.fromisoformat(r.data.get("lease_until") or now.isoformat()) < now]
            for run in expired:
                finish(s, run, "interrupted", ERR_LOST)
        if expired:
            logger.info("cloud runs interrupted after lease expiry: %d", len(expired))
        return len(expired)

    def claim(self) -> Job | None:
        with self.sessions.begin() as s:
            write_lock(s)
            run = s.scalars(select(Doc).where(Doc.kind == "chat_run", Doc.device_id.is_(None), Doc.data["state"].astext == "queued")
                            .order_by(Doc.position).limit(1).with_for_update(skip_locked=True)).first()
            if run is None:
                return None
            conversation = s.get(Doc, uuid.UUID(run.data["conversation_id"]))
            model = s.get(Doc, uuid.UUID(conversation.data["model_config_id"])) if conversation else None
            run.data = {**run.data, "state": "running", "acked": True, "worker_id": self.worker_id, "lease_until": self._lease(), "error": None}
            run.version += 1
            change(s, run)
            messages = conversation_messages(s, conversation.id) if conversation else []
            sequence = max((m.data["sequence"] for m in messages), default=0)
            history = [{"role": m.data["role"], "content": m.data["content"]} for m in sorted(messages, key=lambda m: m.data["sequence"]) if m.data["sequence"] > 0 and m.data["content"]]
            question = s.get(Doc, uuid.UUID(run.data["message_id"]))
            if question is not None:
                question.version += 1
                question.data = {**question.data, "status": "completed", "sequence": sequence + 1}
                change(s, question)
            assistant = Doc(id=uuid.uuid4(), kind="message", device_id=None, version=1,
                            data={"conversation_id": str(conversation.id) if conversation else run.data["conversation_id"], "run_id": str(run.id), "role": "assistant", "content": "", "status": "running", "sequence": sequence + 2})
            s.add(assistant)
            s.flush()
            change(s, assistant)
            run.data = {**run.data, "assistant_message_id": str(assistant.id)}
            if conversation is None or conversation.data.get("deleted") or model is None or model.kind != "cloud_model" or model.data.get("deleted"):
                finish(s, run, "failed", ERR_UNAVAILABLE)
                return None
            try:
                api_key = Vault(self.settings.sync_key_file).open(model.data["secret"], str(model.id))
            except Exception:
                finish(s, run, "failed", ERR_KEY)
                return None
            return Job(run_id=run.id, conversation_id=conversation.id, assistant_id=assistant.id,
                       thread_id=f"{conversation.id}:{conversation.data.get('generation', 0)}", question=run.data["text"], history=history,
                       model=model.data["config"], api_key=api_key, handoff=conversation.data.get("handoff"))

    def snapshot(self, job: Job, content: str) -> None:
        with self.sessions.begin() as s:
            write_lock(s)
            run = s.get(Doc, job.run_id)
            if run is None or run.data["state"] in TERMINAL or run.data.get("worker_id") != self.worker_id:
                job.lost.set()
                return
            if run.data.get("cancel_requested"):
                job.cancel.set()
            message = s.get(Doc, job.assistant_id)
            if message is not None and message.data["content"] != content:
                message.version += 1
                message.data = {**message.data, "content": content}
                change(s, message)

    def heartbeat(self, job: Job) -> None:
        with self.sessions.begin() as s:
            write_lock(s)
            run = s.get(Doc, job.run_id)
            if run is None or run.data["state"] in TERMINAL or run.data.get("worker_id") != self.worker_id:
                job.lost.set()
                return
            if run.data.get("cancel_requested"):
                job.cancel.set()
            # Lease renewal is internal bookkeeping; it does not bump the public version or emit events.
            run.data = {**run.data, "lease_until": self._lease()}

    def complete(self, job: Job, state: str, content: str, error: str | None = None) -> None:
        with self.sessions.begin() as s:
            write_lock(s)
            run = s.get(Doc, job.run_id)
            if run is None or run.data["state"] in TERMINAL or run.data.get("worker_id") != self.worker_id:
                return
            message = s.get(Doc, job.assistant_id)
            if message is not None:
                message.version += 1
                message.data = {**message.data, "content": content}
            finish(s, run, state, error)

    # ---- execution --------------------------------------------------------------------------------
    def execute(self, job: Job) -> None:
        interval = max(1.0, min(15.0, self.settings.worker_lease_seconds / 4))
        done = threading.Event()

        def beat():
            while not done.wait(interval):
                try:
                    self.heartbeat(job)
                except Exception:
                    logger.warning("cloud worker heartbeat failed")

        beater = threading.Thread(target=beat, name="tagent-worker-heartbeat", daemon=True)
        beater.start()
        text, state, error = "", "completed", None
        try:
            for text in self.stream(job):
                if job.cancel.is_set() or job.lost.is_set() or self.stop.is_set():
                    break
            if job.lost.is_set():
                return
            if job.cancel.is_set():
                state = "cancelled"
            elif self.stop.is_set():
                state, error = "interrupted", ERR_LOST
        except Exception:
            logger.warning("cloud run failed: model or tool error")
            state, error = "failed", ERR_MODEL
        finally:
            done.set()
            beater.join(timeout=5)
        self.complete(job, state, text, error)

    def stream(self, job: Job) -> Iterable[str]:
        """Yields the cumulative answer; writes a snapshot at most once per SNAPSHOT_SECONDS."""
        from deepagents import create_deep_agent
        from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage

        search = self.search_factory(self.settings)
        agent = create_deep_agent(model=self.model_factory(job.model, job.api_key), tools=[search] if search else [],
                                  system_prompt=system_prompt(search is not None, job.handoff), checkpointer=self.checkpointer)
        config = {"configurable": {"thread_id": job.thread_id}, "recursion_limit": 60}
        seeded = self.checkpointer is not None and self.checkpointer.get_tuple(config) is not None
        # A fresh thread (first question, or after an interrupted run) is rebuilt from the shared history.
        prior = [] if seeded else [HumanMessage(m["content"]) if m["role"] == "user" else AIMessage(m["content"]) for m in job.history]
        text, current, last_flush = "", None, 0.0
        for chunk, metadata in agent.stream({"messages": [*prior, HumanMessage(job.question)]}, config, stream_mode="messages"):
            if not isinstance(chunk, AIMessageChunk) or metadata.get("langgraph_checkpoint_ns", "").count("|") > 0:
                continue
            piece = text_of(chunk.content)
            if not piece:
                continue
            if current is not None and chunk.id != current and text:
                text += "\n\n"
            current = chunk.id
            text += piece
            if time.monotonic() - last_flush >= SNAPSHOT_SECONDS:
                self.snapshot(job, text)
                last_flush = time.monotonic()
            yield text
        if not text:
            state = agent.get_state(config).values.get("messages", []) if self.checkpointer is not None else []
            final = next((m for m in reversed(state) if isinstance(m, AIMessage) and text_of(m.content)), None)
            text = text_of(final.content) if final else ""
            yield text


def cloud_runs(s: Session, state: str) -> list[Doc]:
    return s.scalars(select(Doc).where(Doc.kind == "chat_run", Doc.device_id.is_(None), Doc.data["state"].astext == state)).all()


def conversation_messages(s: Session, conversation_id: uuid.UUID) -> list[Doc]:
    return s.scalars(select(Doc).where(Doc.kind == "message", Doc.device_id.is_(None), Doc.data["conversation_id"].astext == str(conversation_id))).all()


def finish(s: Session, run: Doc, state: str, error: str | None) -> None:
    """Terminal transition. Anything but a clean completion starts a new checkpoint thread next time."""
    run.data = {**run.data, "state": state, "error": error, "lease_until": None}
    run.version += 1
    change(s, run)
    message_id = run.data.get("assistant_message_id")
    message = s.get(Doc, uuid.UUID(message_id)) if message_id else None
    if message is not None:
        message.version += 1
        message.data = {**message.data, "status": state}
        change(s, message)
    if state != "completed":
        conversation = s.get(Doc, uuid.UUID(run.data["conversation_id"]))
        if conversation is not None:
            conversation.data = {**conversation.data, "generation": conversation.data.get("generation", 0) + 1}
