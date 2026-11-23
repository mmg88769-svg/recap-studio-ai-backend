#!/usr/bin/env python3
"""Merge clip-relative dialogue transcripts into one movie-relative timeline.

Input JSON: {"clips":[{"offset_ms":0,"duration_ms":10000,
 "transcript_segments":[{"start_ms":0,"end_ms":1200,"text":"...","language":"en"}]}]}
This does not run AI, extract audio or assert transcript accuracy.
"""
import argparse
import json
from pathlib import Path

def merge(clips):
    output=[]
    for clip in clips:
        offset=clip.get("offset_ms")
        duration=clip.get("duration_ms")
        if type(offset) is not int or type(duration) is not int or offset<0 or duration<=0:
            raise ValueError("Invalid clip offset or duration")
        for segment in clip.get("transcript_segments",[]):
            start,end=segment.get("start_ms"),segment.get("end_ms")
            if (type(start) is not int or type(end) is not int or
                    start<0 or end<=start or end>duration):
                raise ValueError("Transcript segment falls outside its clip")
            text=segment.get("text")
            if not isinstance(text,str) or not text.strip():
                continue
            output.append({"start_ms":offset+start,"end_ms":offset+end,
                           "text":text.strip(),"language":segment.get("language","unknown")})
    output.sort(key=lambda s:(s["start_ms"],s["end_ms"]))
    # Exact duplicates can occur when clips overlap. Keep only one.
    seen=set()
    unique=[]
    for s in output:
        key=(s["start_ms"],s["end_ms"],s["text"])
        if key not in seen:
            seen.add(key)
            unique.append(s)
    return unique

def main():
    p=argparse.ArgumentParser()
    p.add_argument("input",type=Path)
    p.add_argument("output",type=Path)
    a=p.parse_args()
    data=json.loads(a.input.read_text(encoding="utf-8"))
    result={"transcript_segments":merge(data["clips"]),"timestamp_basis":"movie-relative"}
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Merged {len(result['transcript_segments'])} dialogue segments")

if __name__=="__main__":
    main()
