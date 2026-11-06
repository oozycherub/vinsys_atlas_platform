"""The interview graph's nodes (PRD §2.4b state machine). Each node takes the state, returns the
whole new state, and sets `next`: another node, or AWAIT when it waits for the candidate.

Nodes are replayable: the runner checkpoints after every node, and a crashed worker's successor
re-runs the node that was interrupted. Utterance ids come from a counter in the state, so a
replayed node reuses the ids of anything it already said (transports drop duplicates).
"""

from __future__ import annotations

import copy
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from langchain_core.runnables import RunnableConfig

from interview_svc.application.ports import GraphContext, InterviewerReply, InterviewerRequest
from interview_svc.domain.dialogue import (
    CONTEXT_TURNS,
    MAX_PAUSES,
    MAX_PROBES,
    MAX_REPEAT_FAILURES,
    faq_answer,
    intent_of,
    low_confidence,
    phrase,
    silence_action,
    yes_no,
)
from interview_svc.domain.guardrails import blocked_category, classify_input
from interview_svc.domain.plan import Competency, Knockout, Plan, Question
from interview_svc.domain.state import AWAIT, Emit, InterviewState, Turn, Utterance

NodeFn = Callable[[InterviewState, RunnableConfig], Awaitable[InterviewState]]

# --- helpers ---------------------------------------------------------------------------------


def ctx_of(config: RunnableConfig) -> GraphContext:
    ctx = (config.get('configurable') or {}).get('ctx')
    if not isinstance(ctx, GraphContext):
        raise TypeError('the graph needs a GraphContext in config["configurable"]["ctx"]')
    return ctx


@dataclass(frozen=True)
class Item:
    kind: Literal['question', 'knockout']
    index: int
    competency: Competency | None = None
    question: Question | None = None
    knockout: Knockout | None = None

    @property
    def qid(self) -> str:
        if self.question is not None:
            return self.question.qid
        assert self.knockout is not None
        return self.knockout.kid

    @property
    def text(self) -> str:
        if self.question is not None:
            return self.question.text
        assert self.knockout is not None
        return self.knockout.question


def item_at(plan: Plan, index: int) -> Item | None:
    """Core questions in plan order, then the knockouts."""
    questions = plan.questions()
    if 0 <= index < len(questions):
        comp, q = questions[index]
        return Item('question', index, competency=comp, question=q)
    k = index - len(questions)
    if 0 <= k < len(plan.knockouts):
        return Item('knockout', index, knockout=plan.knockouts[k])
    return None


def _next_id(s: InterviewState) -> str:
    return f'{s["session_id"]}:{s["utterances"] + 1}'


def say(s: InterviewState, text: str, kind: str, qid: str | None = None) -> Utterance:
    """Appends an interviewer utterance to the transcript and to this invocation's outbox."""
    u: Utterance = {'id': _next_id(s), 'text': text, 'kind': kind, 'qid': qid}
    s['utterances'] += 1
    at = s['clock_ms']
    s['turns'].append(
        {
            'index': len(s['turns']),
            'role': 'interviewer',
            'kind': kind,
            'qid': qid,
            'text': text,
            't0_ms': at,
            't1_ms': at,
            'stt_conf': None,
            'interrupted': False,
            'excluded': False,
            'flags': [],
            'utterance_id': u['id'],
        }
    )
    s['outbox'].append(u)
    return u


def hear(s: InterviewState, kind: str, qid: str | None) -> Turn:
    ev: Mapping[str, Any] = s['event'] or {}
    turn: Turn = {
        'index': len(s['turns']),
        'role': 'candidate',
        'kind': kind,
        'qid': qid,
        'text': str(ev.get('text', ''))[:20000],
        't0_ms': int(ev.get('t0_ms', s['clock_ms'])),
        't1_ms': int(ev.get('t1_ms', s['clock_ms'])),
        'stt_conf': ev.get('avg_logprob'),
        'interrupted': False,
        'excluded': False,
        'flags': [],
        'utterance_id': None,
    }
    s['turns'].append(turn)
    return turn


def emit(s: InterviewState, flag: str, turn_index: int | None, ended: bool = False) -> None:
    e: Emit = {'flag': flag, 'turn_index': turn_index, 'ended': ended}
    s['emits'].append(e)
    if flag not in s['flags']:
        s['flags'].append(flag)


