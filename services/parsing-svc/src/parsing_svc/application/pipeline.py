"""ParseResumeWorkflow's activities (PRD §2.1(b) stages 2-11).

Each stage is idempotent per (document, stage, parser version): it reads its inputs, writes only
progress until `persist`, and `persist` replaces the candidate's chunks and finishes the job in
one transaction, so a retried workflow never duplicates embeddings or events. The same methods
run inline (development, tests) and as Temporal activities (production).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from atlas_platform.db import Database

from parsing_svc.application.ports import (
    Clock,
    EmailTakenError,
    Embedder,
    Extractor,
    LlmExtractor,
    MalwareScanner,
    ObjectStorage,
    OcrEngine,
    PiiDetector,
    ProfileApi,
    Taxonomy,
    UpstreamError,
)
from parsing_svc.application.store import (
    BatchRepository,
    EmbeddingRepository,
    Job,
    JobRepository,
    ModelSlots,
    Outbox,
    StoredChunk,
)
from parsing_svc.domain.chunks import build_chunks
from parsing_svc.domain.errors import PipelineError, QuarantineReason, malicious
from parsing_svc.domain.layout import LayoutDoc, drop_hidden
from parsing_svc.domain.proficiency import SkillFacts, confidence, is_stuffed, proficiency
from parsing_svc.domain.redact import redact, scrub
from parsing_svc.domain.schema import SCHEMA_VERSION, from_llm
from parsing_svc.domain.sections import Section, segment
from parsing_svc.domain.sniff import (
    DOCX,
    JPEG,
    MAX_DOCUMENT_BYTES,
    OLE,
    PDF,
    PNG,
    check_declared,
    classify_ole,
    inspect_docx,
    sniff,
)
from parsing_svc.domain.verify import Span, verify

log = logging.getLogger('parsing_svc')

#: Below this many characters per page a PDF is treated as scanned and sent to OCR.
OCR_DENSITY = 50
MIN_OCR_CONFIDENCE = 0.4
INJECTION_FLAG_SCORE = 0.5


@dataclass
class Prepared:
    text: str  # redacted, in reading order
    sections: list[list[Any]]  # [type, start, end]
    page_count: int
    word_count: int
    source: str
    flags: list[str] = field(default_factory=list)
    pii_map: dict[str, str] = field(default_factory=dict)


@dataclass
class Extraction:
    data: dict[str, Any]
    model: str
    injection_score: float


@dataclass
class Enriched:
    profile: dict[str, Any]
    skills: list[dict[str, Any]]  # skill_id, proficiency, confidence (the event's skills)
    chunks: list[dict[str, Any]]  # chunk_type, chunk_index, content, token_count
    flags: list[str]
    language: str | None
    current_title: str | None
    total_experience_months: int | None
    metrics: dict[str, Any]


@dataclass
class Embedded:
    vectors: dict[str, list[list[float]]]  # model_id → one vector per chunk


@dataclass
class Failure:
    code: str
    detail: str
    retryable: bool = False
    quarantine: QuarantineReason | None = None
    signature: str | None = None

    @staticmethod
    def of(error: PipelineError) -> Failure:
        return Failure(error.code, error.detail, error.retryable, error.quarantine, error.signature)


@dataclass
class Deps:
    db: Database
    jobs: JobRepository
    embeddings: EmbeddingRepository
    slots: ModelSlots
    batches: BatchRepository
    outbox: Outbox
    storage: ObjectStorage
    scanner: MalwareScanner
    extractor: Extractor
    ocr: OcrEngine | None
    detector: PiiDetector
    llm: LlmExtractor
    taxonomy: Taxonomy
    embedder: Embedder
    profile: ProfileApi
    clock: Clock


class ParsePipeline:
    def __init__(self, deps: Deps) -> None:
        self.d = deps

    async def stage(self, job: Job, name: str, progress: int) -> None:
        async with self.d.db.tenant_tx(job.tenant_id) as tx:
            await self.d.jobs.set_stage(tx, job.job_id, name, progress)

    # -- stages 2-5 -------------------------------------------------------------------------------

    async def intake(self, job: Job) -> Prepared:
        """Security gate, extraction, hidden-text removal, segmentation, redaction."""
        await self.stage(job, 'security_gate', 5)
        try:
            data = await self.d.storage.get(job.storage_key)
        except FileNotFoundError as error:
            raise PipelineError('UNREADABLE_DOCUMENT', 'The uploaded object is missing.') from error
        if len(data) > MAX_DOCUMENT_BYTES:
            raise PipelineError('UNREADABLE_DOCUMENT', 'The document is larger than 10 MB.')
        kind = check_declared(job.mime_type, sniff(data))
        if kind == OLE:
            classify_ole(data)
        if kind == DOCX:
            inspect_docx(data)
        signature = await self.d.scanner.scan(data)
        if signature:
            raise malicious('malware', f'{self.d.scanner.name} detected {signature}.', signature)
        if kind == PDF:
            data = await asyncio.to_thread(self.d.extractor.sanitize_pdf, data)

        await self.stage(job, 'extract', 20)
        layout = await self._layout(kind, data)
        layout, hidden = drop_hidden(layout)
        if layout.char_count == 0:
            raise PipelineError('UNREADABLE_DOCUMENT', 'No readable text was found.')

        await self.stage(job, 'segment', 35)
        seg = segment(layout)

        await self.stage(job, 'redact', 45)
        try:
            detections = await self.d.detector.detect(seg.text)
        except Exception as error:  # fail closed: nothing leaves this stage unredacted
            raise UpstreamError('PII detection failed') from error
        known = await self.d.profile.get_contact(job.tenant_id, job.candidate_id)
        red = redact(
            seg,
            detections,
            [v for v in (known.full_name, known.email, known.phone) if v] if known else [],
        )
        flags = ['hidden_text'] if hidden.blocks else []
        flags += await self._fill_placeholder(job, red.contact)
        return Prepared(
            text=red.text,
            sections=[[s.type, s.start, s.end] for s in red.sections],
            page_count=seg.page_count,
            word_count=len(red.text.split()),
            source=layout.source,
            flags=flags,
            pii_map=red.pii_map,
        )

    async def _layout(self, kind: str, data: bytes) -> LayoutDoc:
        if kind in (PNG, JPEG):
            return await self._ocr(kind, data)
        layout = await asyncio.to_thread(self.d.extractor.extract, kind, data)
        if kind == PDF and layout.chars_per_page() < OCR_DENSITY and self.d.ocr is not None:
            scanned = await self._ocr(kind, data)
            if scanned.char_count > layout.char_count:
                return scanned
        return layout

    async def _ocr(self, kind: str, data: bytes) -> LayoutDoc:
        if self.d.ocr is None:
            raise PipelineError(
                'UNREADABLE_DOCUMENT', 'Scanned documents need OCR, which is not enabled.'
            )
        layout = await self.d.ocr.ocr(kind, data)
        if layout.ocr_confidence is not None and layout.ocr_confidence < MIN_OCR_CONFIDENCE:
            raise PipelineError('UNREADABLE_DOCUMENT', 'The scan is too poor to read.')
        return layout

    async def _fill_placeholder(self, job: Job, contact: Any) -> list[str]:
        """Bulk-imported candidates start with a placeholder name; the résumé's contact block
        replaces it (through profile-svc, never in events)."""
        async with self.d.db.tenant_tx(job.tenant_id) as tx:
            placeholder = await self.d.batches.is_placeholder(tx, job.candidate_id)
        if not placeholder or not contact.full_name:
            return []
        try:
            await self.d.profile.update_contact(job.tenant_id, job.candidate_id, contact)
        except EmailTakenError:
            return ['duplicate_candidate']
        return []

    # -- stage 6 ----------------------------------------------------------------------------------

    async def extract(self, job: Job, prepared: Prepared) -> Extraction:
        await self.stage(job, 'llm_extract', 55)
        result = await self.d.llm.extract(
            job.tenant_id, prepared.text, list(prepared.pii_map.values())
        )
        return Extraction(result.data, result.model, result.injection_score)

    # -- stages 7-9 -------------------------------------------------------------------------------

    async def enrich(self, job: Job, prepared: Prepared, extraction: Extraction) -> Enriched:
        await self.stage(job, 'verify', 70)
        resume = from_llm(extraction.data)
        verified = verify(resume, prepared.text)
        items = verified.items

        await self.stage(job, 'normalise', 75)
        roles = items.get('work_history', [])
        projects = items.get('projects', [])
        certs = items.get('certifications', [])
        skill_items = items.get('skills', [])
        terms = list(
            dict.fromkeys(
                [d['raw'] for d, _ in skill_items]
                + [s for d, _ in roles + projects for s in d['skills_mentioned']]
                + [d['certificate'] for d, _ in certs if d['certificate']]
            )
        )
        mapping: dict[str, str | None] = {}
        for start in range(0, len(terms), 100):
            for r in await self.d.taxonomy.normalize(job.tenant_id, terms[start : start + 100]):
                mapping[r.term.casefold()] = r.skill_id

        def sid(term: str) -> str | None:
            return mapping.get(term.casefold())

        today = self.d.clock.now().date()
        facts = _facts(skill_items, roles, projects, certs, sid, today)
        mentions = len(skill_items) + sum(len(d['skills_mentioned']) for d, _ in roles + projects)
        unsupported = sum(1 for f in facts.values() if f.roles == 0)
        stuffed = is_stuffed(prepared.word_count, mentions, len(facts), unsupported)

        flags = list(prepared.flags)
        if stuffed:
            flags.append('keyword_stuffing')
        if extraction.injection_score >= INJECTION_FLAG_SCORE:
            flags.append('prompt_injection_suspected')
        if verified.dropped:
            flags.append('unverified_fields_dropped')

        scores = {
            skill_id: (proficiency(f, today), confidence(f, stuffed))
            for skill_id, f in facts.items()
        }
        cleaned = scrub(_profile(resume, items, sid, scores, flags), prepared.pii_map)
        assert isinstance(cleaned, dict)
        profile: dict[str, Any] = cleaned
        names = [d['raw'] for d, _ in skill_items if sid(d['raw'])] or [
            d['raw'] for d, _ in skill_items
        ]
        chunks = build_chunks(profile, names)
        return Enriched(
            profile=profile,
            skills=[
                {'skill_id': k, 'proficiency': p, 'confidence': c}
                for k, (p, c) in sorted(scores.items())
            ],
            chunks=[
                {
                    'chunk_type': c.chunk_type,
                    'chunk_index': c.chunk_index,
                    'content': str(scrub(c.content, prepared.pii_map)),
                    'token_count': c.token_count,
                }
                for c in chunks
            ],
            flags=sorted(set(flags)),
            language=resume.language,
            current_title=resume.current_title,
            total_experience_months=resume.total_experience_months,
            metrics={
                'skills_extracted': len(skill_items),
                'skills_mapped': len(scores),
                'unmapped_terms': sum(1 for t in terms if not sid(t)),
                'dropped_unverified': verified.dropped[:50],
                'injection_score': extraction.injection_score,
                'model': extraction.model,
                'pages': prepared.page_count,
                'source': prepared.source,
            },
        )

    # -- stage 10 ---------------------------------------------------------------------------------

    async def embed(self, job: Job, enriched: Enriched) -> Embedded:
        await self.stage(job, 'embed', 85)
        async with self.d.db.system_tx() as tx:
            active, shadow = await self.d.slots.get(tx)
        texts = [c['content'] for c in enriched.chunks]
        vectors: dict[str, list[list[float]]] = {}
        if texts:
            # During a model upgrade every new parse is written for both models (dual write), so
            # the shadow index never falls behind while it is being back-filled.
            for model in (active, shadow):
                if model:
                    vectors[model] = await self.d.embedder.embed(job.tenant_id, texts, model)
        return Embedded(vectors)

    # -- stage 11 ---------------------------------------------------------------------------------

    async def persist(
        self, job: Job, prepared: Prepared, enriched: Enriched, embedded: Embedded
    ) -> bool:
        await self.stage(job, 'persist', 95)
        async with self.d.db.tenant_tx(job.tenant_id) as tx:
            current = await self.d.jobs.get(tx, job.job_id)
            if current is None or current.status not in ('queued', 'running'):
                return False  # a retried workflow after success: nothing more to do
            for model, vectors in embedded.vectors.items():
                chunks = [
                    StoredChunk(
                        c['chunk_type'], c['chunk_index'], c['content'], c['token_count'], v
                    )
                    for c, v in zip(enriched.chunks, vectors, strict=True)
                ]
                await self.d.embeddings.replace(
                    tx,
                    tenant_id=job.tenant_id,
                    candidate_id=job.candidate_id,
                    document_id=job.document_id,
                    model_id=model,
                    chunks=chunks,
                )
            await self.d.jobs.finish(
                tx, job.job_id, 'succeeded', flags=enriched.flags, result=enriched.metrics
            )
            await self.d.outbox.append(
                tx,
                topic='profile.resume.parsed.v1',
                tenant_id=job.tenant_id,
                aggregate_type='document',
                aggregate_id=job.document_id,
                payload={
                    'tenant_id': job.tenant_id,
                    'candidate_id': job.candidate_id,
                    'document_id': job.document_id,
                    'parser_version': job.parser_version,
                    'language': enriched.language,
                    'page_count': prepared.page_count,
                    'flags': enriched.flags,
                    'profile': enriched.profile,
                    'current_title': enriched.current_title,
                    'total_experience_months': enriched.total_experience_months,
                    'skills': enriched.skills,
                    'occurred_at': self.d.clock.now().isoformat(),
                },
            )
        log.info(
            'resume parsed',
            extra={
                'tenant_id': job.tenant_id,
                'job_id': job.job_id,
                'skills': len(enriched.skills),
            },
        )
        return True

    # -- failure ----------------------------------------------------------------------------------

    async def fail(self, job: Job, failure: Failure, attempts: int = 1) -> bool:
        status = (
            'quarantined'
            if failure.quarantine
            else ('failed_retryable' if failure.retryable else 'failed')
        )
        quarantine_key = f'quarantine/t/{job.tenant_id}/{job.document_id}'
        if failure.quarantine:
            with contextlib.suppress(FileNotFoundError):  # already moved by an earlier attempt
                await self.d.storage.move(job.storage_key, quarantine_key)
        async with self.d.db.tenant_tx(job.tenant_id) as tx:
            if not await self.d.jobs.finish(tx, job.job_id, status, error_code=failure.code):
                return False
            now = self.d.clock.now().isoformat()
            await self.d.outbox.append(
                tx,
                topic='profile.resume.parse_failed.v1',
                tenant_id=job.tenant_id,
                aggregate_type='document',
                aggregate_id=job.document_id,
                payload={
                    'tenant_id': job.tenant_id,
                    'candidate_id': job.candidate_id,
                    'document_id': job.document_id,
                    'job_id': job.job_id,
                    'error_code': failure.code,
                    'retryable': failure.retryable,
                    'attempts': max(1, attempts),
                    'occurred_at': now,
                },
            )
            if failure.quarantine:
                await self.d.outbox.append(
                    tx,
                    topic='security.file.quarantined.v1',
                    tenant_id=job.tenant_id,
                    aggregate_type='document',
                    aggregate_id=job.document_id,
                    payload={
                        'tenant_id': job.tenant_id,
                        'candidate_id': job.candidate_id,
                        'document_id': job.document_id,
                        'quarantine_key': quarantine_key,
                        'reason': failure.quarantine,
                        'signature': failure.signature,
                        'detected_by': self.d.scanner.name
                        if failure.quarantine == 'malware'
                        else 'parsing-svc',
                        'occurred_at': now,
                    },
                )
        log.warning(
            'resume parse failed',
            extra={
                'tenant_id': job.tenant_id,
                'job_id': job.job_id,
                'code': failure.code,
                'status': status,
            },
        )
        return True


# --- helpers -------------------------------------------------------------------------------------

Entry = tuple[dict[str, Any], Span]


def _role_months(role: dict[str, Any], today: date) -> tuple[int, str | None]:
    """Duration in months and the last month used (today for a current role)."""
    start, end = role.get('start'), role.get('end')
    last = f'{today.year:04d}-{today.month:02d}' if role.get('is_current') else end
    if not start or not last:
        return 0, last
    sy, sm = (int(x) for x in start.split('-'))
    ey, em = (int(x) for x in last.split('-'))
    return max(0, (ey - sy) * 12 + em - sm), last


def _facts(
    skills: Sequence[Entry],
    roles: Sequence[Entry],
    projects: Sequence[Entry],
    certs: Sequence[Entry],
    sid: Any,
    today: date,
) -> dict[str, SkillFacts]:
    acc: dict[str, dict[str, Any]] = {}

    def slot(skill_id: str) -> dict[str, Any]:
        return acc.setdefault(
            skill_id,
            {
                'years': 0.0,
                'last': None,
                'roles': set(),
                'spans': set(),
                'cert': False,
                'role_months': 0,
            },
        )

    for data, span in skills:
        if (k := sid(data['raw'])) is None:
            continue
        s = slot(k)
        s['spans'].add((span.start, span.end))
        if data['years_used']:
            s['years'] = max(s['years'], data['years_used'])
        if data['last_used'] and (s['last'] is None or data['last_used'] > s['last']):
            s['last'] = data['last_used']
    for n, (role, span) in enumerate(roles):
        months, last = _role_months(role, today)
        for term in role['skills_mentioned']:
            if (k := sid(term)) is None:
                continue
            s = slot(k)
            s['roles'].add(('role', n))
            s['spans'].add((span.start, span.end))
            s['role_months'] += months
            if last and (s['last'] is None or last > s['last']):
                s['last'] = last
    for n, (project, span) in enumerate(projects):
        for term in project['skills_mentioned']:
            if (k := sid(term)) is not None:
                s = slot(k)
                s['roles'].add(('project', n))
                s['spans'].add((span.start, span.end))
    for cert, _ in certs:
        if cert['certificate'] and (k := sid(cert['certificate'])) is not None and k in acc:
            acc[k]['cert'] = True
    return {
        k: SkillFacts(
            years_used=max(v['years'], v['role_months'] / 12) or None,
            last_used=v['last'],
            roles=len(v['roles']),
            certified=v['cert'],
            evidence_spans=len(v['spans']),
        )
        for k, v in acc.items()
    }


def _profile(
    resume: Any,
    items: dict[str, list[Entry]],
    sid: Any,
    scores: dict[str, tuple[float, float]],
    flags: list[str],
) -> dict[str, Any]:
    def spanned(kind: str) -> list[dict[str, Any]]:
        return [
            {**data, 'evidence_span': [span.start, span.end]} for data, span in items.get(kind, [])
        ]

    skills = []
    for data, span in items.get('skills', []):
        k = sid(data['raw'])
        p, c = scores.get(k, (None, None)) if k else (None, None)
        skills.append(
            {
                **data,
                'skill_id': k,
                'evidence_span': [span.start, span.end],
                'proficiency': p,
                'confidence': c,
            }
        )
    return {
        'schema_version': SCHEMA_VERSION,
        'summary': resume.summary,
        'current_title': resume.current_title,
        'total_experience_months': resume.total_experience_months,
        'work_history': spanned('work_history'),
        'education': spanned('education'),
        'certifications': spanned('certifications'),
        'projects': spanned('projects'),
        'skills': skills,
        'languages': resume.languages,
        'flags': sorted(set(flags)),
    }


def sections_of(prepared: Prepared) -> list[Section]:
    return [Section(t, '', s, e) for t, s, e in prepared.sections]
