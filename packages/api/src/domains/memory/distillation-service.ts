// F152 Phase C: Distillation service for global lesson reflow (AC-C1/C3)
// Manages the candidate queue: nominate -> pending -> approve/reject -> materialize durable truth.
// Candidates persist in project store SQLite. Approved output materializes to .md files
// that GlobalIndexBuilder discovers and compiles into global_knowledge.sqlite.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DeidentificationService, type DeidentifiedEvidence } from './deidentification-service.js';
import type { CausalExtraction, ConflictAssessment } from '@cat-cafe/shared';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';

const DISTILLABLE_KINDS = new Set(['lesson', 'decision']);

/** F-EXT: keyword-overlap ratio above which a candidate is flagged as conflicting with an existing truth. */
const CONFLICT_KEYWORD_OVERLAP_THRESHOLD = 0.5;

export interface DistillationCandidate {
  id: string;
  anchor: string;
  status: 'pending' | 'approved' | 'rejected';
  evidence: DeidentifiedEvidence;
  nominatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  /** F-EXT: causal memory extracted from the source thread — the structured causal chain. */
  causal?: CausalExtraction;
  /** F-EXT: conflict assessment against existing durable truths (if any). */
  conflict?: ConflictAssessment;
}

export interface MaterializedTruth {
  id: string;
  anchor: string;
  kind: string;
  title: string;
  summary: string;
  keywords: string[];
  approvedBy: string;
  approvedAt: string;
  filePath: string;
  /** F-EXT: anchors of truths this one supersedes/contradicts (set when force-approved over a conflict). */
  contradicts?: string[];
}

export interface DistillationConfig {
  /** Directory where approved truths are materialized as .md files. */
  distilledRoot?: string;
}

/** F271 consumption interface: write approved truths without owning promotion/rejection. */
export interface DurableTruthPort {
  materialize(candidate: DistillationCandidate): Promise<MaterializedTruth>;
  listMaterialized(): MaterializedTruth[];
}

export class DistillationService implements DurableTruthPort {
  private readonly projectStore: SqliteEvidenceStore;
  private readonly globalStore: SqliteEvidenceStore;
  private readonly distilledRoot: string;

  constructor(projectStore: SqliteEvidenceStore, globalStore: SqliteEvidenceStore, config?: DistillationConfig) {
    this.projectStore = projectStore;
    this.globalStore = globalStore;
    this.distilledRoot = config?.distilledRoot ?? join(homedir(), '.cat-cafe', 'distilled-truths');
  }

  async initialize(): Promise<void> {
    // Ensure distilled root exists
    mkdirSync(this.distilledRoot, { recursive: true });

    // Create persistent candidate table in project store
    const db = this.projectStore.getDb();
    if (db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS distillation_candidates (
          id TEXT PRIMARY KEY,
          anchor TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'pending',
          evidence_json TEXT NOT NULL,
          project_path TEXT,
          nominated_at TEXT NOT NULL,
          reviewed_by TEXT,
          reviewed_at TEXT,
          materialized_path TEXT
        )
      `);
      // F-EXT: additive migration — add causal + conflict columns if missing (idempotent).
      const cols = new Set(
        (db.prepare('PRAGMA table_info(distillation_candidates)').all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (!cols.has('causal_json')) db.exec('ALTER TABLE distillation_candidates ADD COLUMN causal_json TEXT');
      if (!cols.has('conflict_json')) db.exec('ALTER TABLE distillation_candidates ADD COLUMN conflict_json TEXT');
    }
  }

  async nominate(
    anchor: string,
    projectPath: string,
    options?: { personNames?: string[]; causal?: CausalExtraction },
  ): Promise<DistillationCandidate> {
    const db = this.projectStore.getDb();

    // Check for existing candidate: idempotent for pending/approved, re-entrant for rejected
    if (db) {
      const existing = db
        .prepare(
          'SELECT id, anchor, status, evidence_json, nominated_at, reviewed_by, reviewed_at, causal_json, conflict_json FROM distillation_candidates WHERE anchor = ?',
        )
        .get(anchor) as CandidateRow | undefined;
      if (existing) {
        if (existing.status === 'rejected') {
          // Allow re-nomination after rejection: delete old row, fall through to create new
          db.prepare('DELETE FROM distillation_candidates WHERE id = ?').run(existing.id);
        } else {
          // pending or approved — return existing (idempotent)
          return rowToCandidate(existing);
        }
      }
    }

    const item = await this.projectStore.getByAnchor(anchor);
    if (!item) throw new Error(`Anchor "${anchor}" not found`);
    if (!item.generalizable) throw new Error(`Item "${anchor}" is not marked as generalizable`);
    if (!DISTILLABLE_KINDS.has(item.kind)) {
      throw new Error(`Item kind "${item.kind}" is not distillable (allowed: lesson, decision)`);
    }

    // P1 fix: create deidentifier per-request using the caller's projectPath
    const deidentifier = new DeidentificationService(projectPath, {
      personNames: options?.personNames,
    });
    const evidence = deidentifier.sanitize(item);
    // F-EXT: causal chain — explicit override from caller, else carried from the stored EvidenceItem.
    const causal = options?.causal ?? item.causal;
    // F-EXT: conflict assessment against existing durable truths (confirmation feedback gate).
    const conflict = this.assessConflict(evidence, anchor);
    const candidate: DistillationCandidate = {
      id: randomUUID(),
      anchor,
      status: 'pending',
      evidence,
      nominatedAt: new Date().toISOString(),
      ...(causal ? { causal } : {}),
      ...(conflict ? { conflict } : {}),
    };

    // Persist to SQLite
    if (db) {
      db.prepare(`
        INSERT INTO distillation_candidates (id, anchor, status, evidence_json, project_path, nominated_at, causal_json, conflict_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.id,
        candidate.anchor,
        candidate.status,
        JSON.stringify(candidate.evidence),
        projectPath,
        candidate.nominatedAt,
        candidate.causal ? JSON.stringify(candidate.causal) : null,
        candidate.conflict ? JSON.stringify(candidate.conflict) : null,
      );
    }

    return candidate;
  }