def safe(s: InterviewState, text: str, fallback: str, turn_index: int | None) -> str:
    """The output filter: a blocked utterance is never said; the plan's text is said instead."""
    if text.strip() and blocked_category(text) is None:
        return text.strip()
    if text.strip():
        emit(s, 'blocked_question', turn_index)
    return fallback


def recent(s: InterviewState) -> tuple[tuple[str, str], ...]:
    turns = [t for t in s['turns'] if not t['excluded'] and t['kind'] not in ('filler',)]
    return tuple((t['role'], t['text']) for t in turns[-CONTEXT_TURNS:])


async def ask_interviewer(
    s: InterviewState, ctx: GraphContext, req: InterviewerRequest, qid: str | None
) -> InterviewerReply:
    """Calls the interviewer; a filler it plays while waiting is recorded with a reserved id."""
    filler: Utterance = {'id': _next_id(s), 'text': phrase('filler'), 'kind': 'filler', 'qid': qid}

    async def on_filler() -> None:
        await ctx.say_now(filler)

    reply = await ctx.interviewer.respond(req, on_filler)
    if reply.filler:
        say(s, filler['text'], 'filler', qid)
        s['outbox'].pop()  # already played by say_now
    return reply


def request(
    s: InterviewState, ctx: GraphContext, item: Item, task: Literal['ask', 'decide']
) -> InterviewerRequest:
    assert item.question is not None
    assert item.competency is not None
    probes = item.question.probes
    return InterviewerRequest(
        tenant_id=s['tenant_id'],
        task=task,
        language=ctx.plan.language,
        competency=item.competency.name,
        question=item.question.text,
        probes=probes,
        probes_remaining=max(0, min(MAX_PROBES, len(probes)) - s['probes_used']),
        recent_turns=recent(s),
        first_question=item.index == 0,
    )


def fresh(state: InterviewState) -> InterviewState:
    return copy.deepcopy(state)


def wait(s: InterviewState) -> InterviewState:
    s['event'] = None
    s['next'] = AWAIT
    return s


# --- nodes -----------------------------------------------------------------------------------


