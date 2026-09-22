import os
import pickle
import numpy as np
import xgboost as xgb
import torch
import librosa
from transformers import Wav2Vec2Model, Wav2Vec2Processor
import warnings
import json

import sys
sys.path.append(os.path.abspath('.'))

from src.features.extract_features import extract_features
from src.explain import format_explanation
from src.agreement_check import check_agreement
from api.schemas import AnalyseResponse, TopFactor

# Global models
tier_a_model = None
scaler = None
imputer = None
le = None
feature_cols = None
explainer = None
tier_b_head = None
w2v_model = None
w2v_processor = None
agreement_cfg = None

MODELS_DIR = "models"
TARGET_SR = 16000

def load_models():
    global tier_a_model, scaler, imputer, le, feature_cols, explainer
    global tier_b_head, w2v_model, w2v_processor, agreement_cfg

    print("Loading Tier A models...")
    tier_a_model = xgb.XGBClassifier()
    tier_a_model.load_model(os.path.join(MODELS_DIR, "tier_a_xgb.json"))
    
    scaler = pickle.load(open(os.path.join(MODELS_DIR, "tier_a_scaler.pkl"), "rb"))
    imputer = pickle.load(open(os.path.join(MODELS_DIR, "tier_a_imputer.pkl"), "rb"))
    le = pickle.load(open(os.path.join(MODELS_DIR, "label_encoder.pkl"), "rb"))
    feature_cols = pickle.load(open(os.path.join(MODELS_DIR, "feature_columns.pkl"), "rb"))
    explainer = pickle.load(open(os.path.join(MODELS_DIR, "shap_explainer.pkl"), "rb"))

    print("Loading Tier B models...")
    tier_b_head = pickle.load(open(os.path.join(MODELS_DIR, "tier_b_head.pkl"), "rb"))
    w2v_processor = Wav2Vec2Processor.from_pretrained("facebook/wav2vec2-base-960h")
    w2v_model = Wav2Vec2Model.from_pretrained("facebook/wav2vec2-base-960h")
    w2v_model.eval()

    print("Loading agreement config...")
    with open(os.path.join(MODELS_DIR, "agreement_analysis.json")) as f:
        cfg = json.load(f)
        agreement_cfg = cfg["default_threshold"]

def _process_tier_b(audio_path: str) -> float:
    waveform_np, _ = librosa.load(audio_path, sr=TARGET_SR, mono=True)
    inputs = w2v_processor([waveform_np], sampling_rate=TARGET_SR, return_tensors="pt", padding=True, return_attention_mask=True)
    
    with torch.no_grad():
        outputs = w2v_model(**inputs)
        pooled = outputs.last_hidden_state.mean(dim=1)
        embed = pooled.numpy()
        
    probs = tier_b_head.predict_proba(embed)[0]
    idx_mod = list(le.classes_).index("Moderate")
    idx_high = list(le.classes_).index("High")
    score = probs[idx_mod] * 50 + probs[idx_high] * 100
    return float(score), probs

def run_inference(audio_path: str, session_id: str) -> AnalyseResponse:
    # 1. Extract Tier A features (handles VAD, normalize, and extraction internally)
    try:
        raw_features = extract_features(audio_path)
    except Exception as e:
        return AnalyseResponse(
            session_id=session_id,
            voice_distress_subscore=None,
            confidence="low",
            tier_ab_agreement=0.0,
            top_factors=[],
            flags=["low_confidence", "feature_extraction_failed"],
            model_version="v1.0",
            message=str(e)
        )
        
    # Check for short clips based on extracted speech features
    # If jitter is exactly 0, it means Praat failed to find voicing
    if raw_features.get('jitter', 0) == 0:
         return AnalyseResponse(
            session_id=session_id,
            voice_distress_subscore=None,
            confidence="low",
            tier_ab_agreement=0.0,
            top_factors=[],
            flags=["low_confidence", "silence_or_no_voice"],
            model_version="v1.0",
            message="No speech detected in audio."
        )
        
    # 7 & 8. Tier A prediction
    feat_vector = np.array([raw_features.get(c, 0.0) for c in feature_cols]).reshape(1, -1)
    
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        feat_scaled = scaler.transform(imputer.transform(feat_vector))
        
    probs_a = tier_a_model.predict_proba(feat_scaled)[0]
    idx_mod = list(le.classes_).index("Moderate")
    idx_high = list(le.classes_).index("High")
    score_a = probs_a[idx_mod] * 50 + probs_a[idx_high] * 100
    
    # 9. Tier B prediction
    score_b, probs_b = _process_tier_b(audio_path)
    
    # 10. Agreement check
    agr = check_agreement(score_a, probs_b, threshold=agreement_cfg, label_classes=list(le.classes_))
    
    flags = []
    confidence = "high"
    if agr["low_confidence"]:
        confidence = "low"
        flags.append("low_confidence")
        
    # 11. Explain prediction
    top_factors = []
    if confidence == "high":
        shap_vals = explainer.shap_values(feat_scaled)
        if isinstance(shap_vals, list):
            sv = shap_vals[idx_high][0]
        else:
            sv = shap_vals[0, :, idx_high]
            
        top_indices = np.argsort(np.abs(sv))[-4:][::-1]
        from src.explain import FEATURE_HUMAN_LABELS
        for idx in top_indices:
            feat_name = feature_cols[idx]
            shap_val = float(sv[idx])
            top_factors.append(TopFactor(
                feature=feat_name,
                human_label=FEATURE_HUMAN_LABELS.get(feat_name, feat_name),
                contribution=round(shap_val, 2),
                direction="increases_distress" if shap_val > 0 else "decreases_distress"
            ))
            
    # 12. Return
    return AnalyseResponse(
        session_id=session_id,
        voice_distress_subscore=int(round(score_a)),
        confidence=confidence,
        tier_ab_agreement=float(agr["agreement_score"]),
        top_factors=top_factors,
        flags=flags,
        model_version="v1.0"
    )
