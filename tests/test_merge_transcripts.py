import unittest
from experimental.merge_transcripts import merge

class MergeTranscriptsTests(unittest.TestCase):
    def test_offsets_and_order(self):
        clips=[
            {"offset_ms":10000,"duration_ms":5000,"transcript_segments":[{"start_ms":500,"end_ms":1200,"text":" second "}]},
            {"offset_ms":0,"duration_ms":5000,"transcript_segments":[{"start_ms":100,"end_ms":700,"text":"first"}]}
        ]
        result=merge(clips)
        self.assertEqual([x["start_ms"] for x in result],[100,10500])
        self.assertEqual(result[1]["text"],"second")
    def test_exact_duplicate_removed(self):
        segment={"start_ms":0,"end_ms":1000,"text":"same"}
        self.assertEqual(len(merge([{"offset_ms":0,"duration_ms":2000,"transcript_segments":[segment,segment]}])),1)
    def test_rejects_outside_clip(self):
        with self.assertRaises(ValueError):
            merge([{"offset_ms":0,"duration_ms":1000,"transcript_segments":[{"start_ms":800,"end_ms":1200,"text":"bad"}]}])
    def test_rejects_invalid_offset(self):
        with self.assertRaises(ValueError):
            merge([{"offset_ms":-1,"duration_ms":1000,"transcript_segments":[]}])

if __name__=="__main__": unittest.main()
