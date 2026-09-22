# AURA Voice Distress Module: Presentation Guide

This document is designed to help you explain the Voice/Speech-Based Distress Detection module to the MoSJE Hackathon judges.

---

## 1. The Big Picture: How the System Works
When a victim or witness leaves a voice note or speaks on an IVRS call, the system processes their voice to detect signs of distress. **Crucially, it does not listen to *what* they are saying (the words), it listens to *how* they are saying it (the acoustics).**

The system operates in a **Two-Tier Architecture**:
1. **Tier A (The Explainer):** This is the main model (an XGBoost Classifier). It extracts specific, measurable features from the human voice (like pitch or shakiness) and scores the distress from 0 to 100. It also provides a human-readable explanation of exactly *why* it gave that score using SHAP.
2. **Tier B (The Cross-Check):** This is a deep-learning neural network (`wav2vec2` by Facebook/Meta) that acts as a "second opinion." It listens to the raw audio waveform and generates its own probability. 
3. **The Agreement Gate:** If Tier A and Tier B agree, the system outputs the score. If they disagree significantly (divergence > 0.25), the system flags the clip as `[LOW CONFIDENCE]` and recommends that a human counselor review it manually. This ensures the AI is safe and does not hallucinate scores.

---

## 2. The Features: What is the Model Actually Measuring?
The Tier A model looks at **38 specific acoustic features** (also known as Paralinguistic features). These are grouped into four main categories:

### A. Prosody (Pitch & Intonation)
When people are in distress, their voice pitch often changes.
* **Pitch Mean:** The average frequency of the voice. (Distress often raises the pitch).
* **Pitch Range & Variability:** Is the voice highly expressive, or is it flat and monotone? (Extreme trauma or depression can cause a "flattened" affect, making the voice monotone).

### B. Voice Quality (Micro-tremors)
These are tiny, involuntary muscle spasms in the vocal cords caused by adrenaline, fear, or crying.
* **Jitter:** Micro-instabilities in voice frequency (the voice sounds "shaky").
* **Shimmer:** Micro-instabilities in voice loudness (the amplitude wavers).
* **HNR (Harmonic-to-Noise Ratio):** Measures how "clear" vs "breathy/hoarse" the voice is.

### C. Temporal Features (Rhythm & Pauses)
Distress deeply affects how people pace their speech.
* **Speech Rate:** Syllables spoken per second. (Panic can cause rushed speech; trauma can cause very slow speech).
* **Pause Ratio:** What percentage of the audio is dead silence? 
* **Mean Pause Length:** How long are the gaps between words? (Victims recalling traumatic events often take long, heavy pauses).

### D. Spectral Features (Energy & Texture)
These measure the "shape" of the sound using advanced signal processing (MFCCs).
* **Spectral Centroid:** The "brightness" of the sound.
* **MFCCs 1-13:** 13 different data points that map the physical shape of the speaker's vocal tract. It captures the complex texture of a sigh, a gasp, or a strained voice.

---

## 3. How to Explain the Output (The SHAP Values)
When you show the judges the output, highlight the **Explainability Factors**. 

Because this is a tool for the *Prevention of Atrocities Act*, a "black-box" AI that just says "Distress: 80/100" is dangerous and unhelpful to counselors. 

Instead, our model uses **SHAP** (SHapley Additive exPlanations) to break down the score. It tells the counselor exactly what it heard, for example:
> *"I scored this an 80/100 because I detected a highly elevated pause ratio (+14 points) and significant voice micro-tremors (Jitter) (+10 points)."*

This transforms the AI from an opaque "decision maker" into a **transparent decision-support tool**, providing objective acoustic data to human counselors!

---

## 4. How to Demo and Test the System

### Option A: The Presentation Demo (Recommended for the Hackathon)
This is a polished script built specifically for your presentation. It takes 3 sample audio clips (one low distress, one moderate, one high), processes them through the AI pipeline, and prints out a beautiful, human-readable UI block with the final fused score.
**Run this command:**
```bash
python tests/demo_script.py
```

### Option B: The Backend Automated Tests
This runs the API integration test. It spins up a test server, uploads the clips over an HTTP POST request, validates the JSON responses, and times the latency to prove the system is fast.
**Run this command:**
```bash
python tests/test_api.py
```

### Option C: Test the Live API Server (via cURL or Swagger)
If you want to actually start the web server and test it like a real frontend application would:
**1. Start the server:**
```bash
uvicorn api.main:app --reload
```
**2. Open your browser:**
Navigate to `http://127.0.0.1:8000/docs` to see the interactive Swagger UI. You can upload an audio file directly from your browser!

**3. Or use cURL (in a new terminal):**
```bash
curl -X POST "http://127.0.0.1:8000/v1/voice/analyse/upload" \
  -H "accept: application/json" \
  -H "Content-Type: multipart/form-data" \
  -F "session_id=12345" \
  -F "file=@tests/sample_clips/sample_high.wav"
```
