"""GLiNER PII span detector sidecar.

Returns character offsets as Python str indices (Unicode code points).
The TypeScript client translates them to UTF-16 via codePointToUtf16Map.
"""
import os

from fastapi import FastAPI
from gliner import GLiNER
from pydantic import BaseModel

MODEL_ID = os.environ["GLINER_MODEL_ID"]
REVISION = os.environ["GLINER_MODEL_REVISION"]

model = GLiNER.from_pretrained(MODEL_ID, revision=REVISION)
app = FastAPI()


class DetectRequest(BaseModel):
    text: str
    labels: list[str]
    threshold: float = 0.4


@app.get("/healthz")
def healthz() -> dict:
    return {"model_id": MODEL_ID, "revision": REVISION, "status": "ok"}


@app.post("/detect")
def detect(req: DetectRequest) -> dict:
    if not req.text:
        return {"spans": []}
    entities = model.predict_entities(req.text, req.labels, threshold=req.threshold)
    return {
        "spans": [
            {"start": e["start"], "end": e["end"], "label": e["label"], "score": float(e["score"])}
            for e in entities
        ]
    }
