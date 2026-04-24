#!/usr/bin/env python3
"""
MJPEG HTTP camera server for Peeqo.
Captures from /dev/video0 via ffmpeg and serves:
  GET /stream   — multipart/x-mixed-replace MJPEG stream for live view
  GET /snapshot — single JPEG frame for still capture

Control via stdin: 'start', 'stop', 'snapshot'
Responses on stdout: 'ready', 'started', 'stopped', 'snapshot:<path>', 'snapshot:error'
"""
import subprocess, http.server, threading, sys, time

PORT = 8765
DEVICE = '/dev/video0'
WIDTH, HEIGHT, FPS = 640, 480, 15

_lock = threading.Lock()
_latest_frame = None
_ffmpeg_proc = None
_streaming = False


def _read_frames(proc):
    global _latest_frame
    buf = b''
    while True:
        chunk = proc.stdout.read(65536)
        if not chunk:
            break
        buf += chunk
        # Extract complete JPEG frames (SOI=\xff\xd8 ... EOI=\xff\xd9)
        while True:
            start = buf.find(b'\xff\xd8')
            if start == -1:
                buf = b''
                break
            end = buf.find(b'\xff\xd9', start + 2)
            if end == -1:
                buf = buf[start:]  # keep partial frame, wait for more data
                break
            with _lock:
                _latest_frame = buf[start:end + 2]
            buf = buf[end + 2:]


def start_capture():
    global _ffmpeg_proc, _streaming, _latest_frame
    if _streaming:
        return
    _latest_frame = None
    _ffmpeg_proc = subprocess.Popen(
        ['ffmpeg', '-loglevel', 'error',
         '-f', 'v4l2', '-input_format', 'mjpeg',
         '-video_size', f'{WIDTH}x{HEIGHT}', '-framerate', str(FPS),
         '-i', DEVICE,
         '-f', 'image2pipe', '-vcodec', 'copy', '-'],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    _streaming = True
    threading.Thread(target=_read_frames, args=(_ffmpeg_proc,), daemon=True).start()
    sys.stderr.write('[camera_server] capture started\n')
    sys.stderr.flush()


def stop_capture():
    global _ffmpeg_proc, _streaming, _latest_frame
    _streaming = False
    if _ffmpeg_proc:
        _ffmpeg_proc.terminate()
        _ffmpeg_proc = None
    _latest_frame = None
    sys.stderr.write('[camera_server] capture stopped\n')
    sys.stderr.flush()


class MJPEGHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # suppress per-request logs

    def do_GET(self):
        if self.path.startswith('/stream'):
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            try:
                while _streaming:
                    with _lock:
                        frame = _latest_frame
                    if frame:
                        self.wfile.write(
                            b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + frame + b'\r\n'
                        )
                        self.wfile.flush()
                    time.sleep(1 / FPS)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif self.path.startswith('/snapshot'):
            with _lock:
                frame = _latest_frame
            if frame:
                self.send_response(200)
                self.send_header('Content-Type', 'image/jpeg')
                self.send_header('Content-Length', str(len(frame)))
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(frame)
            else:
                self.send_error(503, 'No frame available')
        else:
            self.send_error(404)


server = http.server.HTTPServer(('127.0.0.1', PORT), MJPEGHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()
print('ready', flush=True)
sys.stderr.write(f'[camera_server] HTTP server on port {PORT}\n')
sys.stderr.flush()

for line in sys.stdin:
    cmd = line.strip()
    if cmd == 'start':
        start_capture()
        print('started', flush=True)
    elif cmd == 'stop':
        stop_capture()
        print('stopped', flush=True)
    elif cmd == 'snapshot':
        with _lock:
            frame = _latest_frame
        if frame:
            snap_path = '/tmp/peeqo_snapshot.jpg'
            with open(snap_path, 'wb') as f:
                f.write(frame)
            print(f'snapshot:{snap_path}', flush=True)
        else:
            print('snapshot:error', flush=True)
