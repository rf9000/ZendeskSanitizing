ARG PYTHON_SLIM_DIGEST
FROM python:3.12-slim@${PYTHON_SLIM_DIGEST}
ARG GLINER_MODEL_ID
ARG GLINER_MODEL_REVISION
ENV GLINER_MODEL_ID=${GLINER_MODEL_ID} \
    GLINER_MODEL_REVISION=${GLINER_MODEL_REVISION} \
    HF_HOME=/opt/hf
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
RUN python -c "from gliner import GLiNER; import os; GLiNER.from_pretrained(os.environ['GLINER_MODEL_ID'], revision=os.environ['GLINER_MODEL_REVISION'])"
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1
COPY app.py /app/app.py
WORKDIR /app
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
