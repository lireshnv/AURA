import os
import glob
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
from tqdm import tqdm
import sys

# Add src to path so we can import features
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from src.features.extract_features import extract_features

def map_emotion_to_distress(emotion_code):
    """
    RAVDESS mapping:
    Low: 01 (neutral), 02 (calm), 03 (happy), 08 (surprised)
    Moderate: 04 (sad), 07 (disgust)
    High: 05 (angry), 06 (fearful)
    """
    if emotion_code in ["01", "02", "03", "08"]:
        return "Low"
    elif emotion_code in ["04", "07"]:
        return "Moderate"
    elif emotion_code in ["05", "06"]:
        return "High"
    return "Unknown"

def process_dataset():
    raw_dir = "data/raw"
    processed_dir = "data/processed"
    os.makedirs(processed_dir, exist_ok=True)
    
    files = glob.glob(os.path.join(raw_dir, "*.wav"))
    print(f"Found {len(files)} files to process.")
    
    data = []
    for filepath in tqdm(files, desc="Extracting features"):
        filename = os.path.basename(filepath)
        # RAVDESS format: 03-01-emotion-intensity-statement-repetition-actor.wav
        parts = filename.replace(".wav", "").split("-")
        if len(parts) >= 7:
            emotion_code = parts[2]
            distress_level = map_emotion_to_distress(emotion_code)
        else:
            emotion_code = "Unknown"
            distress_level = "Unknown"
            
        try:
            feats = extract_features(filepath)
            feats['filename'] = filename
            feats['emotion_code'] = emotion_code
            feats['distress_level'] = distress_level
            feats['source_dataset'] = 'Dummy_RAVDESS'
            data.append(feats)
        except Exception as e:
            print(f"Failed processing {filename}: {e}")
            
    df = pd.DataFrame(data)
    csv_path = os.path.join(processed_dir, "features.csv")
    df.to_csv(csv_path, index=False)
    print(f"\nFeatures saved to {csv_path}")
    
    return df

def generate_plots(df):
    plots_dir = "data/processed/plots"
    os.makedirs(plots_dir, exist_ok=True)
    
    sns.set_theme(style="whitegrid")
    
    # Class balance
    plt.figure(figsize=(8, 5))
    sns.countplot(data=df, x="distress_level", order=["Low", "Moderate", "High"])
    plt.title("Class Balance of Distress Levels")
    plt.savefig(os.path.join(plots_dir, "class_balance.png"))
    plt.close()
    
    # Pitch variance by class
    plt.figure(figsize=(8, 5))
    sns.boxplot(data=df, x="distress_level", y="pitch_mean", order=["Low", "Moderate", "High"])
    plt.title("Pitch Mean by Distress Level")
    plt.savefig(os.path.join(plots_dir, "pitch_mean_by_class.png"))
    plt.close()
    
    # MFCC 1 mean by class
    plt.figure(figsize=(8, 5))
    sns.boxplot(data=df, x="distress_level", y="mfcc_1_mean", order=["Low", "Moderate", "High"])
    plt.title("MFCC 1 Mean by Distress Level")
    plt.savefig(os.path.join(plots_dir, "mfcc1_by_class.png"))
    plt.close()

    print(f"Plots saved to {plots_dir}")

if __name__ == "__main__":
    df = process_dataset()
    if not df.empty:
        generate_plots(df)
        
        print("\n--- Phase 1 Summary ---")
        print(f"Total processed files: {len(df)}")
        print("\nClass balance:")
        print(df['distress_level'].value_counts())
        print("\nSample of features.csv (first 3 rows):")
        # Print select columns for brevity
        cols_to_print = ['filename', 'distress_level', 'pitch_mean', 'jitter', 'speech_rate', 'mfcc_1_mean']
        print(df[cols_to_print].head(3))
