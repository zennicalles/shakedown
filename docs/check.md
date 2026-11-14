# Agent money-safety check

**Founding offer: $99 per agent, for the first 5 teams.**

Your agent refunds, charges, books or emails people. When one of those calls times out *after* it went through, the agent (or your framework, or your job queue) retries, and the customer is refunded twice or emailed twice. With deliberately naive tools on a real model, a crash and resume refunded twice in 22 of 28 runs, and a timed-out email was re-sent in 25 of 28 ([method and results](results/haiku-5-5-2026-11-05.md)).

## What you get, within 48 hours

1. **A crash test of your agent's real loop.** Your agent runs against fake backends that behave like Stripe and your email provider, while Shakedown injects the failures that cause duplicates: a timeout after the side effect, the same call delivered twice, a crash then resume, the whole job delivered again.
2. **A report**: every action that can happen twice, under which failure, with the exact run that shows it.
3. **The fix**, as a pull request or a patch: idempotency keys on the actions at risk, sent through to your provider, keyed on the operation (the ticket, the order), never on text the model wrote.
4. **A test that keeps it fixed**: the crash test added to your CI, so a later change can't bring the duplicate back.

## What I need from you

Read access to the agent's code (or a copy of the tool-calling part), and 15 minutes to agree what "done" looks like: for example "exactly one refund per ticket, at most one email per customer". No production access, no customer data: everything runs against fakes.

## Why $99

It's a founding price for the first 5 teams, in exchange for honest feedback on whether this is worth paying more for. The tool behind it is open source ([github.com/zennicalles/shakedown](https://github.com/zennicalles/shakedown)); you're paying for someone to do it for you, today.

## Book it

Message me on [LinkedIn](https://www.linkedin.com/in/alexskeggs/) or [X (@zennicalles)](https://x.com/zennicalles), or [open an issue titled "check"](https://github.com/zennicalles/shakedown/issues/new?title=check) and I'll reply within a day.

Want to try it yourself first? `npx agent-shakedown demo` runs a refund agent under every fault in 10 seconds, and `npx agent-shakedown scan -- <your MCP server command>` lists the tools that can repeat on a retry.
