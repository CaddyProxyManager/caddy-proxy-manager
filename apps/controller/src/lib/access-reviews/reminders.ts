/**
 * Undecided items as a campaign's due date nears, and again once it passes, through the alerting
 * rules and channels. Watched from the notification tick, which only the leader runs; each is told
 * once per campaign, keyed in the alert tables, so a leadership change never repeats one.
 */
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import db from "../db";
import { accessReviewCampaigns, accessReviewItems } from "../db/schema";
import { dueAt } from "./model";

const DAY_MS = 86_400_000;

export async function watchAccessReviews(now: number): Promise<void> {
  const open = await db
    .select()
    .from(accessReviewCampaigns)
    .where(eq(accessReviewCampaigns.status, "open"));
  if (open.length === 0) return;
  const counts = await db
    .select({ campaignId: accessReviewItems.campaignId, value: count() })
    .from(accessReviewItems)
    .where(
      and(
        inArray(
          accessReviewItems.campaignId,
          open.map((row) => row.id),
        ),
        isNull(accessReviewItems.decision),
      ),
    )
    .groupBy(accessReviewItems.campaignId);
  const pendingBy = new Map(counts.map((row) => [row.campaignId, Number(row.value)]));
  const [{ notify }, { accessReviewReminderDays }, { getSetting }] = await Promise.all([
    import("../notifications"),
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const leadMs = (await getSetting(accessReviewReminderDays)) * DAY_MS;
  for (const campaign of open) {
    const pending = pendingBy.get(campaign.id) ?? 0;
    if (pending === 0) continue;
    const due = dueAt(campaign.dueOn);
    const event = {
      campaignId: campaign.id,
      campaign: campaign.name,
      pending,
      dueOn: campaign.dueOn,
    };
    if (now > due) {
      await notify(
        `access-review-overdue:${campaign.id}`,
        { kind: "accessReviewOverdue", ...event },
        "forever",
        now,
      );
    } else if (now >= due - leadMs) {
      await notify(
        `access-review-due:${campaign.id}`,
        { kind: "accessReviewDue", ...event },
        "forever",
        now,
      );
    }
  }
}
