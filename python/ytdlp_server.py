#!/usr/bin/env python3
"""
Persistent yt-dlp server.

Reads YouTube video IDs (one per line) from stdin.
Writes direct stream URLs (one per line) to stdout — empty line on failure.

Keeping this process alive means Python and yt-dlp start only once rather than
once per request, eliminating ~300–500ms of interpreter startup per video search.
"""
import sys

try:
    import yt_dlp
except ImportError:
    sys.stderr.write("[ytdlp_server] yt_dlp module not found — install with: pip3 install yt-dlp\n")
    sys.stderr.flush()
    sys.exit(1)

YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "extractor_args": {"youtube": {"player_client": ["android"]}},
    "format": "best[height<=480][ext=mp4]/best[height<=480]/best",
    "socket_timeout": 15,
}


def get_url(video_id):
    try:
        with yt_dlp.YoutubeDL(YDL_OPTS) as ydl:
            info = ydl.extract_info(
                f"https://www.youtube.com/watch?v={video_id}",
                download=False,
            )
            url = info.get("url", "")
            if not url:
                for fmt in info.get("requested_formats", []):
                    if fmt.get("url"):
                        url = fmt["url"]
                        break
            return url or ""
    except Exception as e:
        sys.stderr.write(f"[ytdlp_server] {video_id}: {e}\n")
        sys.stderr.flush()
        return ""


sys.stderr.write("[ytdlp_server] ready\n")
sys.stderr.flush()

for line in sys.stdin:
    video_id = line.strip()
    if video_id:
        print(get_url(video_id), flush=True)
