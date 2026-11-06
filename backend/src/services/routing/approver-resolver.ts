import { calendarDate } from "../../domain/dates.js";
import type { Role } from "../../domain/enums.js";
import type { Approver } from "../../domain/models.js";
import type { Clock } from "../../ports/clock.js";
import type { ReferenceData } from "../../ports/reference-data.port.js";

/**
 * Who will actually approve, and how we got there. `path` lists every approver
 * considered (e.g. ["U02", "U04"] when U02 is out), so the audit log and the UI
 * can explain a backup routing.
 */
export type ApproverResolution =
  | { ok: true; approverId: string; path: string[] }
  | { ok: false; reason: string; path: string[] };

/** Options for {@link ApproverResolver}. */
export interface ApproverResolverOptions {
  /** IANA zone whose calendar date decides out-of-office (inclusive dates). */
  timeZone: string;
}

/**
 * Finds the approver for a role (and, for regional managers, the customer's
 * region), then applies rule 7: if they are out of office today, route to their
 * `backup_approver_id`, repeatedly, until someone is in.
 *
 * Why the loop guard: backups are data maintained by people (U01 -> U04 -> U05,
 * but a typo could make A -> B -> A). A cycle or dead end yields `ok: false`,
 * which the processor turns into a specialist flag rather than an infinite
 * loop or a silent mis-route.
 */
export class ApproverResolver {
  constructor(
    private readonly referenceData: ReferenceData,
    private readonly clock: Clock,
    private readonly options: ApproverResolverOptions,
  ) {}

  /**
   * Resolve the available approver for `role`. With `matchRegion`, an approver
   * for the customer's exact region is preferred, then one covering "ALL".
   */
  resolve(role: Role, customerRegion: string | null, matchRegion: boolean): ApproverResolution {
    const primary = this.findPrimary(role, customerRegion, matchRegion);
    if (typeof primary === "string") return { ok: false, reason: primary, path: [] };
    return this.followBackups(primary.approver_id);
  }

  /**
   * Starting from `approverId`, follow backups past anyone out of office today.
   * Public so a reroute after an edit can reuse it for a specific person.
   */
  followBackups(approverId: string): ApproverResolution {
    const today = calendarDate(this.clock.now(), this.options.timeZone);
    const path: string[] = [];
    let currentId: string | null = approverId;

    while (currentId !== null) {
      if (path.includes(currentId)) {
        return { ok: false, reason: `backup chain loops (${[...path, currentId].join(" -> ")})`, path };
      }
      path.push(currentId);

      const approver = this.referenceData.getApprover(currentId);
      if (!approver) {
        return { ok: false, reason: `approver ${currentId} not found in reporting data`, path };
      }
      if (!isOutOfOffice(approver, today)) {
        return { ok: true, approverId: approver.approver_id, path };
      }
      currentId = approver.backup_approver_id;
    }
    return { ok: false, reason: `${path.join(" -> ")} out of office with no further backup`, path };
  }

  /** Returns the primary approver, or a reason string when none fits. */
  private findPrimary(role: Role, customerRegion: string | null, matchRegion: boolean): Approver | string {
    const withRole = this.referenceData
      .listApprovers()
      .filter((a) => a.role === role)
      .sort((a, b) => a.approver_id.localeCompare(b.approver_id));

    if (matchRegion) {
      if (customerRegion === null) return `customer region unknown; cannot pick a ${role}`;
      const match =
        withRole.find((a) => a.region === customerRegion) ?? withRole.find((a) => a.region === "ALL");
      return match ?? `no ${role} for region ${customerRegion}`;
    }
    return withRole.find((a) => a.region === "ALL") ?? withRole[0] ?? `no approver with role ${role}`;
  }
}

/** Out-of-office ranges are inclusive; an open end means "until further notice" / "since forever". */
function isOutOfOffice(approver: Approver, today: string): boolean {
  const { out_of_office_from: from, out_of_office_to: to } = approver;
  if (from === null && to === null) return false;
  return (from === null || from <= today) && (to === null || today <= to);
}
