# Cost Analysis: GitHub Actions (Free Tier) vs. Google Cloud Run

**Date:** September 28, 2026  
**Purpose:** Compare operational costs between current GitHub Actions setup and dedicated Google Cloud hosting

---

## Current Architecture

### GitHub Actions Workflows (CI/CD + Scheduled Jobs)

#### Scheduled Recurring Workflows

| Workflow | Frequency | Weekly Runs | Avg Runtime* | Purpose |
|----------|-----------|-------------|--------------|---------|
| `trading-bot-scan` | 3× daily (Mon-Fri) | ~15 | 3-5 min | Premarket + midday scans |
| `ai-entry-batch` | 2× daily + chained | ~15 | 5-10 min | AI evaluation of BUY signals |
| `ai-holding-advisor` | 1× daily | ~5 | 8-15 min | Daily holding recommendations |
| `universe-discovery-daily` | 1× daily | ~5 | 5-8 min | Finnhub universe snapshot |
| `signal-research-daily` | 1× daily | ~5 | 2-4 min | Finalize P&L for mature signals |
| `position-monitor` | Hourly (14:00-21:00 ET) | ~40 | 1-3 min | Monitor open positions |
| `profit-hold-research` | 1× daily | ~5 | 3-6 min | Cohort research for dashboard |
| **Total Scheduled** | | **~90/week** | | |

*Runtime estimates based on typical workload

#### Event-Driven Workflows

| Workflow | Trigger | Monthly Runs** | Avg Runtime |
|----------|---------|----------------|-------------|
| `quality-gate` | Every PR + deploy | ~20-40 | 3-5 min |
| `deploy-on-main` | Push to main | ~10-20 | 5-8 min |
| `nyse-calendar-drift` | Specific files | ~1-2 | 1-2 min |

**Depends on development velocity

---

## Cost Analysis

### 1. GitHub Actions Free Tier (Current Setup)

#### Free Tier Limits (Public Repositories)
- **Compute Minutes:** ✅ **Unlimited for public repos**
- **Storage:** 500 MB (artifacts + caches)
- **Artifacts Retention:** 90 days default
- **Concurrent Jobs:** 20

#### Current Usage Estimate

**Monthly Compute:**
- Scheduled jobs: ~90 runs/week × 4.3 weeks = ~387 runs/month
- Avg runtime: ~4 minutes
- **Total: ~1,548 minutes/month (25.8 hours/month)**

**Event-driven jobs:**
- Quality gates + deploys: ~30-60 runs/month × 4 min = ~120-240 minutes/month

**Grand Total: ~1,668-1,788 minutes/month**

#### ✅ Cost: **$0/month** (public repository)

**Key Points:**
- ✅ Free unlimited minutes for public repos
- ✅ GitHub-managed infrastructure (no maintenance)
- ✅ Built-in secret management
- ✅ Native git integration
- ⚠️ Cold starts on each job (~30-60 sec setup time)
- ⚠️ Limited to 6 hours max per job
- ⚠️ No persistent state between runs (uses artifacts for state)

---

### 2. Google Cloud Run (Dedicated Hosting)

Moving workflows to Cloud Run would require:
1. Containerizing each workflow as a service or job
2. Cloud Scheduler to trigger scheduled runs
3. Pub/Sub for event orchestration
4. Cloud Storage for state/artifacts
5. Secret Manager for credentials

#### Cost Breakdown

##### A. Cloud Run Jobs (Recommended for scheduled tasks)

**Compute Pricing (us-central1):**
- CPU: $0.00002400 per vCPU-second
- Memory: $0.00000250 per GiB-second
- Requests: $0.40 per million requests

**Estimated Configuration per Job:**
- 1 vCPU, 512 MiB memory
- Avg 4 min runtime = 240 seconds

**Per Job Cost:**
- CPU: 240 sec × 1 vCPU × $0.000024 = $0.00576
- Memory: 240 sec × 0.5 GiB × $0.0000025 = $0.0003
- Request: $0.0000004 (negligible)
- **Total per run: ~$0.006**

**Monthly Scheduled Jobs:**
- ~387 scheduled runs × $0.006 = **~$2.32/month**

**Monthly Event Jobs:**
- ~30-60 runs × $0.006 = **~$0.18-$0.36/month**

##### B. Cloud Scheduler
- $0.10 per job per month
- ~8 unique schedules = **$0.80/month**

##### C. Cloud Storage (for artifacts & state)
- Standard storage: $0.020 per GB/month
- Operations: $0.05 per 10,000 Class A operations
- Estimated 5 GB storage + operations: **~$0.25/month**

##### D. Secret Manager
- $0.06 per secret version per month
- ~10 secrets × 1 active version = **$0.60/month**

##### E. Pub/Sub (for event orchestration)
- First 10 GiB/month free
- Minimal usage for this workload: **~$0/month**

##### F. Firestore (Already in use)
- No additional cost (already using for app)

##### G. Networking
- Egress to internet: First 1 GB free, then $0.12/GB
- API calls to external services (Finnhub, Polygon, OpenAI, Slack)
- Estimated 10-20 GB/month: **~$1.20-2.40/month**

#### 🔴 Total GCP Cost: **~$5.37-$6.73/month**

---

## Cost Comparison Summary

