#!/usr/bin/env python3
"""Offline verified render stage: recap events -> chronological cuts -> narration MP4.

This stage requires evidence-backed events JSON and an already generated voice file.
It does not perform speech recognition, Gemini requests or Android builds.
"""
import argparse, json, pathlib, subprocess, sys
from experimental.plan_scenes import plan
from experimental.render_recap import render

def build(video,voice,events,output,max_seconds=90):
    if not isinstance(events,dict): raise ValueError("Expected JSON object")
    cuts=plan(events,max_seconds=max_seconds)
    if cuts["requires_review"]: raise ValueError("No evidence-backed scenes; manual review required")
    result=render(video,voice,cuts,output)
    return {"status":"rendered","scene_count":result["scene_count"],
            "output":result["output"],"scene_plan":cuts,
            "limitations":["Audio narration supplied externally","Scene boundaries supplied by evidence events","No AI or Android integration"]}
def main():
    p=argparse.ArgumentParser()
    for arg in ("video","narration","events","output"):p.add_argument(arg,type=pathlib.Path)
    p.add_argument("--max-seconds",type=float,default=90)
    a=p.parse_args()
    events=json.loads(a.events.read_text(encoding="utf-8"))
    result=build(a.video,a.narration,events,a.output,a.max_seconds)
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=="__main__":main()
