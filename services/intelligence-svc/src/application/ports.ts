/** Ports of intelligence-svc (hexagonal rule, MASTER_ORCHESTRATION_PROMPT §4.1). */
import { type Tx } from '@atlas/platform';
import { type Allocation } from '../domain/availability';
import { type LearningItem, type Transition } from '../domain/career';
import { type DemandInput, type RowError } from '../domain/demand';
import { type ApplicationStatus, type OpportunityStatus } from '../domain/opportunity';
import { type SkillGap, type SkillRequirement } from '../domain/readiness';

export const EMPLOYEE_REPOSITORY = Symbol('EMPLOYEE_REPOSITORY');
export const CATALOGUE_REPOSITORY = Symbol('CATALOGUE_REPOSITORY');
export const OPPORTUNITY_REPOSITORY = Symbol('OPPORTUNITY_REPOSITORY');
export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');
export const DEMAND_REPOSITORY = Symbol('DEMAND_REPOSITORY');
export const ATTRITION_REPOSITORY = Symbol('ATTRITION_REPOSITORY');
export const WORK_QUEUE = Symbol('WORK_QUEUE');
export const VECTOR_SEARCH = Symbol('VECTOR_SEARCH');
export const EMBEDDER = Symbol('EMBEDDER');
export const TAXONOMY = Symbol('TAXONOMY');
export const DEMAND_SHEETS = Symbol('DEMAND_SHEETS');
export const INTEL_SETTINGS = Symbol('INTEL_SETTINGS');
export const INTEL_LOGGER = Symbol('INTEL_LOGGER');

export type Requirements = (SkillRequirement & { must_have: boolean })[];

// --- Employees ------------------------------------------------------------------------------

export interface Employee {
  tenantId: string;
  employeeId: string;
  userId: string | null;
  managerUserId: string | null;
  department: string | null;
  location: string | null;
  jobProfileId: string | null;
  hiredAt: string | null;
  roleStartedAt: string | null;
  lastPromotionAt: string | null;
  managerChangedAt: string | null;
  compaRatio: number | null;
  engagementDelta: number | null;
  overtimeHours4w: number | null;
  marketplaceOptIn: boolean;
  status: 'active' | 'terminated';
  terminatedAt: string | null;
  terminationVoluntary: boolean | null;
  sourceSyncedAt: Date;
}

export interface EmployeeSkillRow {
  skillId: string;
  proficiency: number;
  validated: boolean;
}

export interface RoleGapRow {
  employeeId: string;
  jobProfileId: string;
  roleGapPct: number;
  readiness: number;
  gaps: SkillGap[];
  department: string | null;
  location: string | null;
}

export interface Policy {
  applicationsVisibleToManager: boolean;
  learningHoursPerDay: number;
  attritionThreshold: number;
}

export const DEFAULT_POLICY: Policy = {
  applicationsVisibleToManager: false,
  learningHoursPerDay: 1,
  attritionThreshold: 0.35,
};

export interface EmployeeRepository {
  upsert(tx: Tx, e: Employee): Promise<{ previous: Employee | null }>;
  get(tx: Tx, employeeId: string): Promise<Employee | null>;
  byUser(tx: Tx, userId: string): Promise<Employee | null>;
  active(tx: Tx, employeeIds?: readonly string[]): Promise<Employee[]>;
  byJobProfile(tx: Tx, jobProfileId: string): Promise<string[]>;
  setProtected(tx: Tx, employeeId: string, attributes: Record<string, string>): Promise<void>;
  skills(tx: Tx, employeeIds: readonly string[]): Promise<Map<string, EmployeeSkillRow[]>>;
  /** Employees holding any of these skills (the structured half of the candidate pre-filter). */
  withAnySkill(tx: Tx, skillIds: readonly string[]): Promise<Set<string>>;
  replaceSkills(tx: Tx, employeeId: string, skills: readonly EmployeeSkillRow[]): Promise<void>;
  upsertRequisitionScores(
    tx: Tx,
    employeeId: string,
    scores: readonly { requisitionId: string; score: number; band: string }[],
    at: Date,
  ): Promise<void>;
  requisitionScores(tx: Tx, requisitionId: string): Promise<Map<string, number>>;
  saveRoleGap(tx: Tx, row: RoleGapRow, at: Date): Promise<void>;
  deleteRoleGap(tx: Tx, employeeId: string): Promise<RoleGapRow | null>;
  roleGap(tx: Tx, employeeId: string): Promise<RoleGapRow | null>;
  refreshGaps(
    tx: Tx,
    dimension: 'department' | 'job_profile' | 'location',
    groups: string[] | null,
  ): Promise<number>;
  heatmap(
    tx: Tx,
    dimension: 'department' | 'job_profile' | 'location',
    month: string,
  ): Promise<
    { groupKey: string; skillId: string; employees: number; gapSum: number; reqSum: number }[]
  >;
  policy(tx: Tx): Promise<Policy>;
  setPolicy(tx: Tx, p: Policy, by: string): Promise<void>;
  erase(tx: Tx, employeeId: string): Promise<number>;
}

