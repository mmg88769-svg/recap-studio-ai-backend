from __future__ import annotations

import re
from typing import Iterable

import regex


END_PUNCTUATION = re.compile(r"[.!?。！？၊။…][”’\"')\]]*$")


def join_words(words: list[dict], language_code: str) -> str:
    language = (language_code or "").split("-")[0].lower()
    parts = [str(item.get("text", "")).strip() for item in words]
    parts = [part for part in parts if part]
    if language in {"my", "zh", "ja", "th", "lo", "km"}:
        return "".join(parts).strip()
    return " ".join(parts).strip()


def group_words(
    words: Iterable[dict],
    language_code: str,
    max_duration_ms: int = 5600,
    max_words: int = 12,
    max_source_graphemes: int = 88,
    max_gap_ms: int = 850,
) -> list[dict]:
    ordered = sorted(words, key=lambda item: int(item["start_ms"]))
    groups: list[dict] = []
    current: list[dict] = []

    def flush() -> None:
        if not current:
            return
        groups.append({
            "id": len(groups) + 1,
            "start_ms": int(current[0]["start_ms"]),
            "end_ms": int(current[-1]["end_ms"]),
            "source_text": join_words(current, language_code),
            "speaker": current[0].get("speaker"),
        })
        current.clear()

    for word in ordered:
        text = str(word.get("text", "")).strip()
        if not text:
            continue
        if current:
            gap = int(word["start_ms"]) - int(current[-1]["end_ms"])
            speaker_changed = word.get("speaker") != current[0].get("speaker")
            current_text = join_words(current + [word], language_code)
            duration = int(word["end_ms"]) - int(current[0]["start_ms"])
            should_flush = (
                gap > max_gap_ms
                or speaker_changed
                or duration > max_duration_ms
                or len(current) >= max_words
                or len(regex.findall(r"\X", current_text)) > max_source_graphemes
                or bool(END_PUNCTUATION.search(str(current[-1].get("text", ""))))
            )
            if should_flush:
                flush()
        current.append(word)
        if END_PUNCTUATION.search(text):
            flush()

    flush()
    return groups


def wrap_subtitle_text(text: str, max_graphemes: int = 42) -> list[str]:
    clean = " ".join((text or "").split())
    if not clean:
        raise ValueError("Subtitle text is empty.")

    clusters = regex.findall(r"\X", clean)
    if len(clusters) <= max_graphemes:
        return [clean]

    minimum_split = max(1, len(clusters) - max_graphemes)
    split_candidates = [
        index for index, cluster in enumerate(clusters[:max_graphemes + 1])
        if cluster.isspace() and minimum_split <= index <= max_graphemes
    ]
    if split_candidates:
        split_at = min(split_candidates, key=lambda index: abs(index - max_graphemes))
    else:
        split_at = max_graphemes

    first = "".join(clusters[:split_at]).strip()
    second = "".join(clusters[split_at:]).strip()
    if not first or not second:
        raise ValueError("Could not wrap subtitle text.")

    if len(regex.findall(r"\X", second)) > max_graphemes:
        raise ValueError("Translated subtitle is too long for two readable lines.")

    return [first, second]


def format_timestamp(milliseconds: int) -> str:
    value = max(0, int(milliseconds))
    hours, remainder = divmod(value, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def build_srt(cues: list[dict]) -> str:
    ordered = sorted(cues, key=lambda item: int(item["start_ms"]))
    normalized: list[dict] = []

    for cue in ordered:
        start_ms = max(0, int(cue["start_ms"]))
        end_ms = max(start_ms + 300, int(cue["end_ms"]))
        lines = wrap_subtitle_text(str(cue["text"]).strip())
        normalized.append({
            "start_ms": start_ms,
            "end_ms": end_ms,
            "lines": lines,
        })

    # Keep cue order and remove overlaps by moving a later cue only by the
    # minimum amount needed. This avoids emitting invalid or overlapping SRT.
    for index in range(1, len(normalized)):
        previous = normalized[index - 1]
        current = normalized[index]
        minimum_start = previous["end_ms"] + 40
        if current["start_ms"] < minimum_start:
            shift = minimum_start - current["start_ms"]
            current["start_ms"] += shift
            current["end_ms"] = max(
                current["end_ms"] + shift,
                current["start_ms"] + 300,
            )

    blocks: list[str] = []
    for index, cue in enumerate(normalized, start=1):
        blocks.append(
            f"{index}\n"
            f"{format_timestamp(cue['start_ms'])} --> {format_timestamp(cue['end_ms'])}\n"
            + "\n".join(cue["lines"])
        )
    result = "\n\n".join(blocks) + "\n"
    if not validate_srt(result):
        raise ValueError("Generated SRT failed structural validation.")
    return result

def validate_srt(content: str) -> bool:
    normalized = (content or "").lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return False
    blocks = [block for block in re.split(r"\n[ \t]*\n", normalized) if block.strip()]
    previous_end = -1

    for expected_number, block in enumerate(blocks, start=1):
        lines = [line.strip() for line in block.split("\n")]
        if len(lines) < 3 or lines[0] != str(expected_number):
            return False
        match = re.fullmatch(
            r"(\d{2,}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+"
            r"(\d{2,}):(\d{2}):(\d{2}),(\d{3})",
            lines[1],
        )
        if not match or not any(lines[2:]):
            return False
        values = [int(value) for value in match.groups()]
        start_ms = ((values[0] * 60 + values[1]) * 60 + values[2]) * 1000 + values[3]
        end_ms = ((values[4] * 60 + values[5]) * 60 + values[6]) * 1000 + values[7]
        if end_ms <= start_ms or start_ms < previous_end:
            return False
        previous_end = end_ms
    return True
