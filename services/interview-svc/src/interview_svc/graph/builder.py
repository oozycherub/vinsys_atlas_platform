"""The LangGraph `StateGraph` and its entry rule.

One invocation consumes one input event. `accept_event` decides which node handles it (the
global edges: disconnect → PAUSE, rejoin → RESUME, pause timeout → ABANDON); the conditional
edges then follow `state.next` until a node sets AWAIT. Because `next` is part of the state, a
checkpoint taken after any node says exactly where to resume.
"""

from __future__ import annotations

import copy
from functools import lru_cache
from typing import Any

from langgraph.graph import END, START, StateGraph

from interview_svc.domain.errors import InterviewError
from interview_svc.domain.state import AWAIT, Event, InterviewState
from interview_svc.graph.nodes import NODES

ENDED_PHASES = ('WRAP_UP', 'SCORING', 'END')


def accept_event(state: InterviewState, event: Event) -> InterviewState:
    """The state with `event` pending and `next` set to the node that handles it (AWAIT when the
    event changes nothing). Advances the session clock; paused time does not count."""
    if state['phase'] == 'END':
        raise InterviewError('conflict', 'INTERVIEW_ENDED', 'The interview has ended.')
    if state['next'] != AWAIT:
        raise InterviewError(
            'conflict', 'INTERVIEW_BUSY', 'The previous input is still being processed.'
        )
    s = copy.deepcopy(state)
    at = max(int(event['at_ms']), s['clock_ms'])
    if s['phase'] != 'PAUSED':
        s['elapsed_ms'] += at - s['clock_ms']
    s['clock_ms'] = at
    s['outbox'] = []
    s['event'] = event
    phase, kind = s['phase'], event['type']
    nxt = AWAIT
    if kind == 'start':
        nxt = 'CONSENT' if not s['turns'] else 'RESUME'
    elif kind == 'consent':
        nxt = 'CONSENT' if phase == 'CONSENT' else AWAIT
    elif kind == 'utterance':
        nxt = {'CONSENT': 'CONSENT', 'LISTEN': 'LISTEN'}.get(phase, AWAIT)
    elif kind == 'silence':
        nxt = 'LISTEN' if phase == 'LISTEN' else AWAIT
    elif kind == 'disconnect':
        nxt = AWAIT if phase in (*ENDED_PHASES, 'PAUSED') else 'PAUSE'
    elif kind == 'rejoin':
        nxt = AWAIT if phase in ENDED_PHASES else 'RESUME'
    elif kind == 'pause_timeout':
        nxt = 'ABANDON' if phase == 'PAUSED' else AWAIT
    s['next'] = nxt
    if nxt == AWAIT:
        s['event'] = None
    return s


def _route(state: InterviewState) -> str:
    return state['next'] if state['next'] in NODES else AWAIT


@lru_cache(maxsize=1)
def interview_graph() -> Any:
    """The compiled graph (shared: nodes read the session's context from the run config)."""
    graph = StateGraph(InterviewState)
    for name, fn in NODES.items():
        graph.add_node(name, fn)  # type: ignore[call-overload]
    targets: dict[str, str] = {name: name for name in NODES}
    targets[AWAIT] = END
    graph.add_conditional_edges(START, _route, targets)  # type: ignore[arg-type]
    for name in NODES:
        graph.add_conditional_edges(name, _route, targets)  # type: ignore[arg-type]
    return graph.compile()