// --- Catalogue: job profiles, transitions, learning -------------------------------------------

export interface JobProfileRow {
  jobProfileId: string;
  version: number;
  status: string;
  title: string;
  skills: Requirements;
}

export interface CatalogueRepository {
  upsertProfile(tx: Tx, p: JobProfileRow): Promise<boolean>;
  profile(tx: Tx, jobProfileId: string): Promise<JobProfileRow | null>;
  profiles(tx: Tx, ids: readonly string[]): Promise<Map<string, JobProfileRow>>;
  transitions(tx: Tx): Promise<Transition[]>;
  putTransition(tx: Tx, t: Transition): Promise<void>;
  deleteTransition(tx: Tx, from: string, to: string): Promise<boolean>;
  learningItems(tx: Tx): Promise<LearningItem[]>;
  putLearningItem(
    tx: Tx,
    item: LearningItem & {
      provider: string | null;
      url: string | null;
      external_ref: string | null;
    },
  ): Promise<void>;
}

// --- Opportunities ----------------------------------------------------------------------------

export type OpportunityType = 'role' | 'project' | 'gig';

export interface Opportunity {
  tenantId: string;
  id: string;
  type: OpportunityType;
  title: string;
  description: string;
  jobProfileId: string | null;
  requisitionId: string | null;
  projectId: string | null;
  skills: Requirements;
  allocationPct: number;
  startDate: string;
  endDate: string | null;
  location: string | null;
  minTenureMonths: number;
  status: OpportunityStatus;
  ownerUserId: string;
  embedding: number[] | null;
  embeddingModel: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  version: number;
}

export interface MatchRow {
  employeeId: string;
  score: number;
  availability: number;
  scoreInternal: number;
  readiness: number;
  explanation: Record<string, unknown>;
  lowConfidence: boolean;
  stale: boolean;
  computedAt: Date;
}

export interface Application {
  tenantId: string;
  id: string;
  opportunityId: string;
  employeeId: string;
  kind: 'application' | 'invitation';
  status: ApplicationStatus;
  note: string | null;
  disclosedToManager: boolean;
  createdBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  allocationId: string | null;
  createdAt: Date;
}

export interface OpportunityRepository {
  insert(tx: Tx, o: Opportunity): Promise<void>;
  get(tx: Tx, id: string): Promise<Opportunity | null>;
  update(
    tx: Tx,
    id: string,
    version: number,
    fields: Partial<Pick<Opportunity, 'status' | 'publishedAt' | 'embedding' | 'embeddingModel'>>,
  ): Promise<Opportunity | null>;
  open(tx: Tx): Promise<Opportunity[]>;
  openByRequisition(tx: Tx, requisitionId: string): Promise<Opportunity[]>;
  openByJobProfile(tx: Tx, jobProfileId: string): Promise<Opportunity[]>;
  replaceMatches(tx: Tx, opportunityId: string, matches: readonly MatchRow[]): Promise<void>;
  upsertMatch(tx: Tx, opportunityId: string, m: MatchRow | null, employeeId: string): Promise<void>;
  matches(tx: Tx, opportunityId: string, limit: number): Promise<MatchRow[]>;
  feed(
    tx: Tx,
    employeeId: string,
    limit: number,
  ): Promise<{ opportunity: Opportunity; match: MatchRow }[]>;
  match(tx: Tx, opportunityId: string, employeeId: string): Promise<MatchRow | null>;
  insertApplication(tx: Tx, a: Application): Promise<boolean>;
  application(tx: Tx, id: string): Promise<Application | null>;
  applications(
    tx: Tx,
    filter: { opportunityId?: string; employeeId?: string },
  ): Promise<Application[]>;
  updateApplication(
    tx: Tx,
    id: string,
    expected: ApplicationStatus,
    fields: Partial<
      Pick<
        Application,
        'status' | 'decidedBy' | 'decidedAt' | 'allocationId' | 'disclosedToManager'
      >
    >,
  ): Promise<Application | null>;
  eraseEmployee(tx: Tx, employeeId: string): Promise<number>;
}

// --- Projects and allocations -----------------------------------------------------------------

export interface Project {
  tenantId: string;
  id: string;
  name: string;
  accountId: string | null;
  startDate: string;
  endDate: string | null;
  status: 'active' | 'closed';
  createdBy: string;
}

export interface AllocationRow extends Allocation {
  id: string;
  projectId: string;
  employeeId: string;
  source: 'manual' | 'opportunity' | 'plan';
  opportunityId: string | null;
}

