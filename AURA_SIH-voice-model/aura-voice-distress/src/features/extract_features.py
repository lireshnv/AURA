import librosa
import numpy as np
import parselmouth
from parselmouth.praat import call
import struct

def vad_segmentation(audio_data, sample_rate, frame_duration_ms=30, energy_threshold=0.01):
    """
    Applies simple energy-based VAD to segment speech from silence.
    Returns: speech_audio (np.array), speech_frames_count, silence_frames_count
    """
    if audio_data.dtype == np.int16:
        # Convert to float for energy calculation
        audio_float = audio_data.astype(np.float32) / 32768.0
    else:
        audio_float = audio_data

    frame_length = int(sample_rate * (frame_duration_ms / 1000.0))
    speech_frames = []
    
    num_speech = 0
    num_silence = 0
    
    for i in range(0, len(audio_float) - frame_length, frame_length):
        frame = audio_float[i:i + frame_length]
        energy = np.mean(frame**2)
        if energy > energy_threshold:
            speech_frames.extend(audio_data[i:i + frame_length])
            num_speech += 1
        else:
            num_silence += 1
            
    if len(speech_frames) == 0:
        return audio_data, 1, 0
        
    return np.array(speech_frames), num_speech, num_silence


def extract_features(audio_path):
    """
    Extracts paralinguistic features using librosa and parselmouth.
    """
    # 1. Load with librosa (resamples to 16kHz mono)
    sr = 16000
    y, _ = librosa.load(audio_path, sr=sr, mono=True)
    
    # Basic noise reduction / normalization
    y = librosa.util.normalize(y)
    y_int16 = np.int16(y * 32767)
    
    # 2. VAD Segmentation
    y_speech, n_speech, n_sil = vad_segmentation(y_int16, sr)
    
    # Calculate speech/pause stats
    total_frames = n_speech + n_sil
    pause_ratio = n_sil / total_frames if total_frames > 0 else 0
    # Approximate speech rate (onsets per second of speech)
    y_speech_float = y_speech.astype(np.float32) / 32767.0
    onsets = librosa.onset.onset_detect(y=y_speech_float, sr=sr)
    speech_duration = len(y_speech_float) / sr
    speech_rate = len(onsets) / speech_duration if speech_duration > 0 else 0
    mean_pause_length = (n_sil * 0.03) / (len(onsets) + 1) # very rough approximation
    
    # 3. Librosa Features (on speech only for better accuracy)
    mfccs = librosa.feature.mfcc(y=y_speech_float, sr=sr, n_mfcc=13)
    mfcc_mean = np.mean(mfccs, axis=1)
    mfcc_std = np.std(mfccs, axis=1)
    
    spectral_centroid = librosa.feature.spectral_centroid(y=y_speech_float, sr=sr)
    spectral_rolloff = librosa.feature.spectral_rolloff(y=y_speech_float, sr=sr)
    zcr = librosa.feature.zero_crossing_rate(y_speech_float)
    
    # 4. Parselmouth Features (Pitch, Jitter, Shimmer, HNR)
    # Save a temporary wav file for parselmouth to read
    import tempfile
    import scipy.io.wavfile as wav
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav.write(tmp.name, sr, y_int16)
        tmp_name = tmp.name
        
    try:
        snd = parselmouth.Sound(tmp_name)
        pitch = snd.to_pitch()
        pitch_values = pitch.selected_array['frequency']
        pitch_values = pitch_values[pitch_values > 0] # Filter out unvoiced
        
        pitch_mean = np.mean(pitch_values) if len(pitch_values) > 0 else 0
        pitch_std = np.std(pitch_values) if len(pitch_values) > 0 else 0
        pitch_range = (np.max(pitch_values) - np.min(pitch_values)) if len(pitch_values) > 0 else 0
        
        pointProcess = call(snd, "To PointProcess (periodic, cc)", 75.0, 600.0)
        jitter = call(pointProcess, "Get jitter (local)", 0.0, 0.0, 0.0001, 0.02, 1.3)
        shimmer = call([snd, pointProcess], "Get shimmer (local)", 0.0, 0.0, 0.0001, 0.02, 1.3, 1.6)
        
        harmonicity = call(snd, "To Harmonicity (cc)", 0.01, 75.0, 0.1, 1.0)
        hnr = call(harmonicity, "Get mean", 0, 0)
        
    except Exception as e:
        print(f"Parselmouth error on {audio_path}: {e}")
        pitch_mean, pitch_std, pitch_range, jitter, shimmer, hnr = 0, 0, 0, 0, 0, 0
    finally:
        import os
        os.remove(tmp_name)
        
    # Replace NaN or None from praat with 0
    jitter = jitter if not np.isnan(jitter) else 0
    shimmer = shimmer if not np.isnan(shimmer) else 0
    hnr = hnr if not np.isnan(hnr) else 0
    
    # Build feature dict
    features = {
        'pitch_mean': pitch_mean,
        'pitch_std': pitch_std,
        'pitch_range': pitch_range,
        'jitter': jitter,
        'shimmer': shimmer,
        'hnr': hnr,
        'speech_rate': speech_rate,
        'pause_ratio': pause_ratio,
        'mean_pause_length': mean_pause_length,
        'spectral_centroid_mean': np.mean(spectral_centroid),
        'spectral_rolloff_mean': np.mean(spectral_rolloff),
        'zcr_mean': np.mean(zcr)
    }
    
    for i in range(13):
        features[f'mfcc_{i+1}_mean'] = mfcc_mean[i]
        features[f'mfcc_{i+1}_std'] = mfcc_std[i]
        
    return features

if __name__ == "__main__":
    # Test on a dummy file
    import glob
    files = glob.glob("data/raw/*.wav")
    if files:
        print("Testing extraction on:", files[0])
        feats = extract_features(files[0])
        print("Features extracted successfully:", len(feats), "features.")
    else:
        print("No raw files found to test.")
