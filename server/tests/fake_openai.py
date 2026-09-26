"""A tiny OpenAI-compatible chat completions endpoint for worker tests.

Behaviour is keyed off the latest user message:
- contains "搜索" and a search tool is offered: first returns a tool call, then answers from the tool result
- contains "慢": streams many small chunks slowly (for snapshots and cancellation)
- contains "失败": responds 500 with a provider-style error body
- otherwise answers with the question and all earlier user questions it can see
"""
import json
import socket
import threading
import time
import uuid

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

PROVIDER_SECRET_ERROR = "upstream-internal-error-do-not-leak"


def text(content) -> str:
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content or ""


class FakeOpenAI:
    def __init__(self) -> None:
        self.requests: list[dict] = []
        app = FastAPI()

        @app.post("/v1/chat/completions")
        async def completions(request: Request):
            body = await request.json()
            self.requests.append(body)
            return self.respond(body)

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def __enter__(self):
        self.thread.start()
        while not self.server.started:
            time.sleep(0.05)
        return self

    def __exit__(self, *_):
        self.server.should_exit = True
        self.thread.join(timeout=5)

    def respond(self, body: dict):
        messages = body["messages"]
        users = [text(m["content"]) for m in messages if m["role"] == "user"]
        last = messages[-1]
        question = users[-1] if users else ""
        tools = [t["function"]["name"] for t in body.get("tools", [])]
        if "失败" in question and last["role"] == "user":
            return JSONResponse({"error": {"message": PROVIDER_SECRET_ERROR}}, status_code=500)
        if last["role"] == "user" and "搜索" in question and "tavily_search" in tools:
            return self.tool_call(body, "tavily_search", {"query": question})
        if last["role"] == "tool":
            chunks = ["根据搜索结果：", text(last["content"])[:200]]
            return self.stream(body, chunks, 0.01)
        if "慢" in question:
            return self.stream(body, [f"第{i}段。" for i in range(60)], 0.1)
        earlier = "；".join(users[:-1]) or "无"
        return self.stream(body, ["收到：", question, f"。之前问过：{earlier}"], 0.01)

    def stream(self, body: dict, chunks: list[str], delay: float):
        id = f"chatcmpl-{uuid.uuid4().hex}"
        def frames():
            for piece in chunks:
                yield "data: " + json.dumps({"id": id, "object": "chat.completion.chunk", "created": 0, "model": body["model"],
                                             "choices": [{"index": 0, "delta": {"role": "assistant", "content": piece}, "finish_reason": None}]}) + "\n\n"
                time.sleep(delay)
            yield "data: " + json.dumps({"id": id, "object": "chat.completion.chunk", "created": 0, "model": body["model"],
                                         "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}) + "\n\n"
            yield "data: [DONE]\n\n"
        if body.get("stream"):
            return StreamingResponse(frames(), media_type="text/event-stream")
        return JSONResponse({"id": id, "object": "chat.completion", "created": 0, "model": body["model"],
                             "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(chunks)}, "finish_reason": "stop"}]})

    def tool_call(self, body: dict, name: str, args: dict):
        id, call = f"chatcmpl-{uuid.uuid4().hex}", f"call_{uuid.uuid4().hex[:12]}"
        def frames():
            yield "data: " + json.dumps({"id": id, "object": "chat.completion.chunk", "created": 0, "model": body["model"],
                                         "choices": [{"index": 0, "delta": {"role": "assistant", "content": None, "tool_calls": [
                                             {"index": 0, "id": call, "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]},
                                             "finish_reason": None}]}) + "\n\n"
            yield "data: " + json.dumps({"id": id, "object": "chat.completion.chunk", "created": 0, "model": body["model"],
                                         "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}) + "\n\n"
            yield "data: [DONE]\n\n"
        if body.get("stream"):
            return StreamingResponse(frames(), media_type="text/event-stream")
        return JSONResponse({"id": id, "object": "chat.completion", "created": 0, "model": body["model"], "choices": [{"index": 0, "message": {
            "role": "assistant", "content": None, "tool_calls": [{"id": call, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}, "finish_reason": "tool_calls"}]})