export class CapacityExceededError extends Error {
  constructor() {
    super('allocation over 100%');
    this.name = 'CapacityExceededError';
  }
}

export interface ProjectRepository {
  insert(tx: Tx, p: Project): Promise<void>;
  get(tx: Tx, id: string): Promise<Project | null>;
  /** Throws CapacityExceededError when the database refuses the booking (trigger). */
  allocate(tx: Tx, a: AllocationRow, by: string): Promise<void>;
  removeAllocation(tx: Tx, id: string): Promise<AllocationRow | null>;
  allocations(tx: Tx, employeeIds: readonly string[]): Promise<Map<string, AllocationRow[]>>;
  eraseEmployee(tx: Tx, employeeId: string): Promise<number>;
}

// --- Demand and fulfilment --------------------------------------------------------------------

export interface DemandRepository {
  insertBatch(
    tx: Tx,
    b: {
      id: string;
      fileName: string;
      status: 'processed' | 'failed';
      rowsTotal: number;
      rowsLoaded: number;
      errors: RowError[];
      by: string;
    },
  ): Promise<void>;
  batch(tx: Tx, id: string): Promise<Record<string, unknown> | null>;
  upsertDemand(tx: Tx, batchId: string, id: string, d: DemandInput): Promise<string>;
  list(
    tx: Tx,
    filter: { status?: string; accountId?: string; batchId?: string },
  ): Promise<Record<string, unknown>[]>;
  queuePlan(
    tx: Tx,
    p: { id: string; accountId: string | null; horizonDays: number; by: string },
  ): Promise<{ id: string; created: boolean }>;
  plan(tx: Tx, id: string): Promise<Record<string, unknown> | null>;
  planLines(tx: Tx, id: string): Promise<Record<string, unknown>[]>;
}

// --- Attrition (HRBP only) ----------------------------------------------------------------------

export interface AttritionRepository {
  /** Binds the transaction to the HRBP policy (app.hrbp = 'on'); without it the tables are empty. */
  asHrbp(tx: Tx): Promise<void>;
  alerts(tx: Tx, status: string | null, limit: number): Promise<Record<string, unknown>[]>;
  acknowledge(tx: Tx, alertId: string, by: string, at: Date): Promise<boolean>;
  scores(tx: Tx, employeeId: string, limit: number): Promise<Record<string, unknown>[]>;
  activeModel(tx: Tx): Promise<Record<string, unknown> | null>;
  audit(tx: Tx, subject: string, action: string, target: string | null): Promise<void>;
  eraseEmployee(tx: Tx, employeeId: string): Promise<number>;
}

// --- Work queue ---------------------------------------------------------------------------------

export interface WorkItem {
  tenantId: string;
  kind: 'opportunity' | 'employee';
  subjectId: string;
  reason: string;
  attempts?: number;
}

export interface WorkQueue {
  enqueue(tx: Tx, item: WorkItem): Promise<void>;
  /** System transaction: the next due items across tenants. */
  due(tx: Tx, limit: number, now: Date): Promise<WorkItem[]>;
  done(tx: Tx, item: WorkItem): Promise<void>;
  retry(tx: Tx, item: WorkItem, at: Date): Promise<void>;
  deleteSubject(tx: Tx, subjectId: string): Promise<number>;
}

// --- Outside services -------------------------------------------------------------------------

export interface ChunkHit {
  candidateId: string;
  vector: number[] | null;
  similarity: number;
}

/** parsing-svc's vector index over profile chunks (the same API matching-svc uses). */
export interface VectorSearch {
  activeModel(): Promise<string>;
  ann(tenantId: string, vector: number[], model: string, k: number): Promise<ChunkHit[]>;
  closestChunks(
    tenantId: string,
    vector: number[],
    model: string,
    candidateIds: string[],
    perCandidate: number,
  ): Promise<ChunkHit[]>;
}

export interface Embedder {
  embed(tenantId: string, text: string, model: string): Promise<number[]>;
}

export interface Taxonomy {
  related(tenantId: string, skillId: string): Promise<{ skillId: string; rho: number }[]>;
}

/** Spreadsheet decoding (xlsx through exceljs; csv in the domain). */
export interface DemandSheets {
  rows(fileName: string, content: Buffer): Promise<string[][]>;
}

export interface IntelSettings {
  /** Above this many eligible employees, an ANN pre-filter picks the candidates to rescore. */
  annThreshold: number;
  annCandidates: number;
  maxUploadBytes: number;
  workBatch: number;
  workPollMs: number;
}

export const DEFAULT_INTEL_SETTINGS: IntelSettings = {
  annThreshold: 2000,
  annCandidates: 1000,
  maxUploadBytes: 5 * 1024 * 1024,
  workBatch: 20,
  workPollMs: 1000,
};

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}
