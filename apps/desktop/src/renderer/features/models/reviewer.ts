/**
 * Reviewer identity placeholder.
 *
 * There is no authentication yet, so the browser cannot prove who is
 * reviewing. Review records are written with this single internal identity
 * (the historical stored value is kept so existing records stay consistent)
 * and the UI shows it as "内部用户" instead of posing as a real user name.
 * Once authentication exists, the server must stamp the reviewer itself.
 */
export const INTERNAL_REVIEWER_ID = "current-windows-user";

/** User-facing label of the unauthenticated internal identity. */
export const INTERNAL_REVIEWER_LABEL = "内部用户";

/** Display name for a stored reviewer / answering-user id. */
export function reviewerDisplayName(reviewerId: string): string {
  return reviewerId === INTERNAL_REVIEWER_ID ? INTERNAL_REVIEWER_LABEL : reviewerId;
}
