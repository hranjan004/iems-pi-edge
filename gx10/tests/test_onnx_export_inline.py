"""export_physical._inline_external_data: a model saved with a side
.onnx.data file (what torch's dynamo exporter does in the NGC images) comes
back as one self-contained file that ONNX Runtime loads on its own."""
from __future__ import annotations

import shutil
import sys

import pytest

onnx = pytest.importorskip("onnx")
ort = pytest.importorskip("onnxruntime")
pytest.importorskip("torch")
np = pytest.importorskip("numpy")
from onnx import TensorProto, helper, numpy_helper

from conftest import REPO, load_module


def tiny_model():
    w = numpy_helper.from_array(np.random.rand(18, 4).astype("float32"), name="W")
    node = helper.make_node("MatMul", ["window", "W"], ["p"])
    g = helper.make_graph([node], "t",
                          [helper.make_tensor_value_info("window", TensorProto.FLOAT, [1, 18])],
                          [helper.make_tensor_value_info("p", TensorProto.FLOAT, [1, 4])], [w])
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)])
    m.ir_version = 9            # what torch writes for opset 17; loadable by every ORT in use
    return m


def test_side_file_is_folded_back(tmp_path):
    sys.path.insert(0, str(REPO / "services/iems/training"))
    ex = load_module("export_physical", REPO / "services/iems/training/export_physical.py")
    path = tmp_path / "nilm_panel9.onnx"
    onnx.save_model(tiny_model(), str(path), save_as_external_data=True,
                    all_tensors_to_one_file=True, location=path.name + ".data", size_threshold=0)
    assert (tmp_path / (path.name + ".data")).exists()

    ex._inline_external_data(path)

    assert not (tmp_path / (path.name + ".data")).exists()
    moved = tmp_path / "elsewhere"; moved.mkdir()
    shutil.copy(path, moved / path.name)          # the file alone must be enough
    s = ort.InferenceSession(str(moved / path.name), providers=["CPUExecutionProvider"])
    out = s.run(None, {"window": np.ones((1, 18), "float32")})[0]
    assert out.shape == (1, 4)
