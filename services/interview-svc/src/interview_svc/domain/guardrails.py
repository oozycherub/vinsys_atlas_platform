"""Guardrails in code (PRD §2.4b, §4.1), on both sides of the model.

- Output: the illegal-question filter. Every interviewer utterance, and every question a plan
  makes the interviewer say, is checked; a blocked utterance is never spoken.
- Input: heuristics for prompt injection, requests for answers or scores, abuse and safety
  risks in candidate turns. A flagged turn is excluded from scoring and shown to a reviewer.

Patterns are deliberately broad on the output side (a false positive costs a rephrase) and
narrow on the input side (a false positive costs a candidate their answer).
"""

from __future__ import annotations

import re
import unicodedata
from typing import Literal

InputFlag = Literal['prompt_injection_attempt', 'abusive_content', 'safety_stop']


def normalise(text: str) -> str:
    """NFKC, lower case, straight quotes, single spaces (homoglyph and spacing tricks)."""
    t = unicodedata.normalize('NFKC', text).lower()
    t = t.replace(chr(0x2019), "'").replace(chr(0x2018), "'")
    return re.sub(r'\s+', ' ', t).strip()


def _rx(*patterns: str) -> re.Pattern[str]:
    return re.compile('|'.join(f'(?:{p})' for p in patterns))


# Protected characteristics an interviewer must never ask about (US EEOC / NYC LL144, EU AI Act,
# UK Equality Act). Work authorisation is allowed ("Are you authorised to work in ...?").
BLOCKED: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        'age',
        _rx(
            r'\bhow old\b',
            r'\byour age\b',
            r'\bage are you\b',
            r'\b(year|date) (of birth|were you born)\b',
            r'\bwhen were you born\b',
            r'\bborn in (what|which)\b',
            r'\bwhen did you graduate (from )?(high|secondary) school\b',
            r'\bclose to retirement\b',
            r'\bplan(ning)? to retire\b',
        ),
    ),
    (
        'religion',
        _rx(
            r'\breligio',
            r'\b(church|mosque|temple|synagogue|gurdwara)\b',
            r'\bwhat (do you )?(believe|worship)\b',
            r'\b(observe|celebrate)s? (any )?(holy|religious)',
            r'\bpray\b',
            r'\bsabbath\b',
        ),
    ),
    (
        'marital_or_family_status',
        _rx(
            r'\bmarried\b',
            r'\bmarital\b',
            r'\b(single|divorced|widowed)\?',
            r'\b(your|a) (husband|wife|spouse|boyfriend|girlfriend|fianc[eé]e?)\b',
            r'\bdo you have (any )?(kids|children)\b',
            r'\bhow many (kids|children) do you\b',
            r'\bplan(ning)? (on |to )?(have|having|start|starting) (kids|children|a family)\b',
            r'\b(want|wants) (kids|children|a family|a baby)\b',
            r'\bchild ?care\b',
            r'\bmaiden name\b',
        ),
    ),
    ('pregnancy', _rx(r'\bpregnan', r'\bmaternity\b', r'\bexpecting a (baby|child)\b')),
    (
        'nationality_or_origin',
        _rx(
            r'\bnationality\b',
            r'\b(are you|you are) (a )?(\w+ )?citizen\b',
            r'\bcitizenship\b',
            r'\bwhere (are|were) you (originally |really )?(from|born)\b',
            r'\b(native|first|mother) (language|tongue)\b',
            r'\bwhat country\b.*\b(from|born)\b',
            r'\b(accent)\b.*\bfrom\b',
            r'\bimmigra',
        ),
    ),
    (
        'race_or_ethnicity',
        _rx(
            r'\b(your|what) race\b', r'\brace or ethnicity\b', r'\bethnicity\b', r'\bskin colou?r\b'
        ),
    ),
    (
        'disability_or_health',
        _rx(
            r'\b(do you have|any|your) (a )?disabilit',
            r'\bare you disabled\b',
            r'\bhandicap',
            r'\b(medical|health|mental health) (condition|issue|problem|history)s?\b',
            r'\b(any|your) (illness|diagnos)',
            r'\bmedications?\b',
            r'\bsick (days|leave)\b.*\blast\b',
            r'\bworkers.? comp',
        ),
    ),
    (
        'sexual_orientation_or_gender_identity',
        _rx(
            r'\bsexual (orientation|preference)\b',
            r'\b(gay|lesbian|bisexual|transgender|straight)\?',
            r'\bgender identity\b',
            r'\bpronouns?\b.*\bbirth\b',
        ),
    ),
    (
        'union_or_political',
        _rx(
            r'\bunion member',
            r'\bjoin(ed)? a (trade )?union\b',
            r'\bpolitical (party|view|affiliation|belief)',
            r'\bwho did you vote\b',
        ),
    ),
    (
        'criminal_record',
        _rx(r'\b(ever )?(been )?arrested\b', r'\bcriminal (record|history|conviction)\b'),
    ),
)


def blocked_category(text: str) -> str | None:
    """The protected category an utterance asks about, or None when it may be said."""
    t = normalise(text)
    for category, pattern in BLOCKED:
        if pattern.search(t):
            return category
    return None


INJECTION = _rx(
    r'\b(ignore|disregard|forget|override)\b.{0,30}\b(instructions?|prompts?|rules|guidelines|above|previous)\b',
    r'\byou are now\b',
    r'\b(act|behave) as (if|an?|the)\b',
    r'\bpretend (to be|you are|you\'re)\b',
    r'\b(system|developer) (prompt|message|mode)\b',
    r'\bjailbreak',
    r'\bnew instructions\b',
    r'</?\s*(system|assistant|instructions?|user)\s*>',
    r'\b(give|award|assign) me\b.{0,20}\b(5|five|full marks|top (score|marks)|perfect|highest|maximum)\b',
    r'\b(score|rate|grade|mark) (me|this answer|my answer)\b.{0,20}\b(5|five|high|top|perfect|full)\b',
    r'\bi (deserve|should get)\b.{0,20}\b(5|five|top|perfect|full)\b',
    r'\b(what|tell me)\b.{0,25}\b(rubric|scoring criteria|expected answer|right answer|correct answer|ideal answer|model answer)\b',
    r'\b(repeat|reveal|print|show)\b.{0,20}\b(your|the) (instructions|prompt|rules)\b',
    r'\bas an ai\b.{0,30}\b(you must|you should|you will)\b',
)

SAFETY = _rx(
    r'\b(kill|hurt|harm) (myself|me)\b',
    r'\b(end|take) my (own )?life\b',
    r'\bsuicid',
    r'\b(i will|i\'ll|i am going to|i\'m going to|gonna) (kill|hurt|shoot|stab|find) you\b',
    r'\b(bomb|shoot up)\b.{0,30}\b(office|building|school|company)\b',
)

ABUSE = _rx(
    r'\bf+u+c+k+(ing|er|ed)?\b',
    r'\bsh[i1]t+\b',
    r'\bb[i1]tch',
    r'\bbastard\b',
    r'\basshole\b',
    r'\b(stupid|useless|dumb) (bot|machine|ai|robot)\b',
    r'\bshut up\b',
)


def classify_input(text: str) -> InputFlag | None:
    """The most severe guardrail hit for a candidate turn: safety first, then injection, then
    abuse. None for an ordinary answer."""
    t = normalise(text)
    if SAFETY.search(t):
        return 'safety_stop'
    if INJECTION.search(t):
        return 'prompt_injection_attempt'
    if ABUSE.search(t):
        return 'abusive_content'
    return None