| Solution | Monthly Cost | Annual Cost | Notes |
|----------|--------------|-------------|-------|
| **GitHub Actions** (current) | **$0** | **$0** | ✅ Free for public repos |
| **Google Cloud Run** | **$5-7** | **$60-84** | 🔴 Requires migration + maintenance |

---

## Additional Considerations

### GitHub Actions Advantages ✅
1. **Zero cost** for public repositories
2. **No migration needed** – already working
3. **Native CI/CD integration** with git
4. **Automatic scaling** and infrastructure management
5. **Built-in secrets management** (no extra service)
6. **Extensive marketplace** of pre-built actions
7. **Easy debugging** with workflow logs UI
8. **No cold-start optimization needed** (acceptable for batch jobs)

### Google Cloud Run Advantages
1. **Faster cold starts** if optimized (~1-2 sec vs 30-60 sec)
2. **More granular control** over compute resources
3. **Could run continuously** (for real-time monitoring if needed)
4. **Better for long-running jobs** (>6 hours)
5. **Potential cost savings** IF you were paying for GitHub Actions (not applicable here)

### GitHub Actions Disadvantages ⚠️
1. **Cold starts** add 30-60 seconds overhead per job
2. **6-hour job limit** (not an issue for your 4-min jobs)
3. **Workflow state requires artifacts** (you're already handling this well)
4. **Rate limiting** on external APIs (but same issue on GCP)

### Google Cloud Run Disadvantages 🔴
1. **Migration effort** – containerize all workflows
2. **Ongoing maintenance** of Cloud Scheduler, Pub/Sub, etc.
3. **Monthly costs** ($60-84/year)
4. **More complex secret management** (Secret Manager + IAM)
5. **Monitoring setup** (Cloud Logging, Cloud Monitoring costs)
6. **No built-in git integration** – need custom deployment pipeline

---

## Recommendation

### Stay on GitHub Actions ✅

**Reasoning:**
1. **Zero cost** vs. $60-84/year on GCP
2. **Already working well** with good infrastructure
3. **Lower operational complexity** (no Cloud Scheduler, Pub/Sub, Secret Manager to manage)
4. **Native git integration** for CI/CD
5. Your workflows are **batch jobs** (not real-time), so cold starts are acceptable
6. Total runtime (~1,700 min/month) is well within unlimited free tier
7. Migration effort not justified for $5-7/month savings that don't exist

### When to Consider GCP Cloud Run

Only if these become true:
1. **Repository becomes private** (then GitHub Actions costs $0.008/min = ~$13-14/month)
2. **Need jobs >6 hours** (current max is ~15 min, so not an issue)
3. **Need real-time continuous monitoring** (vs. current hourly position monitor)
4. **Scale to 100s of runs per day** (would still be free on GitHub public repos)

---

## Cost Optimization Opportunities (Current Setup)

Even though GitHub Actions is free, you can optimize:

### 1. Reduce Redundant Runs
- ✅ Already using time gates (NY market hours)
- ✅ AI workflows in concurrency group (avoid parallel OpenAI 429s)
- Consider: Combine `trading-bot-scan` + `ai-entry-batch` into single workflow with separate steps

### 2. Artifact Cleanup
- Current: `universe-discovery-state` retained 120 days
- Consider: 30-day retention (still plenty for recovery)

### 3. Cache Optimization
- ✅ Already using Python pip cache
- ✅ Already using Node.js cache for frontend/backend
- Good: Reduces pip install time from ~60s to ~10s

### 4. Workflow Efficiency
- `position-monitor` runs hourly during market hours (8×/day)
  - Could reduce to 2-3× if monitoring frequency is flexible
  - Savings: Negligible (still $0), but reduces API quota usage

---

## Conclusion

**Current monthly cost: $0**  
**GCP alternative cost: $5-7/month ($60-84/year)**

**Recommendation: Keep using GitHub Actions.**

Your current setup is optimal for a signal-only research bot with scheduled batch jobs. The free unlimited compute on public GitHub repos cannot be beaten, and the cold-start overhead is negligible for your 4-minute batch workflows.

Only migrate to GCP if:
- Repository goes private (then GCP might be cheaper)
- Need real-time continuous processing (not batch jobs)
- Need jobs longer than 6 hours

---

## Appendix: Actual Current Costs

### External API Services (Not affected by GitHub vs. GCP choice)

| Service | Plan | Monthly Cost | Usage |
|---------|------|--------------|-------|
| **Polygon.io / Massive Stocks** | Paid | ~$X | Market data (quotes, candles) |
| **Finnhub** | Paid | ~$X | Fallback quotes, universe discovery |
| **OpenAI API** | Pay-as-you-go | ~$X | AI entry + holding evaluations |
| **Slack** | Free/Paid | $0 or ~$X | Notifications |
| **Firebase/Firestore** | Pay-as-you-go | ~$X | Database + hosting |
| **Google Cloud Run** (API) | Pay-as-you-go | ~$X | Nest backend API |

**Note:** These costs exist regardless of whether you use GitHub Actions or GCP Cloud Run for scheduled jobs.

The only cost difference is the **orchestration layer** (GitHub Actions vs. Cloud Run Jobs), where GitHub Actions is **$0** and GCP would be **$5-7/month**.

---

**Author:** Cursor Agent (Cloud)  
**For:** Tal  
**Repository:** trading-signals  
**Analysis Date:** September 28, 2026