  /**
   * F-EXT: confirmation-feedback conflict gate.
   * Scans already-materialized durable truths for keyword overlap with this candidate.
   * High overlap (same topic) with a divergent claim is surfaced as a `keyword_overlap`
   * conflict so the human reviewer can reject the duplicate/conflicting memory instead of
   * silently approving a second, contradictory truth. Pure + deterministic (no LLM call).
   */
  assessConflict(evidence: DeidentifiedEvidence, anchor: string): ConflictAssessment | null {
    // Topic identity is best captured by the curated keyword tags, not raw title/summary
    // text (a divergent claim that introduces new terms would otherwise dilute the ratio).
    // Score on keyword overlap when both sides have keywords; fall back to tokenized text.
    const candidateKw = new Set(evidence.sanitizedKeywords);
    const candidateTerms = tokenizeForConflict(evidence.sanitizedTitle, evidence.sanitizedSummary, ...evidence.sanitizedKeywords);
    if (candidateKw.size === 0 && candidateTerms.size === 0) return null;
    let best: ConflictAssessment | null = null;
    for (const truth of this.listMaterialized()) {
      if (truth.anchor === anchor) continue;
      // Explicit contradiction edges take precedence.
      if (truth.contradicts?.includes(anchor)) {
        return { basis: 'explicit_contradiction', conflictingAnchor: truth.anchor, conflictingTitle: truth.title, score: 1 };
      }
      const truthKw = new Set(truth.keywords);
      const truthTerms = tokenizeForConflict(truth.title, truth.summary, ...truth.keywords);
      let overlap: number;
      let score: number;
      if (candidateKw.size > 0 && truthKw.size > 0) {
        overlap = intersectionSize(candidateKw, truthKw);
        score = overlap / candidateKw.size;
      } else {
        overlap = intersectionSize(candidateTerms, truthTerms);
        score = candidateTerms.size > 0 ? overlap / candidateTerms.size : 0;
      }
      if (overlap === 0) continue;
      if (score >= CONFLICT_KEYWORD_OVERLAP_THRESHOLD && (!best || score > best.score)) {
        best = { basis: 'keyword_overlap', conflictingAnchor: truth.anchor, conflictingTitle: truth.title, score };
      }
    }
    return best;
  }

