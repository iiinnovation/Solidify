# Agent Pipeline Baseline

`cases.json` is the fixed M4R-03/M4R-04 input set. It deliberately contains
ordinary requests, selected Skills, auto-discovery, three attachment classes,
no-workspace delivery, broken resources, and negative Skill-route examples.

For each provider and feature-flag configuration, record the run ID and ledger
metrics in a separate result file. Each row must include `runId`, `provider`,
`model`, `runtimeVersion`, `status`, `firstArtifactMs` (or `null`), and
`reviewerNotes`. Do not commit API keys, attachment bodies,
or raw private user material. A valid result row includes:

- provider/model and runtime version;
- provider call count and tool call count;
- input/output tokens, cache tokens when supported, and first-chunk time;
- first Artifact time and total duration;
- `status` (`completed` or `failed`); failed rows must include a bounded `failureClass`;
- cache read/write token counts when returned by the provider;
- the five rubric scores in `cases.json` and reviewer notes.

The browser-side helper `deriveBenchmarkResult` in
`src/lib/harness/telemetry.ts` converts a persisted run ledger into this
redacted row shape; it never exports prompt, attachment, or error bodies.

The fixture is a repeatable input contract, not a claim that live provider
measurements have already been completed.

## Explicit live collection

The paid-provider runner is opt-in and requires an output path plus an explicit
provider list. The normal test suite never loads this file's network runner.
For example, this collects one smoke case without writing any API key or raw
ledger to the repository:

```bash
AGENT_PIPELINE_BENCHMARK=true \
AGENT_PIPELINE_PROVIDERS=deepseek \
AGENT_PIPELINE_CASES=chat-plain-01 \
AGENT_PIPELINE_RESULTS=/tmp/agent-pipeline-observations.json \
AGENT_PIPELINE_REVIEW_OUTPUT=/tmp/agent-pipeline-review.json \
npm run test:agent-benchmark-live
```

For a complete matrix, omit `AGENT_PIPELINE_CASES` and list every configured
provider explicitly. The runner writes only objective, redacted ledger facts
to `AGENT_PIPELINE_RESULTS`. The optional review packet contains the generated
answer so a human can score the five rubric dimensions; it is kept separate
from the gate input and should not contain private user material.

After review, add `quality` and `reviewerNotes` to each matching row in the
review packet and prepare the gate input:

```bash
npm run prepare:agent-benchmark -- \
  --observations /tmp/agent-pipeline-observations.json \
  --reviews /tmp/agent-pipeline-review.json \
  --output /tmp/agent-pipeline-results.json
npm run check:agent-benchmark -- \
  --results /tmp/agent-pipeline-results.json
```

The preparation step fails closed when a provider/case has no review, a score
is outside 0–4, or a review row has no matching observation. A live run that is
interrupted therefore cannot be mistaken for a complete benchmark.

Run the local schema/quality gate after collecting provider rows:

```bash
node scripts/check-agent-pipeline-benchmark.mjs \
  --results /path/to/optimized.json \
  --baseline /path/to/baseline.json \
  --max-failure-rate 0.05 \
  --max-duration-p95 30000 \
  --max-first-chunk-p95 5000
```

The gate rejects unknown or duplicate cases, invalid metric/rubric values,
missing provider rows, invalid failure records, and any per-case quality drop
greater than five percent. `--max-failure-rate` is optional because the
proposal's Phase 1/target limits are deployment-specific; when supplied it is
enforced over the complete provider/case matrix. The optional latency flags
enforce aggregate p95 limits when a deployment has fixed thresholds. The output also reports p50/p95
for duration, first chunk, and first Artifact latency so the deployment-specific
§9 thresholds can be checked without re-reading raw ledgers.
