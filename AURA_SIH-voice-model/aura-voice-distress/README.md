# AURA Voice/Speech Distress Detection

This module takes an audio clip (e.g. from an IVRS call or app note) and computes a 0-100 `Voice Distress Sub-Score` using interpretable, hand-crafted acoustic features. It then validates this score using a deep representation cross-check (`wav2vec2`) to flag low confidence anomalies.

## Running the API

1. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```
2. **Start the FastAPI server**:
   ```bash
   uvicorn api.main:app --reload
   ```
   The models will load into memory on startup (takes ~2 seconds).
3. **Run the presentation demo script**:
   ```bash
   python tests/demo_script.py
   ```
4. **Run the API integration tests**:
   ```bash
   python tests/test_api.py
   ```

### API Endpoints
- `POST /v1/voice/analyse/upload`: Upload a file directly via `multipart/form-data` with fields `session_id` and `file`.
- `POST /v1/voice/analyse`: Provide a JSON payload with `session_id` and `audio_url`.

**cURL Example**:
```bash
curl -X POST "http://127.0.0.1:8000/v1/voice/analyse/upload" \
  -H "accept: application/json" \
  -H "Content-Type: multipart/form-data" \
  -F "session_id=12345" \
  -F "file=@tests/sample_clips/sample_high.wav"
```
