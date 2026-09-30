// Invigilator allocation (spec section 7). Pure so it can be tested
// exhaustively; the caller supplies loads read under row locks and the
// database trigger remains the final guard on the limit.

export const PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR = 10;

export interface InvigilatorLoad {
  id: string;
  /** Active candidates across all sessions. */
  load: number;
  /** Per-invigilator ceiling (never above the platform maximum). */
  capacity: number;
}

export interface AllocationResult {
  assignments: { candidateId: string; invigilatorId: string }[];
  unassigned: string[];
}

export function allocate(
  candidateIds: readonly string[],
  invigilators: readonly InvigilatorLoad[],
  options: {
    sessionCap?: number;
    random?: () => number;
    /** For rotation: the invigilator each candidate should move away from, when anyone else has room. */
    avoid?: ReadonlyMap<string, string>;
  } = {},
): AllocationResult {
  const cap = (inv: InvigilatorLoad) =>
    Math.min(inv.capacity, options.sessionCap ?? PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR, PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR);
  const pool = invigilators.map((inv) => ({ ...inv, tiebreak: options.random ? options.random() : 0 }));
  const result: AllocationResult = { assignments: [], unassigned: [] };

  for (const candidateId of candidateIds) {
    // Least-loaded first keeps work balanced; ties broken randomly when
    // random monitoring is enabled, otherwise by id for determinism.
    const avoid = options.avoid?.get(candidateId);
    const eligible = pool.filter((inv) => inv.load < cap(inv));
    const others = eligible.filter((inv) => inv.id !== avoid);
    let best: (typeof pool)[number] | undefined;
    for (const inv of others.length ? others : eligible) {
      if (
        !best ||
        inv.load < best.load ||
        (inv.load === best.load && (inv.tiebreak < best.tiebreak || (inv.tiebreak === best.tiebreak && inv.id < best.id)))
      ) {
        best = inv;
      }
    }
    if (!best) {
      result.unassigned.push(candidateId);
      continue;
    }
    best.load += 1;
    if (options.random) best.tiebreak = options.random();
    result.assignments.push({ candidateId, invigilatorId: best.id });
  }
  return result;
}

export type InvigilatorLiveStatus = 'available' | 'monitoring' | 'at_capacity' | 'paused' | 'suspended';

export function liveStatus(adminStatus: 'active' | 'paused' | 'suspended', load: number, capacity: number): InvigilatorLiveStatus {
  if (adminStatus !== 'active') return adminStatus;
  if (load >= Math.min(capacity, PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR)) return 'at_capacity';
  return load > 0 ? 'monitoring' : 'available';
}
