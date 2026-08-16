# 一次性把 PyTorch 版 bge-small-zh-v1.5 转成 ONNX（Transformers.js 只认 .onnx）。
# 用法（在项目根目录，需 Python 3.9+）：
#   pip install optimum[onnxruntime] transformers
#   python scripts/convert_bge_onnx.py
# 产出：models/bge-small-zh-onnx/{ model.onnx, config.json, tokenizer.json, ... }
import os
from optimum.onnxruntime import ORTModelForFeatureExtraction
from transformers import AutoTokenizer

SRC = os.path.join("BAAI--bge-small-zh-v1.5", "snapshots", "master")  # 你已下载的 PyTorch 模型目录
DST = os.path.join("models", "bge-small-zh-onnx")

os.makedirs(DST, exist_ok=True)

model = ORTModelForFeatureExtraction.from_pretrained(SRC, export=True)
model.save_pretrained(DST)

tok = AutoTokenizer.from_pretrained(SRC)
tok.save_pretrained(DST)

print("converted OK ->", os.path.abspath(DST))
