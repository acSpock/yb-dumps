import os

from transformers import CLIPImageProcessor, CLIPModel


def main() -> None:
    model_id = os.getenv("GPU_MODEL_ID", "openai/clip-vit-base-patch32")
    cache_dir = os.getenv("GPU_MODEL_CACHE_DIR", os.getenv("TRANSFORMERS_CACHE", "/models/huggingface"))

    print(f"Downloading model_id={model_id} cache_dir={cache_dir}", flush=True)
    CLIPImageProcessor.from_pretrained(model_id, cache_dir=cache_dir)
    CLIPModel.from_pretrained(model_id, cache_dir=cache_dir)
    print("Model download complete", flush=True)


if __name__ == "__main__":
    main()
