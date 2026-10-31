# Scan retry policy (independent component)

This policy is a preparatory component for issue 20, not a scan coordinator or a
network gate. It returns an absolute earliest retry time for retryable failures.
The first and second retries wait at least two and five seconds from failure;
there is no third retry. A valid Retry-After can extend the wait. Malformed or
unrepresentable values fail closed rather than permitting an earlier request.
The future global gate must persist the returned instant and enforce it across
processes, independently of the one-second minimum request-start spacing.
No production transport is enabled by this component.

## Internal gate migration decision

Schema version 4 adds one file-wide `scan_request_gate` row (not namespaced):
`id=1`, opaque owner token, integer millisecond last-start and retry-not-before.
Acquisition is a single BEGIN IMMEDIATE transaction, rejects an occupied gate,
and waits until both persisted deadlines have elapsed. It never clears occupancy
on lease expiry or process startup. Release requires the exact owner token and a
caller-confirmed transport termination; a restart cannot infer termination and
therefore leaves the gate closed. This internal primitive has no HTTP endpoint and
no source OpenAPI change. Future transport integration must prove that it invokes
release only after the actual operation has settled or abort is acknowledged;
this primitive alone is not proof of AC3. SQLite authority is the configured
shared database file, so separate database files cannot coordinate with each other.
