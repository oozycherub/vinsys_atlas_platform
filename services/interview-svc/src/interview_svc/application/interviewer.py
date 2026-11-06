"""The interviewer role with the PRD's latency fallbacks (§2.4d "LLM latency spike or outage"):
a filler at 1.2 s, the failover model at 3 s, and if that fails too, a deterministic reply from
the frozen plan, so the interview always continues."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from interview_svc.application.ports import (
    FillerSink,
    InterviewerReply,
    InterviewerRequest,
    LlmGateway,
)
from interview_svc.domain.dialogue import MAX_PROBES, SHORT_ANSWER_WORDS, word_count
from interview_svc.prompts import INTERVIEWER, INTERVIEWER_FAILOVER, PURPOSE_TURN

log = logging.getLogger('interview_svc')

FILLER_AFTER_S = 1.2
FAILOVER_AFTER_S = 3.0
FAILOVER_TIMEOUT_S = 3.0


def fallback(req: InterviewerRequest) -> InterviewerReply:
    """No model: no lead-in when asking; probe a short answer while approved probes remain."""
    if req.task == 'ask':
        return InterviewerReply('ask', '', source='fallback')
    last = next((text for role, text in reversed(req.recent_turns) if role == 'candidate'), '')
    used = min(MAX_PROBES, len(req.probes)) - req.probes_remaining
    if req.probes_remaining > 0 and word_count(last) < SHORT_ANSWER_WORDS:
        index = min(max(used, 0), len(req.probes) - 1)
        return InterviewerReply('probe', req.probes[index], index, source='fallback')
    return InterviewerReply('next', '', source='fallback')


def _variables(req: InterviewerRequest) -> dict[str, str]:
    return {
        'language': req.language,
        'competency': req.competency,
        'task': req.task,
        'question': req.question,
        'probes': '\n'.join(f'{i}: {p}' for i, p in enumerate(req.probes)) or '(none)',
        'probes_remaining': str(req.probes_remaining),
        'recent_turns': '\n'.join(f'{role}: {text}' for role, text in req.recent_turns) or '(none)',
    }


def _reply(output: dict[str, Any], source: str, filler: bool) -> InterviewerReply | None:
    action = output.get('action')
    if action not in ('ask', 'probe', 'next', 'redirect'):
        return None
    index = output.get('probe_index')
    return InterviewerReply(
        action=action,
        utterance=str(output.get('utterance') or '')[:400],
        probe_index=index if isinstance(index, int) and not isinstance(index, bool) else None,
        source='fast' if source == 'fast' else 'failover',
        filler=filler,
    )


class ResilientInterviewer:
    def __init__(
        self,
        llm: LlmGateway,
        *,
        filler_after: float = FILLER_AFTER_S,
        failover_after: float = FAILOVER_AFTER_S,
        failover_timeout: float = FAILOVER_TIMEOUT_S,
    ) -> None:
        self.llm = llm
        self.filler_after = filler_after
        self.failover_after = failover_after
        self.failover_timeout = failover_timeout

    async def _call(self, prompt: str, req: InterviewerRequest) -> dict[str, Any]:
        return await self.llm.complete(req.tenant_id, PURPOSE_TURN, prompt, _variables(req))

    async def respond(self, req: InterviewerRequest, on_filler: FillerSink) -> InterviewerReply:
        filler = False
        primary = asyncio.ensure_future(self._call(INTERVIEWER, req))
        try:
            done, _ = await asyncio.wait({primary}, timeout=self.filler_after)
            if not done:
                filler = True
                await on_filler()
                done, _ = await asyncio.wait(
                    {primary}, timeout=max(0.0, self.failover_after - self.filler_after)
                )
            if done and primary.exception() is None:
                reply = _reply(primary.result(), 'fast', filler)
                if reply is not None:
                    return reply
            elif done:
                log.warning(
                    'interviewer failed', extra={'error': type(primary.exception()).__name__}
                )
        finally:
            if not primary.done():
                primary.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await primary
        try:
            output = await asyncio.wait_for(
                self._call(INTERVIEWER_FAILOVER, req), timeout=self.failover_timeout
            )
            reply = _reply(output, 'failover', filler)
            if reply is not None:
                return reply
        except Exception as error:  # noqa: BLE001 - any failure falls back to the plan
            log.warning('interviewer failover failed', extra={'error': type(error).__name__})
        result = fallback(req)
        return InterviewerReply(
            result.action, result.utterance, result.probe_index, 'fallback', filler
        )