async def consent(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    ev = s['event']
    answer: Literal['yes', 'no', 'unclear'] | None = None
    if ev and ev['type'] == 'consent':
        answer = 'yes' if ev.get('accepted') else 'no'
    elif ev and ev['type'] == 'utterance':
        hear(s, 'consent', None)
        answer = yes_no(str(ev.get('text', '')))
    s['phase'] = 'CONSENT'
    if answer == 'yes':
        s['event'] = None
        s['next'] = 'GREETING'
        return s
    if answer == 'no':
        say(s, phrase('declined'), 'declined')
        s['outcome'] = 'declined'
        s['event'] = None
        s['next'] = 'SCORING'
        return s
    asked = any(t['kind'] == 'consent' and t['role'] == 'interviewer' for t in s['turns'])
    say(s, phrase('consent_reminder' if asked else 'consent'), 'consent')
    return wait(s)


async def greeting(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    plan: Plan = ctx_of(config).plan
    s['phase'] = 'GREETING'
    say(s, phrase('greeting', count=len(plan.questions()), minutes=plan.max_minutes), 'greeting')
    s['next'] = 'ASK_QUESTION'
    return s


async def ask_question(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    ctx = ctx_of(config)
    plan: Plan = ctx.plan
    s['phase'] = 'ASK_QUESTION'
    if s['elapsed_ms'] >= plan.max_minutes * 60_000:
        say(s, phrase('time_up'), 'time_up')
        s['next'] = 'WRAP_UP'
        return s
    item = item_at(plan, s['q_index'])
    if item is None:
        s['next'] = 'WRAP_UP'
        return s
    if item.kind == 'knockout':
        if item.index == len(plan.questions()):
            say(s, phrase('knockout_intro'), 'transition')
        say(s, item.text, 'knockout', item.qid)
    else:
        reply = await ask_interviewer(s, ctx, request(s, ctx, item, 'ask'), item.qid)
        # The interviewer adds a short lead-in; the plan's question is always said verbatim
        # (every candidate gets the same core questions).
        lead = safe(s, reply.utterance, '', None) if reply.action == 'ask' else ''
        say(s, f'{lead} {item.text}'.strip(), 'question', item.qid)
    s['phase'] = 'LISTEN'
    s['probes_used'] = 0
    s['silence_stage'] = 0
    s['repeat_failures'] = 0
    s['draft'] = None
    return wait(s)


async def listen(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    ctx = ctx_of(config)
    ev = s['event']
    item = item_at(ctx.plan, s['q_index'])
    s['phase'] = 'LISTEN'
    if ev is None or item is None:
        return wait(s)
    if ev['type'] == 'silence':
        action, s['silence_stage'] = silence_action(int(ev.get('silent_ms', 0)), s['silence_stage'])
        if action == 'move_on':
            say(s, phrase('move_on'), 'move_on', item.qid)
            s['event'] = None
            s['next'] = 'EVAL_TURN'
            return s
        if action is not None:
            say(s, phrase(action), action, item.qid)
        return wait(s)
    text = str(ev.get('text', '')).strip()
    if not text:
        return wait(s)
    turn = hear(s, 'answer' if item.kind == 'question' else 'knockout_answer', item.qid)
    s['silence_stage'] = 0
    flag = classify_input(text)
    if flag is not None:
        turn['excluded'] = True
        turn['flags'].append(flag)
        emit(s, flag, turn['index'], ended=flag == 'safety_stop')
        if flag == 'safety_stop':
            s['event'] = None
            s['next'] = 'SAFETY'
            return s
        say(s, phrase('injection' if flag == 'prompt_injection_attempt' else 'abuse'), 'decline')
        return wait(s)
    if s['mode'] == 'voice' and low_confidence(ev.get('avg_logprob'), ev.get('no_speech_prob')):
        turn['excluded'] = True
        turn['flags'].append('low_confidence')
        s['event'] = None
        s['next'] = 'REPEAT'
        return s
    s['repeat_failures'] = 0
    intent = intent_of(text).kind
    if intent == 'repeat':
        turn['kind'] = 'request'
        say(s, item.text, 'repeat', item.qid)
        return wait(s)
    if intent == 'move_on':
        turn['kind'] = 'request'
        say(s, phrase('move_on'), 'move_on', item.qid)
        s['event'] = None
        s['next'] = 'EVAL_TURN'
        return s
    if intent == 'candidate_question':
        turn['kind'] = 'candidate_question'
        s['event'] = None
        s['next'] = 'CANDIDATE_QUESTION'
        return s
    s['event'] = None
    if item.kind == 'knockout':
        assert item.knockout is not None
        heard = yes_no(text)
        s['knockouts'][item.qid] = (
            'unclear'
            if heard == 'unclear'
            else 'pass'
            if heard == item.knockout.expected
            else 'fail'
        )
        s['next'] = 'EVAL_TURN'
        return s
    req = request(s, ctx, item, 'decide')
    reply = await ask_interviewer(s, ctx, req, item.qid)
    if reply.action == 'redirect':
        turn['flags'].append('off_topic')
        s['draft'] = {'kind': 'redirect', 'text': reply.utterance}
        s['next'] = 'OFF_TOPIC'
    elif reply.action == 'probe' and req.probes_remaining > 0:
        index = reply.probe_index
        if index is None or not 0 <= index < len(req.probes):
            index = min(s['probes_used'], len(req.probes) - 1)
        s['draft'] = {'kind': 'probe', 'text': reply.utterance, 'probe_index': index}
        s['next'] = 'FOLLOW_UP'
    else:
        s['next'] = 'EVAL_TURN'
    return s


async def follow_up(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    item = item_at(ctx_of(config).plan, s['q_index'])
    draft: dict[str, Any] = s['draft'] or {}
    assert item is not None
    assert item.question is not None
    probes = item.question.probes
    planned = probes[int(draft.get('probe_index', 0)) % len(probes)] if probes else item.text
    say(s, safe(s, str(draft.get('text', '')), planned, None), 'probe', item.qid)
    s['probes_used'] += 1
    s['phase'] = 'LISTEN'
    s['silence_stage'] = 0
    s['draft'] = None
    return wait(s)


async def off_topic(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    item = item_at(ctx_of(config).plan, s['q_index'])
    assert item is not None
    draft: dict[str, Any] = s['draft'] or {}
    fallback = f"Let's come back to the question. {item.text}"
    say(s, safe(s, str(draft.get('text', '')), fallback, None), 'redirect', item.qid)
    s['phase'] = 'LISTEN'
    s['draft'] = None
    return wait(s)


async def candidate_question(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    ctx = ctx_of(config)
    asked = s['turns'][-1]['text'] if s['turns'] else ''
    answer = faq_answer(asked, ctx.plan.faq)
    say(s, answer or phrase('faq_unknown'), 'faq')
    s['phase'] = 'LISTEN'
    return wait(s)


async def repeat(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    s['repeat_failures'] += 1
    if s['repeat_failures'] >= MAX_REPEAT_FAILURES and not s['text_offered']:
        s['text_offered'] = True
        say(s, phrase('offer_text'), 'offer_text')
    else:
        say(s, phrase('repeat_stt'), 'repeat')
    s['phase'] = 'LISTEN'
    return wait(s)


async def eval_turn(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    item = item_at(ctx_of(config).plan, s['q_index'])
    s['phase'] = 'EVAL_TURN'
    if item is not None and item.kind == 'question':
        answered = any(
            t['role'] == 'candidate'
            and t['qid'] == item.qid
            and t['kind'] == 'answer'
            and not t['excluded']
            for t in s['turns']
        )
        if answered and item.qid not in s['pending_evals']:
            s['pending_evals'].append(item.qid)
    s['q_index'] += 1
    s['probes_used'] = 0
    s['silence_stage'] = 0
    s['draft'] = None
    s['next'] = 'ASK_QUESTION'
    return s


async def wrap_up(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    s['phase'] = 'WRAP_UP'
    say(s, phrase('wrap_up'), 'wrap_up')
    s['outcome'] = s['outcome'] or 'completed'
    s['next'] = 'SCORING'
    return s


async def scoring(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    s['phase'] = 'SCORING'
    s['evaluation'] = await ctx_of(config).scoring.score(s)
    s['phase'] = 'END'
    return wait(s)


async def pause(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    ev: Mapping[str, Any] = s['event'] or {}
    if s['pauses'] >= MAX_PAUSES:
        s['event'] = None
        s['next'] = 'ABANDON'
        return s
    s['pauses'] += 1
    s['phase_before_pause'] = s['phase']
    s['phase'] = 'PAUSED'
    s['paused_at_ms'] = int(ev.get('at_ms', s['clock_ms']))
    return wait(s)


async def resume(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    plan: Plan = ctx_of(config).plan
    was_paused = s['phase'] == 'PAUSED'
    if was_paused:
        s['phase'] = s['phase_before_pause'] or 'LISTEN'
        s['phase_before_pause'] = None
        s['paused_at_ms'] = None
    if s['phase'] == 'CONSENT':
        say(s, phrase('consent'), 'consent')
        return wait(s)
    item = item_at(plan, s['q_index'])
    if s['phase'] == 'LISTEN' and item is not None:
        if was_paused:
            say(s, phrase('welcome_back'), 'welcome_back', item.qid)
        say(s, item.text, 'repeat', item.qid)
        s['silence_stage'] = 0
    return wait(s)


async def abandon(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    s['outcome'] = 'abandoned'
    if 'abandoned' not in s['flags']:
        s['flags'].append('abandoned')
    say(s, phrase('abandoned'), 'abandoned')
    s['event'] = None
    s['next'] = 'SCORING'
    return s


async def safety(state: InterviewState, config: RunnableConfig) -> InterviewState:
    s = fresh(state)
    say(s, phrase('safety'), 'safety')
    s['outcome'] = 'escalated'
    s['next'] = 'SCORING'
    return s


NODES: dict[str, NodeFn] = {
    'CONSENT': consent,
    'GREETING': greeting,
    'ASK_QUESTION': ask_question,
    'LISTEN': listen,
    'FOLLOW_UP': follow_up,
    'OFF_TOPIC': off_topic,
    'CANDIDATE_QUESTION': candidate_question,
    'REPEAT': repeat,
    'EVAL_TURN': eval_turn,
    'WRAP_UP': wrap_up,
    'SCORING': scoring,
    'PAUSE': pause,
    'RESUME': resume,
    'ABANDON': abandon,
    'SAFETY': safety,
}
