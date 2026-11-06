"""Presidio + spaCy NER (optional extra `pii`): CPU-bound, so it runs in a worker thread."""

from __future__ import annotations

import asyncio
import logging

from atlas_platform.pii import Detection

#: Entities redacted before egress. Locations are included: an address identifies a candidate.
PRESIDIO_ENTITIES = (
    'PERSON',
    'EMAIL_ADDRESS',
    'PHONE_NUMBER',
    'LOCATION',
    'URL',
    'IP_ADDRESS',
    'CREDIT_CARD',
    'IBAN_CODE',
    'US_SSN',
    'UK_NHS',
    'DATE_TIME',
)
#: Dates are only redacted when they look like a date of birth; employment dates stay useful.
_SKIP_UNLESS_CONTEXT = {'DATE_TIME': ('born', 'birth', 'dob', 'd.o.b')}


class PresidioDetector:
    """Presidio + spaCy NER. CPU-bound, so it runs in a worker thread."""

    def __init__(
        self,
        spacy_model: str = 'en_core_web_sm',
        score_threshold: float = 0.4,
        entities: tuple[str, ...] = (),
    ) -> None:
        from presidio_analyzer import AnalyzerEngine

        logging.getLogger('presidio-analyzer').setLevel(logging.ERROR)
        from presidio_analyzer.nlp_engine import NlpEngineProvider

        nlp = NlpEngineProvider(
            nlp_configuration={
                'nlp_engine_name': 'spacy',
                'models': [{'lang_code': 'en', 'model_name': spacy_model}],
            }
        ).create_engine()
        self._engine = AnalyzerEngine(nlp_engine=nlp, supported_languages=['en'])
        self._threshold = score_threshold
        self._entities = entities or PRESIDIO_ENTITIES

    def _detect(self, text: str) -> list[Detection]:
        results = self._engine.analyze(
            text=text,
            language='en',
            entities=list(self._entities),
            score_threshold=self._threshold,
        )
        out: list[Detection] = []
        for r in results:
            if r.entity_type in _SKIP_UNLESS_CONTEXT:
                window = text[max(0, r.start - 40) : r.start].lower()
                if not any(word in window for word in _SKIP_UNLESS_CONTEXT[r.entity_type]):
                    continue
            out.append(Detection(r.start, r.end, r.entity_type, float(r.score)))
        return out

    async def detect(self, text: str) -> list[Detection]:
        return await asyncio.to_thread(self._detect, text)