  async approve(candidateId: string, reviewerId: string, options?: { force?: boolean }): Promise<void> {
    const candidate = this.getCandidate(candidateId);
    if (!candidate) throw new Error(`Candidate "${candidateId}" not found`);
    // F-EXT: conflict gate — if this candidate conflicts with an existing truth, block approval
    // unless the reviewer explicitly forces it. Forcing records a `contradicts` edge so the
    // older truth is superseded rather than silently duplicated.
    if (candidate.conflict && !options?.force) {
      throw new Error(
        `Candidate "${candidateId}" conflicts with "${candidate.conflict.conflictingTitle ?? candidate.conflict.conflictingAnchor}" (score ${candidate.conflict.score.toFixed(2)}). Approve with force:true to supersede.`,
      );
    }

    candidate.status = 'approved';
    candidate.reviewedBy = reviewerId;
    candidate.reviewedAt = new Date().toISOString();

    // Materialize to durable truth file (survives rebuilds)
    const truth = await this.materialize(candidate, options?.force ? candidate.conflict?.conflictingAnchor : undefined);

    // Also upsert to globalStore for immediate searchability (before next rebuild)
    await this.globalStore.upsert([
      {
        anchor: truth.anchor,
        kind: truth.kind as import('./interfaces.js').EvidenceKind,
        status: 'active',
        title: truth.title,
        summary: truth.summary,
        keywords: truth.keywords,
        updatedAt: truth.approvedAt,
        ...(truth.contradicts && truth.contradicts.length > 0 ? { contradicts: truth.contradicts } : {}),
      },
    ]);

    // Update candidate record with materialized path
    const db = this.projectStore.getDb();
    if (db) {
      db.prepare(`
        UPDATE distillation_candidates
        SET status = 'approved', reviewed_by = ?, reviewed_at = ?, materialized_path = ?
        WHERE id = ?
      `).run(reviewerId, candidate.reviewedAt, truth.filePath, candidateId);
    }
  }

  async reject(candidateId: string, reviewerId: string): Promise<void> {
    const candidate = this.getCandidate(candidateId);
    if (!candidate) throw new Error(`Candidate "${candidateId}" not found`);

    const db = this.projectStore.getDb();
    if (db) {
      db.prepare(`
        UPDATE distillation_candidates
        SET status = 'rejected', reviewed_by = ?, reviewed_at = ?
        WHERE id = ?
      `).run(reviewerId, new Date().toISOString(), candidateId);
    }
  }

  async listPending(): Promise<DistillationCandidate[]> {
    const db = this.projectStore.getDb();
    if (!db) return [];

    const rows = db
      .prepare(
        'SELECT id, anchor, status, evidence_json, nominated_at, reviewed_by, reviewed_at, causal_json, conflict_json FROM distillation_candidates WHERE status = ?',
      )
      .all('pending') as CandidateRow[];

    return rows.map(rowToCandidate);
  }

  /** F271 consumption interface: materialize an approved candidate as a durable .md truth file. */
  async materialize(candidate: DistillationCandidate, supersedesAnchor?: string): Promise<MaterializedTruth> {
    mkdirSync(this.distilledRoot, { recursive: true });

    const contradicts = supersedesAnchor
      ? [supersedesAnchor, ...(findContradictsFor(this.listMaterialized(), supersedesAnchor) ?? [])]
      : undefined;

    const truth: MaterializedTruth = {
      id: candidate.id,
      anchor: `distilled:${candidate.id}`,
      kind: candidate.evidence.original.kind,
      title: candidate.evidence.sanitizedTitle,
      summary: candidate.evidence.sanitizedSummary,
      keywords: candidate.evidence.sanitizedKeywords,
      approvedBy: candidate.reviewedBy ?? 'unknown',
      approvedAt: candidate.reviewedAt ?? new Date().toISOString(),
      filePath: join(this.distilledRoot, `${candidate.id}.md`),
      ...(contradicts && contradicts.length > 0 ? { contradicts } : {}),
    };

    // Write durable truth file -- this is the source of truth that survives rebuilds.
    // GlobalIndexBuilder discovers and compiles these into global_knowledge.sqlite.
    const causalBlock = candidate.causal
      ? [
          '## Causal Trace',
          '',
          `trigger: ${candidate.causal.trigger}`,
          `action: ${candidate.causal.action}`,
          `result: ${candidate.causal.result}`,
          `lesson: ${candidate.causal.lesson}`,
          `causal_confidence: ${candidate.causal.causalConfidence}`,
          '',
        ]
      : [];
    const content = [
      '---',
      'type: distilled',
      `kind: ${truth.kind}`,
      `source_anchor: ${candidate.anchor}`,
      `approved_by: ${truth.approvedBy}`,
      `approved_at: ${truth.approvedAt}`,
      `candidate_id: ${candidate.id}`,
      truth.keywords.length > 0 ? `keywords: [${truth.keywords.join(', ')}]` : null,
      truth.contradicts && truth.contradicts.length > 0 ? `contradicts: [${truth.contradicts.join(', ')}]` : null,
      '---',
      '',
      `# ${truth.title}`,
      '',
      truth.summary,
      '',
      ...causalBlock,
    ]
      .filter((line): line is string => line != null)
      .join('\n');

    writeFileSync(truth.filePath, content, 'utf-8');
    return truth;
  }

