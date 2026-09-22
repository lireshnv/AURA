"""
AURA Voice Distress Detection — Phase 2, Step 4
Tier B: wav2vec2 Embedding Cross-Check Classifier

Extracts pooled embeddings from facebook/wav2vec2-base-960h (mean-pool
last hidden state), caches them, and trains a lightweight classifier
(LogisticRegression vs. 2-layer MLP — picks the better one on val).

Falls back to CPU if no GPU available, with batched inference.

Usage:
    python src/train_tier_b.py
"""

import os
import json
import pickle
import time
import warnings

import numpy as np
import pandas as pd
import torch
import librosa
from transformers import Wav2Vec2Model, Wav2Vec2Processor
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    classification_report,
    confusion_matrix,
)

warnings.filterwarnings("ignore", category=FutureWarning)

# ── Paths ──────────────────────────────────────────────────────────────
FEATURES_CSV = os.path.join("data", "processed", "features.csv")
SPLITS_JSON = os.path.join("data", "features", "splits.json")
AUDIO_DIR = os.path.join("data", "raw")  # resampled 16kHz clips
MODELS_DIR = "models"
EMBEDDINGS_DIR = os.path.join("data", "features")
EMBEDDINGS_FILE = os.path.join(EMBEDDINGS_DIR, "embeddings.npy")
EMBED_INDEX_FILE = os.path.join(EMBEDDINGS_DIR, "embedding_clip_ids.json")

MODEL_NAME = "facebook/wav2vec2-base-960h"
RANDOM_STATE = 42
BATCH_SIZE = 1
TARGET_SR = 16000


def extract_embeddings():
    """
    Extract wav2vec2 embeddings for all clips, cache to disk.
    Mean-pools the last hidden state across time → one 768-d vector per clip.
    """
    if os.path.exists(EMBEDDINGS_FILE) and os.path.exists(EMBED_INDEX_FILE):
        print("Cached embeddings found, loading...")
        embeddings = np.load(EMBEDDINGS_FILE)
        with open(EMBED_INDEX_FILE) as f:
            clip_ids = json.load(f)
        print(f"Loaded {len(clip_ids)} embeddings of dim {embeddings.shape[1]}")
        return embeddings, clip_ids

    print(f"Loading {MODEL_NAME}...")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")

    processor = Wav2Vec2Processor.from_pretrained(MODEL_NAME)
    model = Wav2Vec2Model.from_pretrained(MODEL_NAME).to(device)
    model.eval()

    # Get all audio files
    df = pd.read_csv(FEATURES_CSV)
    df["clip_id"] = df["filename"]
    clip_ids = df["clip_id"].tolist()
    audio_paths = [os.path.join(AUDIO_DIR, cid) for cid in clip_ids]

    all_embeddings = []
    valid_clip_ids = []

    start_time = time.time()
    print(f"Extracting embeddings for {len(audio_paths)} clips (batch_size={BATCH_SIZE})...")

    for batch_start in range(0, len(audio_paths), BATCH_SIZE):
        batch_paths = audio_paths[batch_start:batch_start + BATCH_SIZE]
        batch_cids = clip_ids[batch_start:batch_start + BATCH_SIZE]

        waveforms = []
        valid_in_batch = []
        valid_cids_in_batch = []

        for path, cid in zip(batch_paths, batch_cids):
            try:
                # Use librosa to load, resample, and ensure mono
                waveform_np, _ = librosa.load(path, sr=TARGET_SR, mono=True)
                waveforms.append(waveform_np)
                valid_in_batch.append(True)
                valid_cids_in_batch.append(cid)
            except Exception as e:
                print(f"  Skipping {cid}: {e}")

        if not waveforms:
            continue

        # Process batch through wav2vec2
        inputs = processor(
            waveforms,
            sampling_rate=TARGET_SR,
            return_tensors="pt",
            padding=True,
            return_attention_mask=True
        ).to(device)

        with torch.no_grad():
            outputs = model(**inputs)
            # Mean-pool last hidden state: (batch, time, 768) → (batch, 768)
            hidden = outputs.last_hidden_state
            pooled = hidden.mean(dim=1)
            batch_embeds = pooled.cpu().numpy()

        all_embeddings.append(batch_embeds)
        valid_clip_ids.extend(valid_cids_in_batch)

        n_done = min(batch_start + BATCH_SIZE, len(audio_paths))
        elapsed = time.time() - start_time
        print(f"  [{n_done}/{len(audio_paths)}] {elapsed:.1f}s elapsed")

    embeddings = np.vstack(all_embeddings)
    elapsed = time.time() - start_time
    print(f"\nExtraction complete: {embeddings.shape[0]} clips × {embeddings.shape[1]}d "
          f"in {elapsed:.1f}s ({elapsed / len(valid_clip_ids):.2f}s per clip)")

    # Cache
    os.makedirs(EMBEDDINGS_DIR, exist_ok=True)
    np.save(EMBEDDINGS_FILE, embeddings)
    with open(EMBED_INDEX_FILE, "w") as f:
        json.dump(valid_clip_ids, f, indent=2)
    print(f"Embeddings cached to {EMBEDDINGS_FILE}")

    return embeddings, valid_clip_ids


