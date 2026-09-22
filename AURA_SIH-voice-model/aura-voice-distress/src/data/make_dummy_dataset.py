import numpy as np
import scipy.io.wavfile as wav
import os

def generate_tone(freq, duration_sec, sample_rate=16000, noise_level=0.01):
    t = np.linspace(0, duration_sec, int(sample_rate * duration_sec), endpoint=False)
    audio = np.sin(2 * np.pi * freq * t)
    # Add noise
    noise = np.random.normal(0, noise_level, len(t))
    audio = audio + noise
    # Add random pauses (simulate speech pauses)
    pause_starts = np.random.randint(0, len(t), size=2)
    pause_lengths = np.random.randint(0, int(sample_rate * 0.5), size=2)
    for start, length in zip(pause_starts, pause_lengths):
        audio[start:start+length] = 0
    # Normalize to 16-bit PCM
    audio_normalized = np.int16(audio / np.max(np.abs(audio)) * 32767)
    return audio_normalized

def create_dummy_ravdess(output_dir="data/raw"):
    os.makedirs(output_dir, exist_ok=True)
    sample_rate = 16000
    
    # RAVDESS emotion codes:
    # 01 = neutral, 02 = calm, 03 = happy, 04 = sad, 05 = angry, 06 = fearful, 07 = disgust, 08 = surprised
    # We will generate a few files for each to ensure our pipeline can map them.
    
    # Let's map frequency and noise to emotion just to have distinct features later:
    # Low distress (calm/neutral/happy): Lower frequency, lower noise
    # Moderate distress (sad/disgust): Moderate frequency, some noise
    # High distress (angry/fearful): Higher frequency, higher noise
    
    emotions = {
        "01": {"freq": 150, "noise": 0.05, "desc": "neutral"},
        "02": {"freq": 140, "noise": 0.05, "desc": "calm"},
        "03": {"freq": 160, "noise": 0.05, "desc": "happy"},
        "04": {"freq": 200, "noise": 0.1, "desc": "sad"},
        "05": {"freq": 350, "noise": 0.3, "desc": "angry"},
        "06": {"freq": 300, "noise": 0.3, "desc": "fearful"},
        "07": {"freq": 220, "noise": 0.1, "desc": "disgust"},
        "08": {"freq": 180, "noise": 0.1, "desc": "surprised"},
    }

    print("Generating dummy RAVDESS dataset...")
    count = 0
    for actor in range(1, 6): # 5 actors
        for emo_code, params in emotions.items():
            for repetition in ["01", "02"]: # 2 repetitions
                # Filename format: Modality-VocalChannel-Emotion-EmotionalIntensity-Statement-Repetition-Actor.wav
                # e.g., 03-01-01-01-01-01-01.wav
                filename = f"03-01-{emo_code}-01-01-{repetition}-{actor:02d}.wav"
                
                # Add some variance to freq and duration
                freq = params["freq"] + np.random.randint(-10, 10)
                duration = np.random.uniform(2.5, 4.0)
                
                audio = generate_tone(freq, duration, sample_rate, params["noise"])
                
                filepath = os.path.join(output_dir, filename)
                wav.write(filepath, sample_rate, audio)
                count += 1
    
    print(f"Generated {count} dummy files in {output_dir}.")

if __name__ == "__main__":
    create_dummy_ravdess(output_dir="data/raw")
