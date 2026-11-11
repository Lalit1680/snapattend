"""Image decoding, normalisation and cropping.

Everything the vision pipelines need before a face model sees the pixels:

* **EXIF orientation.** Phone cameras record orientation in metadata rather than
  rotating pixels. Skipping ``exif_transpose`` means a class photo taken in
  portrait arrives sideways and dlib finds nothing — a genuinely confusing
  failure, so it is handled first.
* **Downscaling.** Detection cost scales with pixel count and a modern phone
  produces 12MP+. Downscaling to a bounded longest edge is the single biggest
  performance lever in the whole pipeline.
* **Blur measurement.** Variance of the Laplacian is a cheap, well-established
  sharpness proxy. Used to reject unusable enrollment selfies *with a helpful
  message* instead of silently storing a bad embedding.

No image produced here is ever written to disk by this module; callers hold the
array in memory and discard it.
"""
from __future__ import annotations

import base64
import binascii
import io
import logging
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

# Below this the Laplacian variance of a face-sized crop indicates motion blur or
# a bad focus lock. Tuned to be forgiving: we only want to catch clearly unusable
# frames, not second-guess a slightly soft webcam.
BLUR_VARIANCE_FLOOR = 45.0

_DATA_URL_PREFIXES = ("data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,")


class ImageDecodeError(ValueError):
    """The supplied bytes are not a usable image."""


@dataclass
class FaceBox:
    """A detected face rectangle, in the coordinate space of the processed image.

    Percentages are carried alongside the pixel values because the source photo
    is never persisted: a client that wants to draw the box over a re-rendered
    thumbnail needs resolution-independent coordinates.
    """

    top: int
    right: int
    bottom: int
    left: int
    image_width: int
    image_height: int

    @property
    def width(self) -> int:
        return max(0, self.right - self.left)

    @property
    def height(self) -> int:
        return max(0, self.bottom - self.top)

    @property
    def longest_edge(self) -> int:
        return max(self.width, self.height)

    def to_dict(self) -> dict:
        w = max(1, self.image_width)
        h = max(1, self.image_height)
        return {
            "top": self.top,
            "right": self.right,
            "bottom": self.bottom,
            "left": self.left,
            "width": self.width,
            "height": self.height,
            "x_pct": round(self.left / w, 5),
            "y_pct": round(self.top / h, 5),
            "w_pct": round(self.width / w, 5),
            "h_pct": round(self.height / h, 5),
        }


@dataclass
class LoadedImage:
    """A decoded, orientation-corrected, size-bounded RGB image."""

    rgb: np.ndarray                 # uint8, shape (H, W, 3)
    width: int
    height: int
    original_width: int
    original_height: int
    scale: float                    # processed / original (<= 1.0)
    warnings: list[str] = field(default_factory=list)

    @property
    def megapixels(self) -> float:
        return round((self.width * self.height) / 1_000_000, 2)


