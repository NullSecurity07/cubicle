# Pricing from buyers, checked by the numbers

*How to pick a price from what buyers say, then check it against what a customer costs and earns. Written for this
app in our own words from the Van Westendorp price sensitivity meter
(https://en.wikipedia.org/wiki/Van_Westendorp%27s_Price_Sensitivity_Meter), a16z's "16 Startup Metrics"
(https://a16z.com/16-startup-metrics/), Tom Blomfield's YC talk on metrics
(https://www.ycombinator.com/library/KR-key-startup-metrics) and Aleph's 2026 CAC payback benchmarks
(https://www.getaleph.com/answers/cac-payback-period-saas-2026).*

## Four price questions

Peter van Westendorp, a Dutch economist, proposed in 1976 asking buyers four prices instead of one:

1. So expensive you would not consider it.
2. So cheap you would doubt the quality.
3. Starting to get expensive, but still possible.
4. A bargain.

## Who to ask about price

Only people who would really buy, after they understand the offer. Show the same short description to everyone.

## Reading the answers

For each price, work out what share of people called it too cheap, cheap, expensive or too expensive, cumulatively
(the "cheap" answers counted from the top down). Where "too cheap" crosses "expensive" is the lower bound; where
"too expensive" crosses "cheap" is the upper bound. Where "too cheap" crosses "too expensive" is often called the
optimal point. The method gives a range buyers accept, not how many would buy at each price.

## Gross margin

Revenue minus the costs that grow with each customer: hosting, model calls, payment fees, support. Blomfield's
warning: do not scale a business that loses money on every customer. Fix the margin first (his example at Monzo
went from losing about £30 to £40 per customer to making about that much).

## CAC, the honest kind

Customer acquisition cost is what you spent to win customers divided by how many you won. a16z separates blended CAC
(all customers, including free ones from word of mouth) from paid CAC (only those from paid spend). Paid CAC tells you
whether spending more will work. Count referral fees, credits and discounts as cost.

## LTV as profit

Lifetime value is the profit a customer brings over their life with you, not their revenue. A simple version: monthly
price times gross margin, times the expected lifetime in months (one divided by monthly churn). With little history,
be modest: a few months of data do not tell you a five-year lifetime.

## Payback

Months until the gross profit from a customer repays what it cost to win them: CAC divided by (monthly price times
gross margin). Aleph and Benchmarkit's 2026 report, on 2025 figures from B2B SaaS and AI companies, puts the median at
16 months, the top quarter at six or fewer, the bottom quarter at 24 or more; under 12 is strong, under 18 acceptable.
Early companies' numbers are noisy; use the benchmark to ask questions.

## Deciding

Pick a price inside the accepted range where payback is healthy and margin positive. Test it on new customers for a
set time, and write down before the test what result would make you go back.
