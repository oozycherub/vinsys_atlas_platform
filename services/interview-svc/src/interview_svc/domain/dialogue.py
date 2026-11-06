"""Deterministic dialogue rules (PRD §2.4d): silence, STT confidence, candidate intents, the
approved FAQ, knockouts and the phrases the agent says without a model."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from rapidfuzz import fuzz

from interview_svc.domain.guardrails import normalise
from interview_svc.domain.plan import Faq

# Silence after the agent stops speaking (PRD §2.4d "Long silence").
NUDGE_MS = 8_000
OFFER_MOVE_ON_MS = 30_000
MOVE_ON_MS = 60_000

# Low STT confidence: whisper's segment avg_logprob and no-speech probability.
MIN_AVG_LOGPROB = -1.0
MAX_NO_SPEECH_PROB = 0.6
MAX_REPEAT_FAILURES = 2

MAX_PROBES = 2
MAX_PAUSES = 2
PAUSE_LIMIT_MS = 120_000
CONTEXT_TURNS = 6
SHORT_ANSWER_WORDS = 25
FAQ_MATCH = 80.0

SilenceAction = Literal['nudge', 'offer_move_on', 'move_on']


def silence_action(silent_ms: int, stage: int) -> tuple[SilenceAction | None, int]:
    """What to do after `silent_ms` of silence, given the stage already reached (0 none,
    1 nudged, 2 offered to move on). Each prompt is given once per question."""
    if silent_ms >= MOVE_ON_MS:
        return 'move_on', 3
    if silent_ms >= OFFER_MOVE_ON_MS and stage < 2:
        return 'offer_move_on', 2
    if silent_ms >= NUDGE_MS and stage < 1:
        return 'nudge', 1
    return None, stage


def low_confidence(avg_logprob: float | None, no_speech_prob: float | None) -> bool:
    """True when the transcript is too unreliable to use (voice only; text has no scores)."""
    if avg_logprob is not None and avg_logprob < MIN_AVG_LOGPROB:
        return True
    return no_speech_prob is not None and no_speech_prob > MAX_NO_SPEECH_PROB


def word_count(text: str) -> int:
    return len(re.findall(r"[\w'-]+", text))


_REPEAT = re.compile(
    r'^(sorry[,.]? )?(could|can|would) you (please )?(repeat|say that again|rephrase)'
    r'|^(pardon|come again|sorry\?|what\?|say again)'
    r'|^(please )?repeat (the|that) question'
)
_MOVE_ON = re.compile(r'^(can we |let\'s |could we )?(move on|skip( this| it)?|next question)\b')
_QUESTION_START = re.compile(
    r'^(how|what|when|where|who|will|would|can|could|do|does|is|are|should|may)\b'
)


@dataclass(frozen=True)
class Intent:
    kind: Literal['repeat', 'move_on', 'candidate_question', 'answer']


def intent_of(text: str) -> Intent:
    """A candidate turn is an answer unless it is clearly a request to repeat, to move on, or a
    short question to the interviewer. Ambiguous turns are answers (they get scored)."""
    t = normalise(text)
    if _REPEAT.search(t):
        return Intent('repeat')
    if _MOVE_ON.search(t) and word_count(t) <= 8:
        return Intent('move_on')
    if t.endswith('?') and word_count(t) <= 20 and _QUESTION_START.search(t):
        return Intent('candidate_question')
    return Intent('answer')


def faq_answer(question: str, faq: tuple[Faq, ...]) -> str | None:
    """The approved answer to a candidate's question, or None: the agent never improvises."""
    best: tuple[float, str] | None = None
    q = normalise(question)
    for item in faq:
        score = fuzz.token_set_ratio(q, normalise(item.question))
        if score >= FAQ_MATCH and (best is None or score > best[0]):
            best = (score, item.answer)
    return best[1] if best else None


_YES_FIRST = frozenset(
    {'yes', 'yeah', 'yep', 'yup', 'correct', 'absolutely', 'certainly', 'sure', 'definitely'}
)
_NO_FIRST = frozenset({'no', 'nope', 'nah', 'never'})
_NEGATION = re.compile(r"\b(not|don't|do not|haven't|have not|cannot|can't|never|i'm not)\b")
_AFFIRM = re.compile(r'\b(i am|i do|i have|i can|of course)\b')


def yes_no(text: str) -> Literal['yes', 'no', 'unclear']:
    """A knockout or consent answer. The leading word decides ("No, I am not"); otherwise an
    explicit negation; anything mixed or vague is unclear (a person checks it)."""
    t = normalise(text)
    words = re.findall(r"[a-z']+", t)
    if 'yes' in words and 'no' in words:
        return 'unclear'
    first = words[0] if words else ''
    if first in _YES_FIRST:
        return 'yes'
    if first in _NO_FIRST:
        return 'no'
    if _NEGATION.search(t):
        return 'no'
    if _AFFIRM.search(t):
        return 'yes'
    return 'unclear'


# What the agent says without a model. Each is checked against the illegal-question filter in
# the tests, like everything else it says.
PHRASES: dict[str, str] = {
    'consent': (
        'Hello, and thank you for joining. This interview is conducted by an AI interviewer. It is '
        'recorded and transcribed, and your answers are evaluated with AI assistance; a person '
        'reviews the results before any decision. Do you consent to continue?'
    ),
    'consent_reminder': 'Please confirm whether you consent to continue with the interview.',
    'declined': (
        'Understood. We will not continue, and nothing from this conversation will be evaluated. '
        'The recruiter will contact you about other options. Goodbye.'
    ),
    'greeting': (
        'Thank you. This interview has {count} questions and takes up to {minutes} minutes. Take '
        'your time with each answer; you can ask me to repeat a question at any point.'
    ),
    'nudge': 'Take your time. Whenever you are ready, please share your answer.',
    'offer_move_on': 'If you would like, we can move on to the next question. Just say so.',
    'move_on': "Let's move on to the next question.",
    'repeat_stt': 'Sorry, I did not catch that clearly. Could you please repeat your answer?',
    'offer_text': (
        'I am having trouble hearing you clearly. You can switch to typing your answers in the '
        'chat if that is easier.'
    ),
    'faq_unknown': (
        'I can only answer questions about how this interview works. Please answer the question '
        'as you understand it, and the recruiter can help with anything else.'
    ),
    'injection': (
        'I am not able to help with that. Let us continue: please answer the question in your own '
        'words.'
    ),
    'abuse': 'Let us keep this respectful. Please continue with your answer when you are ready.',
    'safety': (
        'Thank you for telling me. I am going to stop the interview here, and a member of the team '
        'will follow up with you. If you are in danger, please contact local emergency services.'
    ),
    'filler': 'Let me think about that for a moment.',
    'welcome_back': 'Welcome back. We were discussing the following question.',
    'wrap_up': (
        'That brings us to the end of the interview. Thank you for your time and your answers. '
        'The recruiter will be in touch about next steps. Goodbye.'
    ),
    'time_up': 'We are out of time, so we will finish here.',
    'abandoned': 'The interview has ended because the connection was not restored in time.',
    'knockout_intro': 'Finally, a couple of quick questions that need a yes or no answer.',
}


def phrase(key: str, **values: object) -> str:
    return PHRASES[key].format(**values)
