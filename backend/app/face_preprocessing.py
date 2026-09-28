"""Lightweight face detection, cropping and frame-quality validation.

Uses MediaPipe's short-range face detector (fast, CPU-friendly) to locate faces
before handing a cropped region to DeepFace. This avoids running the heavier
DeepFace backend detector on the full frame every request.
"""
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

from . import config

# Optional: a lightweight deployment installs without MediaPipe; frames are
# then rejected with reason "face_analysis_unavailable" rather than the whole
# backend failing to start.
try:
    import mediapipe as mp
except ImportError:  # pragma: no cover - depends on the install profile
    mp = None

FACE_ANALYSIS_AVAILABLE = mp is not None

if mp is not None:
    _mp_face_detection = mp.solutions.face_detection
    _detector = _mp_face_detection.FaceDetection(
        model_selection=0,  # short-range model, optimized for close-up webcam faces
        min_detection_confidence=config.FACE_DETECTION_CONFIDENCE,
    )
    # Second-pass fallback at a lower bar, tried ONLY when the primary
    # detector finds nothing at all. This raises recall in imperfect
    # lighting/angle frames without lowering the bar for the common case:
    # the blur/brightness/face-size quality gates below are what keep a
    # marginal detection from turning into a bad reading, not the detection
    # confidence itself.
    _detector_lenient = _mp_face_detection.FaceDetection(
        model_selection=0,
        min_detection_confidence=max(0.25, config.FACE_DETECTION_CONFIDENCE - 0.25),
    )


@dataclass
class FaceBox:
    x: int
    y: int
    w: int
    h: int


@dataclass
class PreprocessResult:
    ok: bool
    reason: Optional[str] = None
    face_crop: Optional[np.ndarray] = None
    blur_score: float = 0.0
    brightness: float = 0.0
    face_area_ratio: float = 0.0
    face_count: int = 0


def _detect_faces(image_bgr: np.ndarray):
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    result = _detector.process(rgb)
    detections = result.detections
    if not detections:
        # Fall back to the lenient detector rather than reporting no_face
        # outright - a real face just missed the primary bar (poor lighting,
        # a slight turn), and the quality gates further down still have the
        # final say on whether this frame is usable.
        result = _detector_lenient.process(rgb)
        detections = result.detections
    if not detections:
        return []

    h, w = image_bgr.shape[:2]
    boxes = []
    for det in detections:
        bbox = det.location_data.relative_bounding_box
        x = int(bbox.xmin * w)
        y = int(bbox.ymin * h)
        bw = int(bbox.width * w)
        bh = int(bbox.height * h)
        x = max(0, x)
        y = max(0, y)
        bw = max(1, min(bw, w - x))
        bh = max(1, min(bh, h - y))
        boxes.append(FaceBox(x, y, bw, bh))
    return boxes


def _crop_with_padding(image: np.ndarray, box: FaceBox) -> np.ndarray:
    h, w = image.shape[:2]
    pad_x = int(box.w * config.FACE_CROP_PADDING)
    pad_y = int(box.h * config.FACE_CROP_PADDING)

    x1 = max(0, box.x - pad_x)
    y1 = max(0, box.y - pad_y)
    x2 = min(w, box.x + box.w + pad_x)
    y2 = min(h, box.y + box.h + pad_y)

    crop = image[y1:y2, x1:x2]
    return cv2.resize(crop, (config.FACE_RESIZE_DIM, config.FACE_RESIZE_DIM))


