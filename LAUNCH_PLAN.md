# Launch plan: 30 days to your first paying developers

Nobody can guarantee income. What decides whether you hit ₹10,000/month is how many developers see ReviewLoop, not the code. This plan turns that into daily numbers you can control.

## The target in numbers

| | |
| --- | --- |
| ₹10,000/month | about $113.60 after fees, at ₹88 per dollar (check today's rate) |
| Plus | $5/month; Dodo keeps about 14% (6% + 40¢), so you get about $4.30 |
| Pro | $10/month; Dodo keeps about 10%, so you get about $9.00 |
| Subscribers needed | **13 Pro**, or **27 Plus**, or a mix like **8 Pro + 10 Plus**. Aim a few higher to cover AI costs and payout currency conversion |
| AI cost per paying user | usually under $1/month at typical use. The monthly draft limits (100 on Plus, 500 on Pro) cap the worst case |

Plus exists so that a developer with one app on both stores pays $5 instead of skipping a $10 plan. Expect most solo developers on Plus, and studios or developers with several apps on Pro. If about 3% of free signups upgrade, 18 subscribers means roughly 600 signups. Direct outreach converts much better than that, so the plan leans on it. These are planning assumptions to size your effort, not predictions.

**Realistic path:** 5–10 paying developers by day 30 if you do the daily outreach, then ₹10,000/month between day 60 and 90.

## What makes this hard to copy

Code can be copied, so the moat can't be the code. These parts get stronger the longer ReviewLoop runs, and a copycat starts at zero:

- **Outcome data.** Every follow-up records whether the reviewer raised their rating. That feeds the recovery forecasts, the "what works" findings on Insights, and the AI drafts, which learn from replies that actually won stars back. A new competitor has none of this history.
- **Peer benchmarks.** They unlock once 10 apps contribute and sharpen with every app after that: a network effect a solo copycat can't bootstrap.
- **Public fix logs and badges.** Every developer who adds the badge to a README or website sends visitors back to ReviewLoop. That's distribution that compounds, and it's hard to copy after the fact.
- **Switching cost.** Issues, release history, reply history and the security log live here. Moving means losing the record of what was fixed and who was told.
- **Speed and focus.** Big review tools sell dashboards to companies. Staying the best tool for the one job indie developers care about, winning stars back after a fix, is a position they won't chase.

Keep the benchmark and outcome numbers private until they're a selling point: Insights deliberately doesn't show how many apps are on the platform.

## Things only you can do

- Create the Cloudflare, GitHub OAuth, Anthropic and Dodo Payments accounts. Dodo needs your KYC (PAN, bank account) before payouts.
- Put your name or business details on the Privacy, Terms and Refunds pages (`src/views/legal.tsx`).
- Talk to a chartered accountant once money starts coming in.

## Week 1 (days 1–7): live and dogfooding

- [ ] Deploy (README → Deploy). Use `DODO_MODE: "test"` and make one test purchase end to end.
- [ ] Connect your own apps, or borrow a friend's App Store Connect or Play account with permission. Reply to real reviews with it every day. Everything that annoys you, fix first.
- [ ] Build a list of 100 prospects (see "Finding prospects").
- [ ] Send the first 20 personal emails.
- [ ] Ask 5 developer friends to try it and tell you what confused them.

## Week 2 (days 8–14): first users

- [ ] 10 personal emails a day (70 total).
- [ ] Watch where people drop off: sign in → connect store → first reply → first fix pending.
- [ ] Offer early users a free month of Plus or Pro in exchange for a 15-minute call.
- [ ] Get 3 short testimonials ("got 4 reviewers to update their rating in a week").
- [ ] Ask every early user with a real app to turn on the public fix log and add the badge to their README or website. Each badge is a free, permanent link back to you.
- [ ] Switch Dodo to live mode.

## Week 3 (days 15–21): public launch

- [ ] Record a 30-second screen capture of the loop: three 1★ reviews grouped into one issue → ship → one click follows up with all three → ratings raised.
- [ ] Post "Show HN: ReviewLoop – follow up with App Store reviewers when you ship the fix".
- [ ] Post on r/SideProject and Indie Hackers. On r/iOSProgramming and r/androiddev, only post in the threads or days their rules allow for self-promotion.
- [ ] Post a thread on X with the demo video, and answer every reply.
- [ ] Founding-member offer: Pro at $7/month, locked in for the first 20 subscribers. Create it as a separate Dodo product, add its id after a comma in `DODO_PRO_PRODUCT_ID` (the first id stays the regular price sold at checkout), and share its Dodo payment link. Buyers are matched to their account by email, so ask them to pay with the email on their GitHub account.
- [ ] Keep sending the 10 emails a day.

## Week 4 (days 22–30): convert and learn

- [ ] Email every free user who connected a store but hasn't upgraded. Ask what's missing.
- [ ] Publish one useful article that developers search for, for example "How to reply to App Store reviews: 12 real examples", or "Google Play's 350-character reply limit: how to say more in less". Link the tool at the end.
- [ ] Share the public setup guides (`/guide/app-store`, `/guide/google-play`) when developers ask how to create App Store Connect API keys or Google Play service accounts. Both are common questions on Reddit and Stack Overflow.
- [ ] Submit ReviewLoop to iOS Dev Weekly and Android Weekly.
- [ ] Day 30 review, using the numbers below.

## Your 45-minute daily routine

1. 10 personal outreach emails (25 min)
2. Reply to every user message and comment (10 min)
3. One helpful comment in a developer community, without a link unless someone asks (10 min)

## Finding prospects

The best prospects are indie developers with recent 1–2★ reviews and no replies:

1. Browse App Store and Google Play categories where solo developers are common: Productivity, Health & Fitness, Finance, Utilities, Education.
2. Open apps with 50–5,000 ratings. Smaller ones rarely care; bigger ones have support teams.
3. Look for recent low-star reviews with no developer response.
4. Get the contact: Google Play listings always show a developer email. App Store listings link to a developer website, which usually has one.
5. Track everything in a spreadsheet: app, developer, email, the review you'll mention, date contacted, reply.

## Outreach email

Keep it personal and short. Never send the same text to everyone, and stop if they say no.

> **Subject:** The 1-star review about [specific problem] in [App]
>
> Hi [name],
>
> I noticed [App] has a few recent 1–2★ reviews without a reply, like the one about [specific problem]. Reviewers get notified when you reply, and quite a few update their rating once they hear it's fixed.
>
> I built a small tool for exactly that. It puts App Store and Google Play reviews in one inbox and drafts replies in your voice. When you ship the fix, it follows up with everyone who reported the bug. It's free for one app: [link]
>
> I'm a solo developer too. If it's not useful, a one-line "not for me because…" would genuinely help.
>
> [Your name]
>
> PS: Not interested? Reply "no" and I won't email again.

## Numbers to watch every week

The founder dashboard at `/admin` shows all of these, plus AI spend and any broken connections.

| Metric | Why it matters |
| --- | --- |
| Signups | Is the message reaching people? |
| % who connect a real store | The biggest drop-off in tools like this. Improve setup until it's over 40%. |
| Replies sent per active user | Are they getting value? |
| Follow-ups sent, and ratings raised | Your proof. Put these numbers on the landing page. |
| Public fix logs turned on | Your free distribution. Each one is a page and a badge linking back to you. |
| Free → Plus and Free → Pro conversions, and Plus → Pro upgrades | Whether the plan limits are in the right place |

## Decision points

- **Day 30:** under 30 signups, or under 5 people who connected a real store. Change the message or the channel before changing the product. Try a different subject line, different categories of apps, or a different community.
- **Day 60:** under 5 paying. Call the users who connected but didn't pay, and ask what would have made it worth $9. Common next steps are a $29/month plan for studios and agencies that manage many apps, or a feature users keep asking for.
- **Once you're at ₹10,000/month:** raise the price for new customers, move to Workers Paid ($5/month), and start the article-a-week habit. Articles keep bringing in signups without daily outreach.
