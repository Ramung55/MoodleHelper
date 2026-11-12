# CI and AWS deployment

The workflow runs backend and frontend tests independently, then exercises the Compose stack with the opt-in integration and browser tests. It saves the image used by the browser test and deploys that image after all jobs pass on `main`.

Deployment assumes an existing ECS service, ECR repository, network, database, and externally reachable health endpoint. This application was designed for local use; review authentication, isolation, persistence, secrets, and network access before exposing it remotely. Compose's example database credentials are for testing only. `HEALTH_URL` must be the base URL of the deployed service. The workflow checks `/health`, which reads the store and reports the deployment release. A reverse proxy must forward a loopback Host header because the application rejects other Host headers. A successful HTTP response alone does not prove all application functions work.

Create a GitHub `production` environment with these variables: `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_SERVICE`, `ECS_CONTAINER`, and `HEALTH_URL`. Configure the service's task definition with its own production settings and credentials. The GitHub OIDC provider must trust `token.actions.githubusercontent.com` with audience `sts.amazonaws.com`; restrict the role's subject to `repo:OWNER/REPO:environment:production`. Protect the production environment so only the intended branch can deploy. Grant the role only the ECR push and ECS describe/register/update permissions needed, plus `iam:PassRole` for the task and execution roles. The runner must be able to reach the health URL.

ECS stability and the health check are checked after deployment. A failed health check fails the workflow but does not automatically roll back the deployment; configure ECS deployment circuit breakers and monitoring appropriate to the service. No AWS resources are created by this workflow.