def _blur_score(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _brightness(gray: np.ndarray) -> float:
    return float(gray.mean())


def quality_score(blur: float, brightness: float) -> float:
    """Combines blur and brightness into a single 0-100 image-quality score."""
    blur_component = min(100.0, (blur / config.BLUR_THRESHOLD) * 50.0)
    brightness_component = max(0.0, 100.0 - abs(brightness - 128.0) / 128.0 * 100.0)
    return round(blur_component * 0.5 + brightness_component * 0.5, 1)


def quality_label(score: float) -> str:
    if score >= 70:
        return "good"
    if score >= 40:
        return "acceptable"
    return "poor"


def visibility_score(face_area_ratio: float) -> float:
    """0-100 score for how prominently the face fills the frame."""
    target_ratio = 0.30
    return round(min(100.0, (face_area_ratio / target_ratio) * 100.0), 1)


def normalize_lighting(face_bgr: np.ndarray, brightness: float) -> np.ndarray:
    """Contrast-limited histogram equalization (CLAHE), applied ONLY when the
    crop is genuinely under- or over-exposed.

    Deliberately conservative, for two reasons:

    * CLAHE on the L channel redistributes existing luminance - it recovers
      detail that is present but compressed into a narrow range. It does not
      synthesize detail that was never captured.

    * Sharpening / unsharp-masking is deliberately NOT applied on the
      inference path. Sharpening a blurry face fabricates edges, and those
      invented edges would land directly on the landmark positions the whole
      expression measurement depends on. A genuinely blurry frame is rejected
      by the quality gate instead of being "rescued" into a confident but
      fictional reading.

    A well-exposed crop is returned untouched, so the common case is free.
    """
    if config.CLAHE_MIN_BRIGHTNESS <= brightness <= config.CLAHE_MAX_BRIGHTNESS:
        return face_bgr

    lab = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(
        clipLimit=config.CLAHE_CLIP_LIMIT,
        tileGridSize=(config.CLAHE_TILE_GRID, config.CLAHE_TILE_GRID),
    )
    merged = cv2.merge((clahe.apply(l_channel), a_channel, b_channel))
    return cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)


def preprocess_frame(image_bgr: np.ndarray) -> PreprocessResult:
    """Runs the full validation pipeline on a raw camera frame.

    Returns a PreprocessResult with ok=False and a human-readable reason when
    the frame should be rejected, otherwise ok=True with the cropped face image.
    """
    if not FACE_ANALYSIS_AVAILABLE:
        return PreprocessResult(ok=False, reason="face_analysis_unavailable")

    faces = _detect_faces(image_bgr)

    if len(faces) == 0:
        return PreprocessResult(ok=False, reason="no_face", face_count=0)

    if len(faces) > 1:
        return PreprocessResult(ok=False, reason="multiple_faces", face_count=len(faces))

    box = faces[0]
    frame_h, frame_w = image_bgr.shape[:2]
    frame_area = frame_h * frame_w
    face_area = box.w * box.h
    face_area_ratio = face_area / frame_area if frame_area else 0.0

    if face_area_ratio < config.MIN_FACE_AREA_RATIO:
        return PreprocessResult(ok=False, reason="face_too_small", face_count=1, face_area_ratio=face_area_ratio)

    face_gray = cv2.cvtColor(image_bgr[box.y:box.y + box.h, box.x:box.x + box.w], cv2.COLOR_BGR2GRAY)
    if face_gray.size == 0:
        return PreprocessResult(ok=False, reason="no_face", face_count=1)

    brightness = _brightness(face_gray)
    if brightness < config.MIN_BRIGHTNESS:
        return PreprocessResult(
            ok=False, reason="too_dark", brightness=brightness, face_area_ratio=face_area_ratio, face_count=1
        )

    blur = _blur_score(face_gray)
    if blur <= config.BLUR_THRESHOLD:
        return PreprocessResult(
            ok=False,
            reason="too_blurry",
            blur_score=blur,
            brightness=brightness,
            face_area_ratio=face_area_ratio,
            face_count=1,
        )

    crop = _crop_with_padding(image_bgr, box)
    return PreprocessResult(
        ok=True,
        face_crop=crop,
        blur_score=blur,
        brightness=brightness,
        face_area_ratio=face_area_ratio,
        face_count=1,
    )
