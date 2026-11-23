import pathlib, subprocess, tempfile, unittest
from offline_recap_pipeline import build

class OfflinePipelineTests(unittest.TestCase):
    def test_plans_and_renders_from_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            root=pathlib.Path(td)
            video=root/"source.mp4"; voice=root/"voice.wav"; output=root/"recap.mp4"
            subprocess.run(["ffmpeg","-nostdin","-v","error","-y","-f","lavfi","-i","testsrc2=size=160x90:rate=24:duration=5","-c:v","libx264",str(video)],check=True)
            subprocess.run(["ffmpeg","-nostdin","-v","error","-y","-f","lavfi","-i","sine=frequency=440:duration=2","-ac","1",str(voice)],check=True)
            evidence={"duration_ms":5000,"events":[
                {"start_ms":0,"end_ms":1500,"summary_my":"အဖွင့်","evidence":"dialogue"},
                {"start_ms":3000,"end_ms":4500,"summary_my":"အဆုံး","evidence":"visual"}]}
            result=build(video,voice,evidence,output,max_seconds=5)
            self.assertEqual(result["scene_count"],2)
            self.assertGreater(output.stat().st_size,1000)
    def test_no_evidence_fails_closed(self):
        with self.assertRaises(ValueError):
            build("missing.mp4","missing.wav",{"duration_ms":5000,"events":[]},"out.mp4")

if __name__=="__main__":unittest.main()
