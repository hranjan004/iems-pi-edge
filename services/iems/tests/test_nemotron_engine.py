"""Nemotron NILM engine: the prompt contract, answer parsing, the engine's
round trip against a fake OpenAI server, and the disaggregator using it with
per-head BiLSTM fallback."""
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from iems.inference import nemotron_engine as NE  # noqa: E402
from iems.inference.nemotron_prompt import (build_messages, format_answer,  # noqa: E402
                                            parse_answer)
from iems.tests.test_pipeline_solar import synth_rows  # noqa: E402

FEATS = ["Panel3 (Kitchen)", "Panel1 (HVAC)", "Panel2 (H2O)", "VrmsA", "VrmsB", "I31", "I32",
         "F1", "Grid Power", "Shop", "I11", "I21", "tod_sin", "tod_cos", "sun_elev",
         "csky_ghi", "pv_power", "pv_valid"]
HEADS = ["refrigerator", "microwave", "dishwasher"]


def window(own=300.0):
    X = np.zeros((100, len(FEATS)))
    X[:, 0] = own
    X[40:60, 0] = own + 1100           # a microwave-sized burst around the middle
    X[:, 1], X[:, 2], X[:, 3] = 2000, 100, 121
    h = 18
    X[:, 12], X[:, 13] = np.sin(2 * np.pi * h / 24), np.cos(2 * np.pi * h / 24)
    X[:, 14], X[:, 15] = 5.0, 200.0
    return X


class TestPrompt(unittest.TestCase):
    def test_prompt_is_deterministic_and_complete(self):
        a = build_messages(3, window(), FEATS, HEADS)
        b = build_messages(3, window(), FEATS, HEADS)
        self.assertEqual(a, b)
        user = a[1]["content"]
        self.assertIn("Panel3 (Kitchen)", user)
        self.assertIn("local hour 18:00", user)
        self.assertIn("Appliances: refrigerator, microwave, dishwasher.", user)
        own_line = [l for l in user.splitlines() if l.startswith("Own panel watts")][0]
        self.assertEqual(len(own_line.split(":")[1].split()), 50)   # every 2nd of 100

    def test_answer_round_trip(self):
        st = {"refrigerator": 1, "microwave": 0, "dishwasher": 1}
        self.assertEqual(parse_answer(format_answer(st, HEADS), HEADS), st)

    def test_parse_reads_comma_separated_replies(self):
        self.assertEqual(parse_answer("refrigerator=ON, microwave=OFF, dishwasher=ON", HEADS),
                         {"refrigerator": 1, "microwave": 0, "dishwasher": 1})

    def test_parse_is_tolerant_but_never_invents(self):
        txt = "<think>hmm</think>\nRefrigerator = on\nmicrowave: OFF\nbogus=ON"
        self.assertEqual(parse_answer(txt, HEADS),
                         {"refrigerator": 1, "microwave": 0, "dishwasher": None})


class FakeNilm(BaseHTTPRequestHandler):
    answer = "refrigerator=ON\nmicrowave=ON\ndishwasher=OFF\ndryer=ON"
    seen = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeNilm.seen.append(req)
        heads = req["messages"][1]["content"].split("Appliances: ")[1].rstrip(".").split(", ")
        lines = [l for l in FakeNilm.answer.splitlines() if l.split("=")[0] in heads]
        if not lines:   # answer for every head of whatever panel asked
            lines = [f"{h}=OFF" for h in heads]
        b = json.dumps({"choices": [{"message": {"content": "\n".join(lines)}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


class TestEngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeNilm)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def test_raw_window_inverts_normalisation(self):
        norm = {"mean": list(range(len(FEATS))), "std": [2.0] * len(FEATS)}
        X = window()
        Z = ((X - np.array(norm["mean"])) / 2.0)[None]
        np.testing.assert_allclose(NE.raw_window(Z, norm), X, atol=1e-9)

    def test_predict_maps_answers_to_probabilities(self):
        NE.URL = self.url
        norm = {"features": FEATS, "heads": HEADS, "mean": [0.0] * len(FEATS),
                "std": [1.0] * len(FEATS)}
        probs, raw = NE.predict("Panel3 (Kitchen)", window()[None], norm)
        self.assertEqual(probs, {"refrigerator": NE.P_ON, "microwave": NE.P_ON,
                                 "dishwasher": 1 - NE.P_ON})
        self.assertFalse(FakeNilm.seen[-1]["chat_template_kwargs"]["enable_thinking"])

    def test_unreachable_server_gives_no_answers(self):
        NE.URL = "http://127.0.0.1:9/v1"
        NE.TIMEOUT = 1
        norm = {"features": FEATS, "heads": HEADS, "mean": [0.0] * len(FEATS),
                "std": [1.0] * len(FEATS)}
        probs, _ = NE.predict("Panel3 (Kitchen)", window()[None], norm)
        self.assertEqual(probs, {h: None for h in HEADS})

    def test_disaggregator_uses_nemotron_and_keeps_the_rules(self):
        try:
            import onnxruntime  # noqa
        except ImportError:
            self.skipTest("onnxruntime not installed")
        from iems.inference.onnx_disaggregator import disaggregate_panel_onnx
        NE.URL, NE.ENGINE, NE.TIMEOUT = self.url, "nemotron", 5
        try:
            rows = {ch: synth_rows(v) for ch, v in {
                "Panel1 (HVAC)": 2000, "Panel2 (H2O)": 100, "Panel3 (Kitchen)": 300,
                "Shop": 50, "VrmsA": 120, "VrmsB": 120, "I31": 5, "I32": 5, "F1": 60,
                "Grid Power": 1500, "I11": 10, "I21": 10,
                "Current on Utility Tie": 8}.items()}
            weather = {"outside_temp_f": 70, "irradiance_6h_avg": 300, "cloud_cover_pct": 20}
            res = disaggregate_panel_onnx("Panel3 (Kitchen)", rows, weather, write_to_anylog=False)
        except FileNotFoundError:
            self.skipTest("panel3 ONNX model not present")
        finally:
            NE.ENGINE = "bilstm"
        self.assertTrue(res.model.startswith("nemotron:"), res.model)
        rec = res.reconciled
        self.assertEqual(rec["refrigerator"]["engine"], "nemotron")
        self.assertEqual(rec["refrigerator"]["state"], 1)     # 300 W panel can hold a fridge
        # dryer answered ON, but a ~300 W panel cannot hold a 1 kW+ dryer: the
        # power gate still vetoes it after Nemotron, exactly as after the BiLSTM
        self.assertEqual(rec["dryer"]["engine"], "nemotron")
        self.assertEqual(rec["dryer"]["state"], 0)
        self.assertEqual(rec["dryer"].get("rule"), "power_gate_off")


if __name__ == "__main__":
    unittest.main(verbosity=2)
