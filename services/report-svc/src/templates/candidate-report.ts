import { type EvidenceFrame } from '../application/ports';
import { overallScore, type SessionFacts, status } from '../domain/facts';
import { type SectionConfig, SECTIONS } from '../domain/sections';

/**
 * The candidate assessment report as HTML for Chromium to print (ADR-0010 §9). Static: no
 * scripts, a CSP that forbids them, images only as data: URLs. Every value is escaped.
 */
export interface CandidateReportModel {
  tenantName: string | null;
  candidateName: string | null;
  facts: SessionFacts;
  sections: SectionConfig;
  skillNames: Map<string, string>;
  evidence: EvidenceFrame[];
  generatedAt: Date;
}

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const fmt = (d: Date | null) => (d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const score = (n: number | null) => (n === null ? '—' : n.toFixed(1));
const RECOMMENDATION: Record<string, string> = {
  advance: 'Advance',
  hold: 'Hold',
  do_not_advance: 'Do not advance',
};

const CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1d2433; font-size: 11pt; }
  h1 { font-size: 20pt; margin: 0 0 4mm; }
  h2 { font-size: 13pt; border-bottom: 1px solid #c9d1e0; padding-bottom: 1mm; margin: 8mm 0 3mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 1.5mm 2mm; border-bottom: 1px solid #e3e8f0; vertical-align: top; }
  th { background: #f3f5f9; font-weight: bold; }
  .muted { color: #5b6478; font-size: 9pt; }
  .band { display: inline-block; padding: 0.5mm 2mm; border-radius: 2mm; font-weight: bold; }
  .band-green { background: #dff3e4; } .band-yellow { background: #fff3cd; } .band-red { background: #f8d7da; }
  .frames { display: flex; flex-wrap: wrap; gap: 3mm; }
  .frame { width: 55mm; } .frame img { width: 55mm; border: 1px solid #c9d1e0; }
  section { page-break-inside: avoid; }
`;

function summary(m: CandidateReportModel): string {
  const f = m.facts;
  return `<section id="summary"><h2>${SECTIONS.summary.title}</h2><table>
    <tr><th scope="row">Candidate</th><td>${esc(m.candidateName ?? `Candidate ${f.candidateId?.slice(0, 8) ?? ''}`)}</td></tr>
    <tr><th scope="row">Assessment</th><td>${esc(f.assessmentId ?? '—')}${f.assessmentVersion ? ` (v${esc(f.assessmentVersion)})` : ''}</td></tr>
    <tr><th scope="row">Attempt</th><td>${esc(f.attemptNo ?? '—')}</td></tr>
    <tr><th scope="row">Started</th><td>${esc(fmt(f.startedAt))}</td></tr>
    <tr><th scope="row">Submitted</th><td>${esc(fmt(f.submittedAt))}</td></tr>
    <tr><th scope="row">Status</th><td>${esc(status(f))}${f.terminatedReason ? ` — ${esc(f.terminatedReason)}` : ''}</td></tr>
    <tr><th scope="row">Overall score</th><td>${esc(score(overallScore(f.skills)))} / 5</td></tr>
  </table></section>`;
}

function skills(m: CandidateReportModel): string {
  const rows = (m.facts.skills ?? [])
    .map(
      (s) =>
        `<tr><td>${esc(m.skillNames.get(s.skillId) ?? s.skillId)}</td><td>${esc(score(s.score))}</td><td>${esc(Math.round(s.confidence * 100))}%</td></tr>`,
    )
    .join('');
  return `<section id="skill_scores"><h2>${SECTIONS.skill_scores.title}</h2>${
    rows
      ? `<table><thead><tr><th scope="col">Skill</th><th scope="col">Score (0–5)</th><th scope="col">Confidence</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted">Not evaluated yet.</p>'
  }</section>`;
}

function integrity(m: CandidateReportModel): string {
  const f = m.facts;
  if (f.trustScore === null)
    return `<section id="integrity"><h2>${SECTIONS.integrity.title}</h2><p class="muted">No proctoring result.</p></section>`;
  const breakdown = Object.entries(f.trustBreakdown ?? {})
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td>−${esc(v)}</td></tr>`)
    .join('');
  const band = ['green', 'yellow', 'red'].includes(f.trustBand ?? '') ? f.trustBand : 'yellow';
  return `<section id="integrity"><h2>${SECTIONS.integrity.title}</h2>
    <p>Trust Score <strong>${esc(f.trustScore)}</strong> <span class="band band-${band}">${esc(f.trustBand)}</span>${
      f.trustReview
        ? ' — <strong>human review required</strong>; no decision is made on this score alone.'
        : ''
    }</p>
    ${breakdown ? `<table><thead><tr><th scope="col">Signal</th><th scope="col">Points</th></tr></thead><tbody>${breakdown}</tbody></table>` : ''}
  </section>`;
}

function evidence(m: CandidateReportModel): string {
  const frames = m.evidence
    .filter((e) => IMAGE_TYPES.has(e.contentType))
    .map(
      (e) =>
        `<figure class="frame"><img alt="${esc(e.label)}" src="data:${e.contentType};base64,${e.data.toString('base64')}"><figcaption class="muted">${esc(e.label)} · ${esc(e.capturedAt)}</figcaption></figure>`,
    )
    .join('');
  return `<section id="proctoring_evidence"><h2>${SECTIONS.proctoring_evidence.title}</h2>${
    frames ? `<div class="frames">${frames}</div>` : '<p class="muted">No flagged frames.</p>'
  }</section>`;
}

function interview(m: CandidateReportModel): string {
  const i = m.facts.interview;
  if (!i)
    return `<section id="ai_interview"><h2>${SECTIONS.ai_interview.title}</h2><p class="muted">No AI interview.</p></section>`;
  const rows = i.competencies
    .map(
      (c) =>
        `<tr><td>${esc(m.skillNames.get(c.skillId) ?? c.skillId)}</td><td>${c.score === null ? 'Insufficient evidence' : esc(c.score)}</td></tr>`,
    )
    .join('');
  return `<section id="ai_interview"><h2>${SECTIONS.ai_interview.title}</h2>
    <p>Recommendation: <strong>${esc(i.recommendation ? RECOMMENDATION[i.recommendation] : '—')}</strong>${
      i.needsReview ? ' (pending human review)' : ''
    }</p>
    ${rows ? `<table><thead><tr><th scope="col">Competency</th><th scope="col">Score (1–5)</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
  </section>`;
}

export function renderCandidateReport(m: CandidateReportModel): string {
  const parts = [summary(m), skills(m)];
  if (m.sections.integrity) parts.push(integrity(m));
  if (m.sections.proctoring_evidence) parts.push(evidence(m));
  if (m.sections.ai_interview) parts.push(interview(m));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Assessment report</title><style>${CSS}</style></head>
<body>
<header><h1>Assessment report</h1><p class="muted">${esc(m.tenantName ?? '')} · Generated ${esc(fmt(m.generatedAt))} · Confidential</p></header>
${parts.join('\n')}
</body></html>`;
}
