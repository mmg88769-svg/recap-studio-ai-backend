#!/usr/bin/env python3
"""Extract audio and timestamped video frames locally. Requires ffmpeg and ffprobe."""
import argparse, json, subprocess, pathlib

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("video", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--frames", type=int, default=8)
    args=parser.parse_args()
    if not 1 <= args.frames <= 8: parser.error("--frames must be 1..8")
    if not args.video.is_file(): parser.error("Video not found")
    args.output.mkdir(parents=True, exist_ok=True)
    metadata=json.loads(run("ffprobe","-v","error","-show_entries","format=duration:stream=codec_type","-of","json",str(args.video)))
    duration=float(metadata["format"]["duration"])
    if duration<=0: parser.error("Invalid duration")
    has_audio=any(stream["codec_type"]=="audio" for stream in metadata.get("streams",[]))
    frames=[]
    for i in range(args.frames):
        seconds=(i+0.5)*duration/args.frames
        name=f"frame_{i+1:02d}.jpg"
        run("ffmpeg","-nostdin","-hide_banner","-loglevel","error","-y","-ss",str(seconds),"-i",str(args.video),"-frames:v","1","-vf","scale=640:-2",str(args.output/name))
        frames.append({"time_ms":round(seconds*1000),"file":name})
    audio_file=None
    if has_audio:
        audio_file="dialogue_audio.wav"
        run("ffmpeg","-nostdin","-hide_banner","-loglevel","error","-y","-i",str(args.video),"-vn","-ac","1","-ar","16000","-c:a","pcm_s16le",str(args.output/audio_file))
    result={"duration_ms":round(duration*1000),"has_audio":has_audio,"audio_file":audio_file,"frames":frames,"note":"This utility does not transcribe or understand the video."}
    (args.output/"manifest.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
    print(json.dumps(result,indent=2))

if __name__=="__main__": main()
