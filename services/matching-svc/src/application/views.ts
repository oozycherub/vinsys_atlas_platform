import { type Requisition } from '../domain/requisition';

export interface RequisitionView {
  requisition_id: string;
  tenant_id: string;
  title: string;
  description: string;
  openings: number;
  location: string | null;
  hiring_manager_id: string | null;
  job_profile_id: string | null;
  min_experience_years: number | null;
  keywords: string[];
  status: string;
  calibration: {
    status: string;
    version: number;
    calibrated_at: string | null;
    source: string | null;
    job_profile_version: number | null;
    embedding_model: string | null;
    skills: {
      skill_id: string;
      name: string | null;
      weight: number;
      target: number;
      must_have: boolean;
      related: number;
    }[];
  };
  version: number;
  created_at: string;
  updated_at: string;
}

export function toRequisitionView(r: Requisition): RequisitionView {
  return {
    requisition_id: r.id,
    tenant_id: r.tenantId,
    title: r.title,
    description: r.description,
    openings: r.openings,
    location: r.location,
    hiring_manager_id: r.hiringManagerId,
    job_profile_id: r.jobProfileId,
    min_experience_years: r.minExperienceYears,
    keywords: r.keywords,
    status: r.status,
    calibration: {
      status: r.calibrationStatus,
      version: r.calibrationVersion,
      calibrated_at: r.calibratedAt?.toISOString() ?? null,
      source: r.calibration?.source ?? null,
      job_profile_version: r.calibration?.job_profile_version ?? null,
      embedding_model: r.calibration?.embedding_model ?? null,
      skills: (r.calibration?.skills ?? []).map((s) => ({
        skill_id: s.skill_id,
        name: s.name,
        weight: s.weight,
        target: s.target,
        must_have: s.must_have,
        related: s.related.length,
      })),
    },
    version: r.version,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}
