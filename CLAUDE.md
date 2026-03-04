# TensorTours — Infrastructure

AWS CDK v2 infrastructure as code for all TensorTours cloud resources.

## Tech Stack

- **AWS CDK v2** (2.185+)
- **TypeScript**
- **CloudFormation** (synthesized output)

## Main Stack File

`lib/audio-tour-infrastructure-stack.ts`

## Key Resources

| Resource | Details |
|----------|---------|
| Lambda functions | 12 functions |
| API Gateway | 100 req/s throttle |
| DynamoDB | 3 tables |
| S3 + CloudFront | Audio file delivery |
| Cognito | User pool + identity pool |
| SQS / DLQ | Async job queues |
| CloudWatch | Alarms and dashboards |

## Cost Controls

- **Budget cap:** $500/month (CloudWatch billing alarm)
- Lambda reserved concurrency limits per function
- API Gateway throttling at the stage level

## CDN

- CloudFront distribution serves audio files from S3
- Custom header: `X-TensorTours-Key` (used for origin verification)

## Safe Read-Only Commands

```bash
npm run build        # Compile TypeScript (safe)
npx cdk diff         # Preview changes vs deployed stack (safe, read-only)
npx cdk synth        # Generate CloudFormation template (safe, local only)
```

## Deployment

**`cdk deploy` is NEVER run manually.**

All deployments go through **GitHub Actions only**, triggered by a backend `lambda-changed` event:
1. Backend CI uploads a new Lambda zip to S3
2. S3 event triggers the infrastructure pipeline
3. CDK deploys via GitHub Actions with appropriate IAM role

Do not run `cdk deploy`, `cdk destroy`, or any other mutating CDK command without explicit user confirmation.