# --------------------------------------------------------------------------- #
# Decoding
# --------------------------------------------------------------------------- #
def decode_data_url(value: str) -> bytes:
    """Accept either a raw base64 string or a full ``data:`` URL.

    The browser capture components send data URLs; the test harness and CSV-style
    tooling send bare base64. Supporting both keeps the API forgiving without
    adding a second endpoint.
    """
    if not isinstance(value, str) or not value.strip():
        raise ImageDecodeError("Expected a base64 image string")
    text = value.strip()
    if text.startswith("data:"):
        _, _, text = text.partition(",")
        if not text:
            raise ImageDecodeError("Malformed data URL: no payload after the comma")
    # Restore padding some clients strip.
    padding = (-len(text)) % 4
    try:
        return base64.b64decode(text + ("=" * padding), validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ImageDecodeError(f"Could not base64-decode the image: {exc}") from exc


def load_image(data: bytes, *, max_dim: int) -> LoadedImage:
    """Decode ``data`` into a bounded RGB array, correcting EXIF orientation."""
    from PIL import Image, ImageOps, UnidentifiedImageError

    if not data:
        raise ImageDecodeError("The uploaded image is empty")

    try:
        with Image.open(io.BytesIO(data)) as img:
            # exif_transpose must run before any resize, or we would resize the
            # wrong axes and then rotate.
            img = ImageOps.exif_transpose(img)
            img = img.convert("RGB")
            original_width, original_height = img.size

            warnings: list[str] = []
            scale = 1.0
            longest = max(original_width, original_height)
            if longest > max_dim:
                scale = max_dim / float(longest)
                new_size = (
                    max(1, int(round(original_width * scale))),
                    max(1, int(round(original_height * scale))),
                )
                # LANCZOS preserves the high-frequency detail the face encoder
                # relies on far better than the default nearest-neighbour.
                img = img.resize(new_size, Image.LANCZOS)

            rgb = np.array(img, dtype=np.uint8)
    except UnidentifiedImageError as exc:
        raise ImageDecodeError("Unsupported or corrupt image file") from exc
    except OSError as exc:
        # Pillow raises OSError for truncated files.
        raise ImageDecodeError(f"Could not read the image: {exc}") from exc

    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ImageDecodeError("Expected a colour image")

    height, width = rgb.shape[:2]
    if min(width, height) < 64:
        raise ImageDecodeError(
            f"Image is only {width}x{height}px — too small to detect faces reliably"
        )

    return LoadedImage(
        rgb=rgb,
        width=width,
        height=height,
        original_width=original_width,
        original_height=original_height,
        scale=scale,
        warnings=warnings,
    )


# --------------------------------------------------------------------------- #
# Quality metrics
# --------------------------------------------------------------------------- #
def blur_variance(rgb: np.ndarray) -> float:
    """Variance of the Laplacian — higher is sharper.

    Uses OpenCV when available (fast, and the canonical implementation of this
    metric) and falls back to a small NumPy convolution otherwise so a missing
    cv2 degrades quality checks rather than breaking enrollment.
    """
    try:
        import cv2

        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())
    except Exception:  # pragma: no cover - cv2 missing or an unusual dtype
        gray = rgb.astype(np.float64) @ np.array([0.299, 0.587, 0.114])
        # 4-neighbour Laplacian via array shifts; equivalent to cv2's 3x3 kernel.
        lap = (
            -4.0 * gray[1:-1, 1:-1]
            + gray[:-2, 1:-1]
            + gray[2:, 1:-1]
            + gray[1:-1, :-2]
            + gray[1:-1, 2:]
        )
        return float(lap.var()) if lap.size else 0.0


def brightness(rgb: np.ndarray) -> float:
    """Mean luminance, 0-255. Catches "the webcam lens cap is on" cases."""
    return float(rgb.mean())


# --------------------------------------------------------------------------- #
# Cropping
# --------------------------------------------------------------------------- #
def crop_face(
    rgb: np.ndarray,
    box: FaceBox,
    *,
    margin: float = 0.28,
    output_size: int = 200,
    quality: int = 72,
) -> str:
    """Return a base64 JPEG of ``box`` with breathing room, for the review queue.

    A tightly-cropped face box is hard for a human to recognise, so the box is
    expanded before cropping — a teacher needs hair and jawline to identify a
    student. Output is deliberately small (200px, quality 72): it only has to be
    good enough for a person to recognise, and it is short-lived data we would
    rather keep minimal.
    """
    from PIL import Image

    height, width = rgb.shape[:2]
    pad_x = int(round(box.width * margin))
    pad_y = int(round(box.height * margin))

    left = max(0, box.left - pad_x)
    top = max(0, box.top - pad_y)
    right = min(width, box.right + pad_x)
    bottom = min(height, box.bottom + pad_y)
    if right <= left or bottom <= top:
        raise ImageDecodeError("Degenerate face box; cannot crop")

    crop = Image.fromarray(rgb[top:bottom, left:right])
    crop.thumbnail((output_size, output_size), Image.LANCZOS)

    buffer = io.BytesIO()
    crop.save(buffer, format="JPEG", quality=quality, optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def to_data_url(b64_jpeg: Optional[str]) -> Optional[str]:
    """Wrap stored base64 for direct use in an ``<img src>``."""
    if not b64_jpeg:
        return None
    return f"data:image/jpeg;base64,{b64_jpeg}"
