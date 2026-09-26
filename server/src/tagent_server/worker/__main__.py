"""python -m tagent_server.worker"""
import logging
import signal

from langgraph.checkpoint.postgres import PostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from sqlalchemy import create_engine

from tagent_server.config import Settings
from tagent_server.realtime import _libpq_url
from tagent_server.worker.runner import Worker


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    for noisy in ("httpx", "httpcore", "openai", "sqlalchemy.engine"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    settings = Settings()
    engine = create_engine(settings.database_url, pool_pre_ping=True)
    pool = ConnectionPool(_libpq_url(settings.database_url), min_size=1, max_size=4, open=True,
                          kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row})
    try:
        checkpointer = PostgresSaver(pool)
        checkpointer.setup()
        worker = Worker(settings, engine, checkpointer=checkpointer)
        signal.signal(signal.SIGTERM, lambda *_: worker.stop.set())
        signal.signal(signal.SIGINT, lambda *_: worker.stop.set())
        worker.run_forever()
    finally:
        pool.close()
        engine.dispose()


if __name__ == "__main__":
    main()
