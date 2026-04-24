#!/usr/bin/env python3
"""
openWakeWord detector for Peeqo.

Reads raw 16-bit PCM mono 16kHz audio from stdin (piped from Node.js/arecord),
runs openWakeWord inference, and prints "WAKEWORD" to stdout when the keyword
is detected. Errors go to stderr so Node.js can log them without confusion.

Usage:
    python3 wakeword.py --model /path/to/peeqo.onnx [--threshold 0.5]

If --model is omitted, openWakeWord's built-in models are used (useful for
testing the pipeline before a custom "Peeqo" model is trained).

Audio format expected on stdin:
    - Sample rate: 16000 Hz
    - Encoding:    Signed 16-bit little-endian (S16_LE)
    - Channels:    1 (mono)
"""

import sys
import select
import argparse
import time
import numpy as np

CHUNK_SAMPLES = 1280          # 80 ms at 16 kHz — openWakeWord's required frame size
CHUNK_BYTES   = CHUNK_SAMPLES * 2  # int16 = 2 bytes per sample

# How long after a detection to ignore further triggers.
DETECTION_COOLDOWN_SEC = 2.0

# If stdin is silent for this long, the pipe was disconnected (response is playing).
# When data resumes, we treat it as a reconnect and flush stale audio.
RECONNECT_DRY_SEC = 0.5

# How long after a pipe reconnect to ignore triggers.
# Prevents the ~1s of buffered audio that built up during the response from
# immediately re-triggering the wakeword.
RECONNECT_COOLDOWN_SEC = 1.5


def parse_args():
    parser = argparse.ArgumentParser(description="openWakeWord stdin detector")
    parser.add_argument("--model",     default=None,  help="Path to .onnx model file")
    parser.add_argument("--threshold", default=0.5,   type=float,
                        help="Detection score threshold (0.0–1.0, default 0.5)")
    return parser.parse_args()


def load_model(model_path):
    try:
        from openwakeword.model import Model
    except ImportError:
        print("[wakeword] ERROR: openwakeword not installed. Run: pip3 install openwakeword",
              file=sys.stderr, flush=True)
        sys.exit(1)

    try:
        if model_path:
            print(f"[wakeword] loading model: {model_path}", file=sys.stderr, flush=True)
            model = Model(wakeword_models=[model_path], inference_framework="onnx")
        else:
            print("[wakeword] no model specified — using openWakeWord built-in models "
                  "(for testing only; train a Peeqo model for production)",
                  file=sys.stderr, flush=True)
            model = Model(inference_framework="onnx")
    except Exception as e:
        print(f"[wakeword] ERROR loading model: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

    return model


def drain_stdin():
    """
    Non-blocking drain of all immediately available stdin data.
    Returns the number of bytes discarded.
    """
    flushed = 0
    while True:
        ready, _, _ = select.select([sys.stdin.buffer], [], [], 0.0)
        if not ready:
            break
        data = sys.stdin.buffer.read1(65536)
        if not data:
            break
        flushed += len(data)
    return flushed


def reset_model(model):
    """
    Clear the model's rolling prediction buffer.
    After a reconnect, this prevents stale high-confidence frames from the
    previous session from immediately contributing to a new detection.
    """
    try:
        for name in model.prediction_buffer:
            model.prediction_buffer[name].clear()
    except Exception:
        pass


def run(model, threshold):
    print("[wakeword] ready, listening on stdin", file=sys.stderr, flush=True)

    # Drain any audio that accumulated while the model was loading (~8–15s).
    # Without this, the first 1–2s of stale audio causes an immediate false trigger.
    flushed = drain_stdin()
    if flushed:
        print(f"[wakeword] drained {flushed} startup bytes from stdin",
              file=sys.stderr, flush=True)

    buf = bytearray()
    last_detection_time = 0.0
    last_data_time = time.time()  # treat startup as "just connected"

    while True:
        # Use select() with a short timeout instead of blocking read().
        # This lets us detect when stdin goes dry (pipe disconnected during response).
        try:
            ready, _, _ = select.select([sys.stdin.buffer], [], [], 0.2)
        except Exception as e:
            print(f"[wakeword] select error: {e}", file=sys.stderr, flush=True)
            break

        if not ready:
            continue  # no data, keep polling

        try:
            chunk = sys.stdin.buffer.read1(4096)
        except Exception as e:
            print(f"[wakeword] read error: {e}", file=sys.stderr, flush=True)
            break

        if not chunk:
            break  # stdin closed — Node process ended

        now = time.time()
        gap = now - last_data_time
        last_data_time = now

        if gap > RECONNECT_DRY_SEC:
            # The pipe was disconnected and just reconnected.
            # The mic accumulated ~1s of audio while we were idle; drain it all
            # so we don't process stale speech at CPU speed and false-trigger.
            flushed = drain_stdin()
            reset_model(model)
            # Set last_detection_time so cooldown expires RECONNECT_COOLDOWN_SEC from now.
            # Formula: now - DETECTION_COOLDOWN_SEC + RECONNECT_COOLDOWN_SEC
            last_detection_time = now - DETECTION_COOLDOWN_SEC + RECONNECT_COOLDOWN_SEC
            buf = bytearray()
            print(f"[wakeword] reconnect — drained {flushed} bytes, "
                  f"{RECONNECT_COOLDOWN_SEC}s cooldown",
                  file=sys.stderr, flush=True)
            continue  # skip this triggering chunk too

        buf.extend(chunk)

        # Process all complete 80 ms frames available in the buffer
        while len(buf) >= CHUNK_BYTES:
            frame_bytes = bytes(buf[:CHUNK_BYTES])
            buf = buf[CHUNK_BYTES:]

            audio = np.frombuffer(frame_bytes, dtype=np.int16)

            try:
                scores = model.predict(audio)
            except Exception as e:
                print(f"[wakeword] inference error: {e}", file=sys.stderr, flush=True)
                continue

            now = time.time()
            if now - last_detection_time < DETECTION_COOLDOWN_SEC:
                continue  # still in cooldown, skip this frame

            for keyword, score in scores.items():
                if score >= threshold:
                    print(f"[wakeword] detected '{keyword}' (score {score:.2f})",
                          file=sys.stderr, flush=True)
                    last_detection_time = now
                    sys.stdout.write("WAKEWORD\n")
                    sys.stdout.flush()
                    break  # one detection per frame is enough


if __name__ == "__main__":
    args = parse_args()
    model = load_model(args.model)
    run(model, args.threshold)