def train_tier_b():
    """Train Tier B classifier on wav2vec2 embeddings."""
    os.makedirs(MODELS_DIR, exist_ok=True)

    # Load embeddings
    embeddings, embed_clip_ids = extract_embeddings()

    # Load labels + splits
    df = pd.read_csv(FEATURES_CSV)
    df["clip_id"] = df["filename"]

    with open(SPLITS_JSON) as f:
        splits = json.load(f)

    # Build lookup: clip_id → embedding index
    cid_to_idx = {cid: i for i, cid in enumerate(embed_clip_ids)}

    # Use the same label encoder as Tier A for consistency
    le = pickle.load(open(os.path.join(MODELS_DIR, "label_encoder.pkl"), "rb"))

    def get_Xy(split_ids):
        """Get embedding matrix and label vector for a split."""
        indices = [cid_to_idx[cid] for cid in split_ids if cid in cid_to_idx]
        X = embeddings[indices]
        labels = df[df["clip_id"].isin([embed_clip_ids[i] for i in indices])]["distress_level"].values
        y = le.transform(labels)
        return X, y

    X_train, y_train = get_Xy(splits["train"])
    X_val, y_val = get_Xy(splits["val"])
    X_test, y_test = get_Xy(splits["test"])

    print(f"\nTier B data: train={len(X_train)}, val={len(X_val)}, test={len(X_test)}")

    # Scale embeddings (important for LogReg & MLP)
    scaler_b = StandardScaler()
    X_train = scaler_b.fit_transform(X_train)
    X_val = scaler_b.transform(X_val)
    X_test = scaler_b.transform(X_test)

    pickle.dump(scaler_b, open(os.path.join(MODELS_DIR, "tier_b_scaler.pkl"), "wb"))

    # ── Candidate 1: Logistic Regression ───────────────────────────────
    lr = LogisticRegression(
        max_iter=1000,
        random_state=RANDOM_STATE,
        class_weight="balanced",
    )
    lr.fit(X_train, y_train)
    lr_val_f1 = f1_score(y_val, lr.predict(X_val), average="macro")
    print(f"LogisticRegression val macro F1: {lr_val_f1:.4f}")

    # ── Candidate 2: 2-layer MLP (input → 64 → 3) ─────────────────────
    mlp = MLPClassifier(
        hidden_layer_sizes=(64,),
        max_iter=500,
        random_state=RANDOM_STATE,
        early_stopping=True,
        validation_fraction=0.15,
    )
    mlp.fit(X_train, y_train)
    mlp_val_f1 = f1_score(y_val, mlp.predict(X_val), average="macro")
    print(f"MLP (64) val macro F1: {mlp_val_f1:.4f}")

    # Pick the better one
    if lr_val_f1 >= mlp_val_f1:
        chosen_model = lr
        chosen_name = "LogisticRegression"
        chosen_reason = (f"LogisticRegression ({lr_val_f1:.4f}) matched or beat "
                         f"MLP ({mlp_val_f1:.4f}) on val — simpler model preferred "
                         f"to reduce overfitting on small dataset.")
    else:
        chosen_model = mlp
        chosen_name = "MLP"
        chosen_reason = (f"MLP ({mlp_val_f1:.4f}) outperformed "
                         f"LogisticRegression ({lr_val_f1:.4f}) on val — "
                         f"non-linear head captures embedding structure better.")

    print(f"\n-> Chosen: {chosen_name}")
    print(f"  Reason: {chosen_reason}")

    # ── Evaluate on test set ───────────────────────────────────────────
    y_test_pred = chosen_model.predict(X_test)
    y_test_proba = chosen_model.predict_proba(X_test)

    acc = accuracy_score(y_test, y_test_pred)
    macro_f1 = f1_score(y_test, y_test_pred, average="macro")

    print("\n" + "=" * 60)
    print("TIER B — TEST SET EVALUATION")
    print("=" * 60)
    print(f"Accuracy:  {acc:.4f}")
    print(f"Macro F1:  {macro_f1:.4f}")
    print(f"\nClassification Report:")
    print(classification_report(y_test, y_test_pred, target_names=le.classes_))
    print("Confusion Matrix:")
    cm = confusion_matrix(y_test, y_test_pred)
    print(pd.DataFrame(cm, index=le.classes_, columns=le.classes_))

    # Save
    pickle.dump(chosen_model, open(os.path.join(MODELS_DIR, "tier_b_head.pkl"), "wb"))
    print(f"\nModel saved to models/tier_b_head.pkl")

    # Save metrics
    metrics = {
        "chosen_model": chosen_name,
        "chosen_reason": chosen_reason,
        "lr_val_f1": float(lr_val_f1),
        "mlp_val_f1": float(mlp_val_f1),
        "accuracy": float(acc),
        "macro_f1": float(macro_f1),
        "confusion_matrix": cm.tolist(),
        "class_names": list(le.classes_),
        "test_clip_ids": [cid for cid in splits["test"] if cid in cid_to_idx],
    }

    # Compute Tier B distress scores for agreement check later
    classes = list(le.classes_)
    idx_mod = classes.index("Moderate")
    idx_high = classes.index("High")
    tier_b_scores = (y_test_proba[:, idx_mod] * 50 + y_test_proba[:, idx_high] * 100).tolist()
    metrics["test_scores"] = tier_b_scores
    metrics["test_proba"] = y_test_proba.tolist()

    with open(os.path.join(MODELS_DIR, "tier_b_metrics.json"), "w") as f:
        json.dump(metrics, f, indent=2)
    print("Metrics saved to models/tier_b_metrics.json")


if __name__ == "__main__":
    train_tier_b()
