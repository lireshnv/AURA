# AURA backend - built for a Hugging Face Docker Space (free CPU tier,
# 16 GB RAM), which is what TensorFlow/DeepFace/MediaPipe need.
FROM python:3.12-slim

# OpenCV/MediaPipe need libGL + glib; librosa/soundfile need libsndfile;
# ffmpeg decodes browser audio (webm/opus).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces run the container as uid 1000.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    AURA_ENV=production \
    TF_CPP_MIN_LOG_LEVEL=2
WORKDIR /home/user/app

COPY --chown=user requirements.txt requirements-voice.txt ./
# transformers is skipped: without torch it does nothing, and the voice-tone /
# text-emotion models already degrade gracefully to "unavailable".
RUN pip install --no-cache-dir --user -r requirements.txt \
    && grep -v "^transformers" requirements-voice.txt > /tmp/voice.txt \
    && pip install --no-cache-dir --user -r /tmp/voice.txt

COPY --chown=user . .

EXPOSE 7860
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
