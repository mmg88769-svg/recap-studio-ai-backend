import unittest
from experimental.plan_scenes import plan

class ScenePlanTests(unittest.TestCase):
    def test_chronology_budget_and_overlap(self):
        result=plan({"duration_ms":20000,"events":[
            {"start_ms":8000,"end_ms":15000,"summary_my":"နောက်ပိုင်း","evidence":"dialogue"},
            {"start_ms":1000,"end_ms":10000,"summary_my":"အစပိုင်း","evidence":"frame"}]},max_seconds=10)
        self.assertEqual(result["output_duration_ms"],10000)
        self.assertEqual(result["cuts"][0]["source_start_ms"],1000)
        self.assertEqual(result["cuts"][1]["source_start_ms"],10000)
    def test_missing_evidence_rejected(self):
        with self.assertRaises(ValueError):
            plan({"duration_ms":10000,"events":[{"start_ms":0,"end_ms":5000,"summary_my":"x","evidence":""}]})
    def test_out_of_bounds_rejected(self):
        with self.assertRaises(ValueError):
            plan({"duration_ms":10000,"events":[{"start_ms":0,"end_ms":20000,"summary_my":"x","evidence":"dialogue"}]})
    def test_empty_needs_review(self):
        self.assertTrue(plan({"duration_ms":10000,"events":[]})["requires_review"])

if __name__=="__main__":unittest.main()
