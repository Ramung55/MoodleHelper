# Scan retry policy (independent component)

This policy is a preparatory component for issue 20, not a scan coordinator or a
network gate. It returns an absolute earliest retry time for retryable failures.
The first and second retries wait at least two and five seconds from failure;
there is no third retry. A valid Retry-After can extend the wait. Malformed or
unrepresentable values fail closed rather than permitting an earlier request.
The future global gate must persist the returned instant and enforce it across
processes, independently of the one-second minimum request-start spacing.
No production transport is enabled by this component.
