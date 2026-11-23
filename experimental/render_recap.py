#!/usr/bin/env python3
"""Render a chronological scene edit plan and narration to a playable MP4.

Requires ffmpeg. Input plan is JSON from plan_scenes.py. This is an offline
renderer, not a deployed Android feature or AI video analyzer.
"""
import argparse, json, pathlib, subprocess, tempfile

def run(*args):
    return subprocess.run([str(x) for x in args],check=True,capture_output=True,text=True).stdout

def probe(path):
    return json.loads(run("ffprobe","-v","error","-show_entries","format=duration:stream=codec_type","-of","json",path))

def render(video,voice,plan,output):
    video,voice,output=map(pathlib.Path,(video,voice,output))
    if not video.is_file() or not voice.is_file(): raise ValueError("Missing input")
    if output.resolve() in (video.resolve(),voice.resolve()): raise ValueError("Output overwrites input")
    cuts=plan.get("cuts")
    if not isinstance(cuts,list) or not cuts: raise ValueError("No scenes selected")
    duration=int(float(probe(video)["format"]["duration"])*1000)
    last=0
    for c in cuts:
        a,b=c.get("source_start_ms"),c.get("source_end_ms")
        if type(a)!=int or type(b)!=int or a<last or b<=a or b>duration+20:
            raise ValueError("Invalid chronological scene boundaries")
        last=b
    total=sum(c["source_end_ms"]-c["source_start_ms"] for c in cuts)
    voice_ms=int(float(probe(voice)["format"]["duration"])*1000)
    if voice_ms>total+100: raise ValueError("Narration longer than selected scenes")
    output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        folder=pathlib.Path(temp)
        paths=[]
        for i,c in enumerate(cuts):
            part=folder/f"part_{i:04d}.mp4"
            run("ffmpeg","-nostdin","-v","error","-y","-ss",f'{c["source_start_ms"]/1000:.3f}',
                "-i",video,"-t",f'{(c["source_end_ms"]-c["source_start_ms"])/1000:.3f}',
                "-map","0:v:0","-an","-vf","scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1",
                "-c:v","libx264","-preset","ultrafast","-crf","24","-pix_fmt","yuv420p","-r","24",part)
            paths.append(part)
        manifest=folder/"concat.txt"
        manifest.write_text("".join("file '"+str(p)+"'\n" for p in paths))
        joined=folder/"joined.mp4"
        run("ffmpeg","-nostdin","-v","error","-y","-f","concat","-safe","0","-i",manifest,"-c","copy",joined)
        staged=folder/"staged_output.mp4"
        run("ffmpeg","-nostdin","-v","error","-y","-i",joined,"-i",voice,
            "-filter_complex","[1:a:0]apad[a]","-map","0:v:0","-map","[a]",
            "-c:v","copy","-c:a","aac","-b:a","160k","-t",f"{total/1000:.3f}",
            "-movflags","+faststart",staged)
        streams={s["codec_type"] for s in probe(staged)["streams"]}
        if not {"video","audio"}.issubset(streams): raise RuntimeError("MP4 missing audio or video")
        if staged.stat().st_size < 1024: raise RuntimeError("MP4 output too small")
        staged.replace(output)
    return {"output":str(output),"scene_count":len(cuts),"duration_ms":total}

if __name__=="__main__":
    p=argparse.ArgumentParser()
    for name in ("video","voice","plan","output"): p.add_argument(name,type=pathlib.Path)
    a=p.parse_args()
    print(json.dumps(render(a.video,a.voice,json.loads(a.plan.read_text(encoding="utf-8")),a.output)))
