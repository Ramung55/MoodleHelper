# Compose browser test

Requires Docker Desktop (or Docker Engine with Compose), Node.js, and the frontend dependencies. From the repository root:

```sh
cd frontend
npm install
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npx playwright install chromium
cd ..
make e2e
```

The test builds the Compose app and creates a uniquely named project with its own PostgreSQL volume and a temporary localhost port. It removes that project and volume on completion, including when an assertion fails. An abrupt process termination may require manual cleanup: `docker compose -p <project-name> -f docker-compose.yaml down --volumes --remove-orphans`. The project name appears in Docker's output.

The browser journey creates a personal event, checks form validation and personal completion, confirms the frontend's real API calls and PostgreSQL record, reloads, checks the local write/Host safeguards, and verifies settings survive a Compose restart. MoodleHelper has no application login or logout. The write binding is not user authentication. Live Moodle and extension integration are not exercised. On failure the harness retains a screenshot when a page exists, the error, and Compose logs under ignored `e2e/artifacts/<project>/` before removing test resources. Those logs contain test-only data and should be reviewed before sharing.
