#!/usr/bin/env python3
"""Mix narration into an MP4. Preserves original scenes; no automatic scene selection."""
import argparse, json, subprocess, pathlib

def probe(path):
    p=subprocess.run(["ffprobe","-v","error","-show_entries","format=duration:stream=codec_type","-of","json",str(path)],capture_output=True,text=True,check=True)
    return json.loads(p.stdout)

def main():
    p=argparse.ArgumentParser()
    p.add_argument("video",type=pathlib.Path)
    p.add_argument("narration",type=pathlib.Path)
    p.add_argument("output",type=pathlib.Path)
    p.add_argument("--original-volume",type=float,default=0.12)
    a=p.parse_args()
    if not 0<=a.original_volume<=1:p.error("original-volume must be 0..1")
    for path in [a.video,a.narration]:
        if not path.is_file():p.error(f"File missing: {path}")
    if a.output.resolve() in [a.video.resolve(),a.narration.resolve()]:p.error("Output must differ from inputs")
    v,n=probe(a.video),probe(a.narration)
    vd,nd=float(v["format"]["duration"]),float(n["format"]["duration"])
    if not any(x["codec_type"]=="video" for x in v.get("streams",[])):p.error("Video input has no video stream")
    if not any(x["codec_type"]=="audio" for x in n.get("streams",[])):p.error("Narration has no audio stream")
    if nd>vd+0.1:p.error("Narration exceeds video duration; edit scene timeline before muxing")
    original=any(x["codec_type"]=="audio" for x in v.get("streams",[]))
    cmd=["ffmpeg","-nostdin","-hide_banner","-loglevel","error","-y","-i",str(a.video),"-i",str(a.narration)]
    if original and a.original_volume>0:
        cmd+=["-filter_complex",f"[0:a:0]volume={a.original_volume}[orig];[1:a:0]apad[voice];[orig][voice]amix=inputs=2:duration=first:dropout_transition=0[aout]","-map","0:v:0","-map","[aout]"]
    else:
        cmd+=["-filter_complex","[1:a:0]apad[aout]","-map","0:v:0","-map","[aout]"]
    cmd+=["-c:v","copy","-c:a","aac","-b:a","192k","-t",str(vd),"-movflags","+faststart",str(a.output)]
    a.output.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run(cmd,check=True)
    print(json.dumps({"output":str(a.output),"video_seconds":vd,"narration_seconds":nd,"original_audio_mixed":original and a.original_volume>0}))

if __name__=="__main__":main()