  /** List all materialized truth files from the distilled root. */
  listMaterialized(): MaterializedTruth[] {
    if (!existsSync(this.distilledRoot)) return [];

    const truths: MaterializedTruth[] = [];
    for (const file of readdirSync(this.distilledRoot)) {
      if (!file.endsWith('.md')) continue;
      const filePath = join(this.distilledRoot, file);
      const content = readFileSync(filePath, 'utf-8');
      const truth = parseTruthFile(filePath, content);
      if (truth) truths.push(truth);
    }
    return truths;
  }

  private getCandidate(candidateId: string): DistillationCandidate | null {
    const db = this.projectStore.getDb();
    if (!db) return null;

    const row = db
      .prepare(
        'SELECT id, anchor, status, evidence_json, nominated_at, reviewed_by, reviewed_at, causal_json, conflict_json FROM distillation_candidates WHERE id = ?',
      )
      .get(candidateId) as CandidateRow | undefined;

    return row ? rowToCandidate(row) : null;
  }
}

// -- Internal types and helpers -------------------------------------------------

interface CandidateRow {
  id: string;
  anchor: string;
  status: string;
  evidence_json: string;
  nominated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  causal_json?: string | null;
  conflict_json?: string | null;
}

function rowToCandidate(row: CandidateRow): DistillationCandidate {
  const causal = row.causal_json ? (JSON.parse(row.causal_json) as CausalExtraction) : undefined;
  const conflict = row.conflict_json ? (JSON.parse(row.conflict_json) as ConflictAssessment) : undefined;
  return {
    id: row.id,
    anchor: row.anchor,
    status: row.status as DistillationCandidate['status'],
    evidence: JSON.parse(row.evidence_json),
    nominatedAt: row.nominated_at,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
    ...(causal ? { causal } : {}),
    ...(conflict ? { conflict } : {}),
  };
}

// ── F-EXT: conflict-gate helpers ──────────────────────────────────

/** Find existing truth files that already list `anchor` in their contradicts field (chained supersession). */
function findContradictsFor(materialized: readonly MaterializedTruth[], anchor: string): string[] | undefined {
  const chained = materialized.filter((t) => t.contradicts?.includes(anchor)).map((t) => t.anchor);
  return chained.length > 0 ? chained : undefined;
}

/** Light tokenization for conflict overlap: split on non-word, drop stopwords/short tokens. */
function tokenizeForConflict(...texts: Array<string | undefined>): Set<string> {
  const stop = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'is', 'was', 'be', 'this', 'that']);
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const raw of t.toLowerCase().split(/[^a-z0-9一-龥]+/i)) {
      const tok = raw.trim();
      if (tok.length < 3 || stop.has(tok)) continue;
      out.add(tok);
    }
  }
  return out;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function parseTruthFile(filePath: string, content: string): MaterializedTruth | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch?.[1]) return null;

  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split('\n')) {
    const kv = line.match(/^(\w[\w_]*):\s*(.+)$/);
    if (kv) fm[kv[1]!] = kv[2]!.trim();
  }

  if (fm.type !== 'distilled') return null;

  const candidateId = fm.candidate_id ?? filePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const bodyStart = content.indexOf('---', 4);
  const afterFm = bodyStart >= 0 ? content.slice(content.indexOf('\n', bodyStart) + 1).trim() : '';
  const lines = afterFm.split('\n');
  const titleLine = lines.findIndex((l) => l.startsWith('# '));
  const summaryLines =
    titleLine >= 0
      ? lines
          .slice(titleLine + 1)
          .join('\n')
          .trim()
      : afterFm;

  // Parse keywords from frontmatter
  let keywords: string[] = [];
  if (fm.keywords) {
    const kwMatch = fm.keywords.match(/\[(.+)]/);
    if (kwMatch) keywords = kwMatch[1].split(',').map((s) => s.trim());
  }

  // Parse contradicts from frontmatter (F-EXT conflict edges)
  let contradicts: string[] | undefined;
  if (fm.contradicts) {
    const cMatch = fm.contradicts.match(/\[(.+)]/);
    if (cMatch) contradicts = cMatch[1].split(',').map((s) => s.trim());
  }

  return {
    id: candidateId,
    anchor: `distilled:${candidateId}`,
    kind: fm.kind ?? 'lesson',
    title: titleMatch?.[1] ?? candidateId,
    summary: summaryLines,
    keywords,
    approvedBy: fm.approved_by ?? 'unknown',
    approvedAt: fm.approved_at ?? '',
    filePath,
    ...(contradicts && contradicts.length > 0 ? { contradicts } : {}),
  };
}
