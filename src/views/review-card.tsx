import type { FC } from "hono/jsx";
import type { InboxReview, IssueRow, ReviewCategory, Store } from "../env";
import { replyLimit } from "../env";
import { relativeTime } from "../lib/util";
import { suggestIssue, suggestTitle } from "../services/issues";

const STORE_LABEL: Record<Store, string> = { apple: "App Store", google: "Google Play", demo: "Sample" };

const CATEGORY_LABEL: Record<ReviewCategory, string> = {
  bug: "Bug",
  feature_request: "Feature request",
  praise: "Praise",
  pricing: "Pricing",
  question: "Question",
  other: "Other",
};

/** An open issue offered in the "Mark fix pending" menu. */
export type IssueOption = Pick<IssueRow, "id" | "app_id" | "title" | "fix_note" | "target_version"> & { reports: number };

export const Stars: FC<{ rating: number }> = ({ rating }) => (
  <span class={`stars r${rating}`} role="img" aria-label={`${rating} out of 5 stars`}>
    {"★".repeat(rating)}
    <span class="stars-off">{"★".repeat(Math.max(0, 5 - rating))}</span>
  </span>
);

const Composer: FC<{
  review: InboxReview;
  name: "reply" | "followup";
  value: string;
  draftAction: string;
  draftLabel: string;
  sendAction: string;
  sendLabel: string;
}> = ({ review, name, value, draftAction, draftLabel, sendAction, sendLabel }) => {
  const limit = replyLimit(review.store);
  return (
    <div class="composer">
      <label class="sr-only" for={`${name}-${review.id}`}>
        {name === "followup" ? "Follow-up reply" : "Reply"}
      </label>
      <textarea
        id={`${name}-${review.id}`}
        name={name}
        rows={4}
        maxlength={limit}
        data-limit={limit}
        placeholder={name === "followup" ? "Write the follow-up…" : "Write a reply, or draft one with AI…"}
      >
        {value}
      </textarea>
      <div class="composer-actions">
        <button type="button" class="button" data-action={draftAction}>
          {draftLabel}
        </button>
        <span class="counter" aria-live="polite">{`${value.length}/${limit}`}</span>
        <button type="button" class="button primary" data-action={sendAction}>
          {sendLabel}
        </button>
      </div>
    </div>
  );
};

/**
 * "Mark fix pending": join an open issue of the same app (the most similar one is preselected)
 * or start a new one. app.js keeps the note and version fields in step with the chosen issue.
 */
