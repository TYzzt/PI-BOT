import asyncio
import logging
import threading

import psycopg
from sqlalchemy.engine import make_url

from tagent_server.tasks_service import NOTIFY_CHANNEL

logger = logging.getLogger(__name__)


def _libpq_url(database_url: str) -> str:
    return make_url(database_url).set(drivername="postgresql").render_as_string(hide_password=False)


class ChangeHub:
    """监听 PostgreSQL NOTIFY 并唤醒 WebSocket 连接；通知不携带数据，订阅者总是回数据库读取。"""

    def __init__(self, database_url: str) -> None:
        self._url = _libpq_url(database_url)
        self._subscribers: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="tagent-change-hub", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=10):
            logger.warning("change listener not ready")

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def subscribe(self) -> asyncio.Event:
        event = asyncio.Event()
        with self._lock:
            self._subscribers.add((asyncio.get_running_loop(), event))
        return event

    def unsubscribe(self, event: asyncio.Event) -> None:
        with self._lock:
            self._subscribers = {item for item in self._subscribers if item[1] is not event}

    def wake_all(self) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for loop, event in subscribers:
            try:
                loop.call_soon_threadsafe(event.set)
            except RuntimeError:
                continue

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                with psycopg.connect(self._url, autocommit=True) as connection:
                    connection.execute(f"LISTEN {NOTIFY_CHANNEL}")
                    self._ready.set()
                    self.wake_all()
                    while not self._stop.is_set():
                        for _ in connection.notifies(timeout=1.0):
                            self.wake_all()
            except psycopg.Error:
                logger.warning("change listener disconnected")
                self._stop.wait(1.0)
