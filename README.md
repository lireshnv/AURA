# AURA — Real-Time Facial Emotion Analysis

Lightweight facial emotion analysis system. React/TypeScript frontend captures
webcam frames every 1-2 seconds; a FastAPI backend runs MediaPipe face
detection + DeepFace emotion classification and returns smoothed emotion and
sentiment scores.

## Backend

The virtual environment is kept **outside** the OneDrive-synced project folder
(`C:\Users\<you>\aura-backend-venv`) because OneDrive's live file sync locks
package files mid-install when a venv is created inside a synced directory,
causing `pip install` to fail with `WinError 32`.

```powershell
python -m venv C:\Users\<you>\aura-backend-venv
C:\Users\<you>\aura-backend-venv\Scripts\pip.exe install -r backend\requirements.txt
cd backend
C:\Users\<you>\aura-backend-venv\Scripts\uvicorn.exe app.main:app --reload --port 8000
```

API docs at http://localhost:8000/docs

## Frontend

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Grant camera permission and click **Start Analysis**.

## Architecture

The central design rule: **the final emotion is never `max(deepface_scores)`.**
DeepFace is one signal, fused with per-region facial geometry and temporal
behaviour. The fused distribution is what the dashboard, graph and report all
display; raw DeepFace output appears only in the diagnostics panel.

```
camera -> quality gate -> face crop -> CLAHE (only if badly exposed)
       -> eye-line alignment -> Face Mesh landmarks
       -> mouth / eyes / brows / midface geometry vs. PERSONAL baseline
       -> DeepFace emotion (one signal)
       -> temporal EMA of the evidence
       -> fusion -> final emotion -> sentiment / distress / reliability
```

| File | Role |
| --- | --- |
| `backend/app/face_preprocessing.py` | Detection, crop/pad/resize, blur + brightness gates, CLAHE lighting normalization |
| `backend/app/facial_features.py` | Face Mesh geometry by region, eye-line alignment, head pose (yaw/pitch/roll) |
| `backend/app/fusion.py` | Per-emotion region-weighted evidence, neutral evidence, fusion, explanations |
| `backend/app/emotion_engine.py` | DeepFace `actions=["emotion"]` only |
| `backend/app/smoothing.py` | Per-session baseline, evidence EMA, motion, history, expression events |
| `backend/app/reliability.py` | Reliability (observation trustworthiness), separate from confidence |
| `backend/app/distress_engine.py` | Session report + expression-based distress estimate |
| `backend/app/sentiment.py` | Fused distribution -> positive/neutral/negative |

### Why measurements are baseline-relative

Every geometric measurement is normalized (by inter-ocular distance) and then
compared against **the same user's own neutral baseline**, captured over the
first few valid frames of each session. Resting mouth shape, eye openness and
brow height vary enormously between people; without a personal baseline a
naturally downturned mouth would read as sadness.

Head pitch is baselined separately from expression geometry — it describes
where the head points, not what the face expresses.

### Tuning

All weights and thresholds live in `backend/app/config.py`:
`FUSION_WEIGHTS` (deepface / landmarks / temporal / quality), `REGION_WEIGHTS`
(mouth / eyes / brows / other), the per-signal gain constants, and the
head-pose trust ramp.

## Tests

```powershell
cd backend
C:\Users\<you>\aura-backend-venv\Scripts\python.exe -m tests.test_fusion     # fusion engine, no server needed
C:\Users\<you>\aura-backend-venv\Scripts\python.exe -m tests.test_live_api   # full HTTP path, server must be running
```

`test_fusion.py` asserts both directions that matter: a clear expression must
be able to outvote a neutral-leaning DeepFace read, **and** a genuinely still
face must remain Neutral. Passing only the first would mean the
neutral-dominance bug had simply been traded for the opposite bug.

## Scope and limits

- Emotion only. No face recognition, age, gender, race, or identity analysis.
- Raw video and frames are never written to disk; only numeric geometry and
  scores are held in memory for the active session.
- Outputs are **estimates of visible facial expression**, not measurements of
  inner emotional state, and the distress score is explicitly an
  expression-based estimate — not a clinical or diagnostic instrument.
- Blurry frames are rejected rather than sharpened. Sharpening would fabricate
  edges exactly where landmark positions are measured.
