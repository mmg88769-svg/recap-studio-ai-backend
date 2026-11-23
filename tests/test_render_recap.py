import pathlib, subprocess, tempfile, unittest
from experimental.render_recap import render, probe

class RenderRecapTests(unittest.TestCase):
    def test_two_scenes_and_voice(self):
        with tempfile.TemporaryDirectory() as td:
            p=pathlib.Path(td); video=p/"input.mp4"; voice=p/"voice.wav"; output=p/"out.mp4"
            subprocess.run(["ffmpeg","-v","error","-y","-f","lavfi","-i","testsrc2=size=160x90:rate=24:duration=5","-c:v","libx264",str(video)],check=True)
            subprocess.run(["ffmpeg","-v","error","-y","-f","lavfi","-i","sine=frequency=440:duration=2","-ac","1",str(voice)],check=True)
            plan={"cuts":[{"source_start_ms":0,"source_end_ms":1500},{"source_start_ms":3000,"source_end_ms":4500}]}
            result=render(video,voice,plan,output)
            self.assertEqual(result["scene_count"],2)
            self.assertGreater(output.stat().st_size,1000)
            self.assertEqual({s["codec_type"] for s in probe(output)["streams"]},{"video","audio"})
    def test_failed_render_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as td:
            p=pathlib.Path(td)
            video=p/"video.mp4"; voice=p/"voice.wav"; output=p/"existing.mp4"
            output.write_bytes(b"KEEP_ORIGINAL")
            subprocess.run(["ffmpeg","-v","error","-y","-f","lavfi","-i",
                "testsrc2=size=160x90:rate=24:duration=2","-c:v","libx264",str(video)],check=True)
            subprocess.run(["ffmpeg","-v","error","-y","-f","lavfi","-i",
                "sine=frequency=440:duration=4",str(voice)],check=True)
            with self.assertRaises(ValueError):
                render(video,voice,{"cuts":[{"source_start_ms":0,"source_end_ms":1000}]},output)
            self.assertEqual(output.read_bytes(),b"KEEP_ORIGINAL")

    def test_empty_plan_rejected(self):
        with self.assertRaises(ValueError):
            render("missing.mp4","missing.wav",{"cuts":[]},"out.mp4")

if __name__=="__main__": unittest.main()
