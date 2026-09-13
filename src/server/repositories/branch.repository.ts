import { db } from "@/server/db";
import type { Branch } from "@/types/domain";

/**
 * Branch reads (DECISIONS #30, PROMPT-ARCH-02).
 *
 * Branch is an operational unit INSIDE the Business — never the tenant
 * boundary. No Branch CRUD surface exists: creation happens only inside
 * the Business-creation transaction (`BusinessRepository`) and the
 * ARCH-02 backfill. All reads are Business-scoped.
 */
const notDeleted = { deletedAt: null } as const;

/** Default-branch name used by the creation path and backfill. */
export const DEFAULT_BRANCH_NAME = "الفرع الرئيسي";

export class BranchRepository {
  /**
   * The Business's Default Branch — the only Branch the current
   * single-Branch UX resolves. Null only if the Business record is
   * broken (the creation path + backfill guarantee existence).
   */
  async findDefaultByBusiness(businessId: string): Promise<Branch | null> {
    return db.branch.findFirst({
      where: { defaultForBusiness: { id: businessId }, ...notDeleted },
    });
  }

  /** Tenant-safe lookup: a Branch of ANOTHER Business is "not found". */
  async findByIdWithinBusiness(
    id: string,
    businessId: string,
  ): Promise<Branch | null> {
    return db.branch.findFirst({ where: { id, businessId, ...notDeleted } });
  }
}
