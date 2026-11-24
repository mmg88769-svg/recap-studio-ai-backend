#!/usr/bin/env python3
"""Local pipeline smoke test. No Gemini API key, upload, or Android required."""
import json, pathlib, subprocess, sys, tempfile

ROOT=pathlib.Path(__file__).resolve().parents[1]
def run(*args):
    return subprocess.run([str(a) for a in args],check=True,capture_output=True,text=True).stdout
def probe(path):
    return json.loads(run("ffprobe","-v","error","-show_entries","format=duration:stream=codec_type","-of","json",path))
def main():
    with tempfile.TemporaryDirectory() as td:
        p=pathlib.Path(td)
        video=p/"sample.mp4"; narration=p/"narration.wav"; out=p/"recap.mp4"; extracted=p/"evidence"
        run("ffmpeg","-nostdin","-loglevel","error","-y","-f","lavfi","-i","testsrc2=size=320x180:rate=15:duration=3","-f","lavfi","-i","sine=frequency=220:sample_rate=16000:duration=3","-c:v","mpeg4","-c:a","aac","-shortest",video)
        run("ffmpeg","-nostdin","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:sample_rate=16000:duration=2","-ac","1",narration)
        run(sys.executable,ROOT/"experimental/prepare_video.py",video,extracted,"--frames","4")
        manifest=json.loads((extracted/"manifest.json").read_text())
        assert manifest["has_audio"] is True and len(manifest["frames"])==4
        assert (extracted/manifest["audio_file"]).stat().st_size>100
        assert all((extracted/f["file"]).stat().st_size>100 for f in manifest["frames"])
        run(sys.executable,ROOT/"experimental/mux_narration.py",video,narration,out)
        streams=probe(out)
        assert {s["codec_type"] for s in streams["streams"]}>={"video","audio"}
        assert 2.8<=float(streams["format"]["duration"])<=3.2
        print("PASS: extracted audio, timestamped frames, and muxed playable MP4")
if __name__=="__main__":main()
