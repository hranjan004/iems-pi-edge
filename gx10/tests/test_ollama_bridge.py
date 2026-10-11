"""Ollama-API bridge: message translation and a round trip against a fake
OpenAI server, the shape NIM / vLLM return."""
from __future__ import annotations

import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


def test_tool_call_arguments_become_json_strings(bridge):
    msgs = [{"role": "user", "content": "tables?"},
            {"role": "assistant", "content": "",
             "tool_calls": [{"function": {"name": "list_tables", "arguments": {"dbms": "customers"}}}]},
            {"role": "tool", "content": "[...]"}]
    out = bridge.to_openai_messages(msgs)
    call = out[1]["tool_calls"][0]
    assert call["type"] == "function"
    assert json.loads(call["function"]["arguments"]) == {"dbms": "customers"}
    assert out[2]["tool_call_id"] == call["id"]      # tool reply paired with the call


def test_openai_reply_becomes_ollama_message(bridge):
    choice = {"message": {"content": None, "tool_calls": [
        {"id": "c1", "function": {"name": "query", "arguments": "{\"sql\": \"select 1\"}"}}]}}
    m = bridge.to_ollama_message(choice)
    assert m["role"] == "assistant" and m["content"] == ""
    assert m["tool_calls"][0]["function"]["arguments"] == {"sql": "select 1"}


@pytest.fixture()
def fake_openai():
    seen = {}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, obj):
            b = json.dumps(obj).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            self._send({"data": [{"id": "nvidia/nemotron-3.5-lightning-30b-a3b"}]})

        def do_POST(self):
            seen["req"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            self._send({"choices": [{"message": {"content": "ready"}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 3, "completion_tokens": 1}})

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/v1", seen
    srv.shutdown()


def test_chat_round_trip(bridge, fake_openai):
    url, seen = fake_openai
    bridge.UPSTREAM = url
    r = bridge.chat({"model": "qwen2.5:3b-instruct", "options": {"temperature": 0.2},
                     "messages": [{"role": "user", "content": "hi"}]})
    assert r["message"]["content"] == "ready" and r["done"] is True
    assert seen["req"]["model"] == bridge.MODEL               # any caller name maps upstream
    assert seen["req"]["chat_template_kwargs"] == {"enable_thinking": False}
    assert seen["req"]["temperature"] == 0.2


def test_http_tags_lists_upstream_and_alias(bridge, fake_openai):
    url, _ = fake_openai
    bridge.UPSTREAM = url
    srv = ThreadingHTTPServer(("127.0.0.1", 0), bridge.H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        tags = json.loads(urllib.request.urlopen(
            f"http://127.0.0.1:{srv.server_address[1]}/api/tags", timeout=5).read())
        names = {m["name"] for m in tags["models"]}
        assert "nvidia/nemotron-3.5-lightning-30b-a3b" in names
        assert "nemotron-3.5-lightning" in names
    finally:
        srv.shutdown()
