FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface \
    TRANSFORMERS_CACHE=/models/huggingface \
    GPU_MODEL_CACHE_DIR=/models/huggingface \
    GPU_MODEL_ID=openai/clip-vit-base-patch32 \
    GPU_MODEL_DEVICE=auto \
    GPU_MODEL_DTYPE=auto \
    GPU_PRELOAD_MODEL_ON_STARTUP=true \
    PORT=8080

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY scripts ./scripts

ARG PRELOAD_MODEL=true
RUN if [ "$PRELOAD_MODEL" = "true" ]; then python scripts/download_model.py; fi

EXPOSE 8080

CMD ["sh", "-c", "python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
