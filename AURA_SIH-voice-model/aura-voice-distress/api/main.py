from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import os
import tempfile
import traceback
import httpx

from api.schemas import AnalyseRequest, AnalyseResponse
from api.inference import load_models, run_inference

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load all ML models on startup
    print("Initializing AURA Voice Distress module...")
    load_models()
    print("Models loaded successfully. Ready for inference.")
    yield
    print("Shutting down...")

app = FastAPI(title="AURA Voice Distress Module API", lifespan=lifespan)

@app.get("/health")
def health_check():
    return {"status": "ok", "models_loaded": True, "model_version": "v1.0"}

async def download_audio(url: str, dest_path: str):
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            with open(dest_path, "wb") as f:
                f.write(response.content)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to download audio from URL: {str(e)}")

def validate_file_extension(filename: str):
    ext = os.path.splitext(filename)[1].lower()
    if ext not in [".wav", ".mp3", ".m4a"]:
        raise HTTPException(status_code=422, detail="Unsupported audio format. Use .wav, .mp3, or .m4a.")

def validate_file_size(file_path: str):
    size_mb = os.path.getsize(file_path) / (1024 * 1024)
    if size_mb > 25:
        raise HTTPException(status_code=422, detail="Audio file exceeds 25MB limit.")

@app.post("/v1/voice/analyse", response_model=AnalyseResponse)
async def analyse_url(request: AnalyseRequest):
    if not request.audio_url:
        raise HTTPException(status_code=422, detail="audio_url is required.")
        
    try:
        fd, temp_path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        
        # Download or use local file
        if request.audio_url.startswith("http"):
            await download_audio(request.audio_url, temp_path)
        else:
            if not os.path.exists(request.audio_url):
                raise HTTPException(status_code=422, detail="Local file not found.")
            validate_file_extension(request.audio_url)
            validate_file_size(request.audio_url)
            # Copy local to temp
            with open(request.audio_url, "rb") as fin, open(temp_path, "wb") as fout:
                fout.write(fin.read())
        
        response = run_inference(temp_path, request.session_id)
        return response
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail={"error": "Internal server error during processing.", "message": str(e)})
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

@app.post("/v1/voice/analyse/upload", response_model=AnalyseResponse)
async def analyse_upload(session_id: str = Form(...), file: UploadFile = File(...)):
    validate_file_extension(file.filename)
    
    try:
        fd, temp_path = tempfile.mkstemp(suffix=os.path.splitext(file.filename)[1])
        os.close(fd)
        
        # Read and write chunks to limit memory usage
        with open(temp_path, "wb") as buffer:
            size_bytes = 0
            while content := await file.read(1024 * 1024):  # 1MB chunks
                buffer.write(content)
                size_bytes += len(content)
                if size_bytes > 25 * 1024 * 1024:
                    raise HTTPException(status_code=422, detail="Audio file exceeds 25MB limit.")
        
        response = run_inference(temp_path, session_id)
        return response
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail={"error": "Internal server error during processing.", "message": str(e)})
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
