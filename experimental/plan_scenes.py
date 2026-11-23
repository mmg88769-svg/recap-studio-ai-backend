#!/usr/bin/env python3
"""Build a conservative scene selection plan from grounded recap events.

Input JSON has events [{start_ms,end_ms,summary_my,evidence}] and a duration_ms.
The output is an edit decision list; it does NOT cut or export a video.
"""
import argparse, json
from pathlib import Path

def plan(data, *, max_seconds=90):
    duration=data.get("duration_ms")
    if type(duration) is not int or duration<=0: raise ValueError("Invalid movie duration")
    if not 5<=max_seconds<=3600: raise ValueError("Invalid recap length")
    events=data.get("events")
    if not isinstance(events,list): raise ValueError("events array required")
    cuts=[]
    budget=int(max_seconds*1000)
    for e in sorted(events,key=lambda x:x.get("start_ms",-1)):
        start,end=e.get("start_ms"),e.get("end_ms")
        if type(start) is not int or type(end) is not int or start<0 or end<=start or end>duration:
            raise ValueError("Event timestamps invalid")
        if not isinstance(e.get("summary_my"),str) or not e["summary_my"].strip():
            raise ValueError("Event summary missing")
        if not e.get("evidence"):
            raise ValueError("Event without evidence must be reviewed")
        if budget<=0: break
        # Preserve chronology; prevent duplicated overlapping footage.
        start=max(start,cuts[-1]["source_end_ms"] if cuts else 0)
        if start>=end: continue
        length=min(end-start,budget)
        cuts.append({"source_start_ms":start,"source_end_ms":start+length,
                     "summary_my":e["summary_my"],"evidence":e["evidence"]})
        budget-=length
    timeline=0
    for cut in cuts:
        cut["output_start_ms"]=timeline
        timeline+=cut["source_end_ms"]-cut["source_start_ms"]
        cut["output_end_ms"]=timeline
    return {"cuts":cuts,"output_duration_ms":timeline,
            "requires_review":not bool(cuts),
            "note":"Timeline plan only; narration timing and actual MP4 export not yet integrated."}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("input",type=Path)
    p.add_argument("output",type=Path)
    p.add_argument("--max-seconds",type=float,default=90)
    a=p.parse_args()
    result=plan(json.loads(a.input.read_text(encoding="utf-8")),max_seconds=a.max_seconds)
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Planned {len(result['cuts'])} clips ({result['output_duration_ms']/1000:.1f}s)")
if __name__=="__main__":main()