const FixForm: FC<{ review: InboxReview; issues: IssueOption[] }> = ({ review, issues }) => {
  const appIssues = issues.filter((issue) => issue.app_id === review.app_id);
  const suggestedId = review.issue_id ? null : suggestIssue(review, appIssues);
  const selected = appIssues.find((issue) => issue.id === (review.issue_id ?? suggestedId)) ?? null;
  return (
    <details class="fix-form">
      <summary>{review.status === "fix_pending" ? "Edit fix details" : "Mark fix pending"}</summary>
      <div class="fix-fields">
        <label>
          Issue
          <select name="issue_id" data-issue-select>
            <option value="">New issue</option>
            {appIssues.map((issue) => (
              <option
                value={issue.id}
                selected={issue.id === selected?.id}
                data-note={issue.fix_note ?? ""}
                data-version={issue.target_version ?? ""}
              >
                {`${issue.title} (${issue.reports})`}
              </option>
            ))}
          </select>
        </label>
        <label class="issue-title-field" hidden={Boolean(selected)}>
          New issue title
          <input type="text" name="issue_title" maxlength={120} value={suggestTitle(review)} />
        </label>
        <label>
          What's the fix? <span class="muted">(used in the follow-up)</span>
          <input
            type="text"
            name="fix_note"
            maxlength={500}
            value={selected?.fix_note ?? review.fix_note ?? ""}
            placeholder="Timer now keeps running when the screen locks"
          />
        </label>
        <label>
          Ships in version <span class="muted">(optional)</span>
          <input
            type="text"
            name="fix_version"
            maxlength={40}
            value={selected?.target_version ?? (review.status === "fix_pending" ? review.fixed_in_version ?? "" : "")}
            placeholder="2.3.1"
          />
        </label>
        <button type="button" class="button" data-action="fix">
          Save
        </button>
      </div>
      {suggestedId && selected ? <p class="muted small">Looks like the same problem as “{selected.title}”, so it's preselected.</p> : null}
    </details>
  );
};

export const ReviewCard: FC<{ review: InboxReview; issues?: IssueOption[] }> = ({ review, issues = [] }) => {
  const meta = [
    review.author,
    review.territory ?? review.language,
    review.app_version ? `v${review.app_version}` : null,
    relativeTime(review.reviewed_at),
  ].filter(Boolean);
  const hasOurReply = review.reply_state === "sent";
  const hasReply = Boolean(review.reply_text) && (review.reply_state === "sent" || review.reply_state === "existing");

  return (
    <article class={`review status-${review.status}`} id={`review-${review.id}`} data-review-id={review.id}>
      <header class="review-head">
        <Stars rating={review.rating} />
        <span class="app-name">{review.app_name}</span>
        <span class={`badge store-${review.store}`}>{STORE_LABEL[review.store]}</span>
        {review.category ? <span class={`badge cat-${review.category}`}>{CATEGORY_LABEL[review.category]}</span> : null}
        {review.issue_id && review.issue_title ? (
          <a class="badge issue-chip" href={`/issues/${review.issue_id}`}>
            Issue: {review.issue_title}
          </a>
        ) : null}
        <span class="meta">{meta.join(" · ")}</span>
      </header>

      {review.rating_raised_at && review.rating_before ? (
        <p class="win">
          Rating raised from {review.rating_before}★ to {review.rating}★ after your reply
        </p>
      ) : null}

      {review.title ? <h3 class="review-title">{review.title}</h3> : null}
      <p class="review-body">{review.body || <span class="muted">(No written review)</span>}</p>

      {hasReply ? (
        <div class="existing-reply">
          <span class="label">{hasOurReply ? "Your reply" : "Reply posted in the store"}</span>
          <p>{review.reply_text}</p>
        </div>
      ) : null}

      {review.reply_error ? <p class="error-text">Last attempt failed: {review.reply_error}</p> : null}

      {review.status === "fix_pending" ? (
        <p class="fix-note">
          <strong>Fix pending{review.fixed_in_version ? ` for v${review.fixed_in_version}` : ""}.</strong>{" "}
          {review.fix_note ?? "You'll get a follow-up draft when the next version ships."}
        </p>
      ) : null}

      {review.status === "open" || (review.status === "fix_pending" && !hasOurReply) ? (
        <>
          <Composer
            review={review}
            name="reply"
            value={review.draft ?? ""}
            draftAction="draft"
            draftLabel={review.draft ? "Redraft with AI" : "Draft with AI"}
            sendAction="send"
            sendLabel="Send reply"
          />
          <div class="card-actions">
            <FixForm review={review} issues={issues} />
            {review.status === "open" ? (
              <button type="button" class="button ghost" data-action="done">
                Mark done without replying
              </button>
            ) : null}
            {review.status === "fix_pending" && review.issue_id ? (
              <button type="button" class="button ghost" data-action="unlink">
                Remove from issue
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {review.status === "fix_pending" && hasOurReply ? (
        <div class="card-actions">
          <FixForm review={review} issues={issues} />
          {review.issue_id ? (
            <button type="button" class="button ghost" data-action="unlink">
              Remove from issue
            </button>
          ) : null}
        </div>
      ) : null}

      {review.status === "followup_ready" ? (
        <div class="followup">
          <p class="followup-title">
            <strong>Fixed in v{review.fixed_in_version}.</strong> Follow up so they know:
          </p>
          <Composer
            review={review}
            name="followup"
            value={review.followup_draft ?? ""}
            draftAction="followup-draft"
            draftLabel="Rewrite with AI"
            sendAction="followup-send"
            sendLabel="Send follow-up"
          />
        </div>
      ) : null}

      {review.status === "done" || review.status === "followed_up" ? (
        <div class="card-actions">
          {review.status === "done" ? <FixForm review={review} issues={issues} /> : null}
          <button type="button" class="button ghost" data-action="reopen">
            Reopen
          </button>
        </div>
      ) : null}
    </article>
  );
};
