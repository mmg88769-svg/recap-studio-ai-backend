from app.subtitles import build_srt, group_words, validate_srt, wrap_subtitle_text


def test_group_words_respects_sentence_and_time_boundaries():
    words = [
        {"text": "Hello", "start_ms": 100, "end_ms": 400},
        {"text": "there.", "start_ms": 410, "end_ms": 800},
        {"text": "How", "start_ms": 1100, "end_ms": 1300},
        {"text": "are", "start_ms": 1310, "end_ms": 1450},
        {"text": "you?", "start_ms": 1460, "end_ms": 1700},
    ]
    groups = group_words(words, "en-US")
    assert len(groups) == 2
    assert groups[0]["source_text"] == "Hello there."
    assert groups[1]["source_text"] == "How are you?"


def test_wrap_burmese_subtitle_into_two_lines():
    lines = wrap_subtitle_text("ဒီဇာတ်ကားထဲမှာ သူတို့ဟာ အရေးကြီးတဲ့ လျှို့ဝှက်ချက်တစ်ခုကို ရှာဖွေတွေ့ရှိခဲ့ကြပါတယ်။", 24)
    assert 1 <= len(lines) <= 2
    assert all(line for line in lines)


def test_build_srt_has_valid_sequential_cues():
    content = build_srt([
        {"start_ms": 1000, "end_ms": 2500, "text": "မင်္ဂလာပါ။"},
        {"start_ms": 2600, "end_ms": 4100, "text": "ဒီဇာတ်ကားကို စတင်ကြည့်ရှုကြရအောင်။"},
    ])
    assert validate_srt(content)
    assert content.startswith("1\n00:00:01,000 --> 00:00:02,500")


def test_validate_srt_rejects_overlapping_or_invalid_cues():
    invalid = (
        "1\n00:00:02,000 --> 00:00:04,000\nပထမစာကြောင်း\n\n"
        "2\n00:00:03,000 --> 00:00:05,000\nဒုတိယစာကြောင်း\n"
    )
    assert not validate_srt(invalid)
