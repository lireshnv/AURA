"""
AURA Voice Distress Detection — Phase 2, Step 1
Stratified Train / Val / Test Split

Splits data/processed/features.csv into 70/15/15 stratified by
distress_proxy_label (called 'distress_level' in the CSV).
Saves split clip IDs to data/features/splits.json.

Usage:
    python src/split_data.py
"""

import os
import json
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split

RANDOM_STATE = 42
FEATURES_CSV = os.path.join("data", "processed", "features.csv")
SPLITS_DIR = os.path.join("data", "features")
SPLITS_JSON = os.path.join(SPLITS_DIR, "splits.json")


def load_features():
    """Load features CSV and return DataFrame."""
    df = pd.read_csv(FEATURES_CSV)
    # Use 'filename' as clip_id (unique identifier per clip)
    df["clip_id"] = df["filename"]
    return df


def create_splits(df):
    """
    Stratified 70/15/15 split on distress_level.

    First split: 70% train, 30% temp
    Second split: 50/50 on temp → 15% val, 15% test
    """
    labels = df["distress_level"]

    train_ids, temp_ids, _, temp_labels = train_test_split(
        df["clip_id"],
        labels,
        test_size=0.30,
        stratify=labels,
        random_state=RANDOM_STATE,
    )

    val_ids, test_ids = train_test_split(
        temp_ids,
        test_size=0.50,
        stratify=temp_labels,
        random_state=RANDOM_STATE,
    )

    splits = {
        "train": sorted(train_ids.tolist()),
        "val": sorted(val_ids.tolist()),
        "test": sorted(test_ids.tolist()),
    }
    return splits


def main():
    df = load_features()
    print(f"Total clips: {len(df)}")
    print(f"Class distribution:\n{df['distress_level'].value_counts().to_string()}\n")

    splits = create_splits(df)

    os.makedirs(SPLITS_DIR, exist_ok=True)
    with open(SPLITS_JSON, "w") as f:
        json.dump(splits, f, indent=2)

    print("Split sizes:")
    for k, v in splits.items():
        subset = df[df["clip_id"].isin(v)]
        dist = subset["distress_level"].value_counts().to_dict()
        print(f"  {k:>5}: {len(v):>3} clips  {dist}")

    print(f"\nSaved to {SPLITS_JSON}")


if __name__ == "__main__":
    main()
