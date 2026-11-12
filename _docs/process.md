- Tasks are GitHub issues, one at a time
- Read the acceptance criteria before starting and before closing
- Commit regularly


Roles

- PM - grooms a task before anyone implements it, follows _docs/team/pm.md
- Engineer - implements one groomed task, follows _docs/team/software-engineer.md
- QA - checks the result against the acceptance criteria, follows _docs/team/qa-engineer.md


Orchestrator

The main session is the orchestrator. It launches the PM, the engineer
and QA as subagents. It does not groom, implement or test itself.

Lifecycle

1. Pick the next open issue from the backlog
2. PM grooms it
3. Engineer implements it
4. QA verifies it
5. On FAIL, back to step 3 with the QA comment as input
6. On PASS, close the issue
7. Repeat until the backlog is empty

Rules

- Do not skip step 2
- The engineer does not close the issue
- QA does not fix the code, only outputs PASS or FAIL
- The orchestrator closes the issue only after QA outputs PASS
## Grooming and evidence

The PM grooms one issue at a time using `_docs/task-template.md`, including measurable criteria, edge cases and dependencies. If an issue is already groomed, review it against the template and acceptance criteria before implementation; improve it if needed. The engineer implements and tests one groomed issue and commits the work. QA independently reports PASS or FAIL for each criterion, including test commands, results and evidence. An unverified criterion cannot pass. On FAIL, return the issue and evidence to the engineer and repeat QA after changes. The orchestrator closes only after a complete QA PASS, then selects the next open issue. User instructions and authorization govern external issue updates and take precedence over this workflow.
