# SnapAttend — container image.
#
# This packages the existing app as-is; it does not change what app.py or
# anything under src/ does. Build and run:
#
#   docker build -t snapattend .
#   docker run -p 8501:8501 -v "$(pwd)/.streamlit:/app/.streamlit:ro" snapattend
#
# The app reads its Supabase credentials from st.secrets (see
# .streamlit/secrets.toml.example) — mount your real secrets.toml at
# /app/.streamlit/secrets.toml as shown above; nothing here changes how the
# app itself loads configuration.

FROM python:3.11-slim

WORKDIR /app

# git: requirements.txt installs face_recognition_models straight from GitHub.
# libsndfile1 + ffmpeg: runtime audio decoding for librosa/soundfile.
# curl: used by the HEALTHCHECK below.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        libsndfile1 \
        ffmpeg \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8501

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl --fail http://localhost:8501/_stcore/health || exit 1

ENTRYPOINT ["streamlit", "run", "app.py", "--server.port=8501", "--server.address=0.0.0.0"]
