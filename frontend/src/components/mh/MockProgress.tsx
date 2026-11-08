import { Fragment, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BridgeClient } from "@/services/extension-adapter";
import type { Snapshot } from "@/domain/types";
import { friendlyInstant } from "@/domain/dates";
import { Details } from "./bits";
import { createMockProgress, type ProgressState } from "../../../../shared/src/mock-progress";
import { syncFreshness, type FullSyncAttestation } from "../../../../shared/src/full-sync";

/** `realData` is true only for the real (non-demo) dataset; unknown counts as demo. */
export function MockProgress({
  snapshot,
  realData = false,
  fullSyncAttestation,
}: {
  snapshot: Snapshot;
  realData?: boolean;
  fullSyncAttestation?: FullSyncAttestation | undefined;
}) {
  const [state, setState] = useState<ProgressState>({
    unavailable: false,
    busy: false,
    uncertain: false,
  });
  const [controller, setController] = useState<ReturnType<typeof createMockProgress>>();
  useEffect(() => {
    const client = new BridgeClient();
    const c = createMockProgress(
      {
        connect: () => client.connect(),
        current: () => client.currentMockRun(),
        start: (k) => client.startMockRun(k),
        cancel: (id) => client.cancelMockRun(id),
        dispose: () => client.dispose(),
      },
      setState,
      window.sessionStorage,
    );
    setController(c);
    return () => c.dispose();
  }, []);
  const run = state.current?.run;
  const active = run && ["pending", "running"].includes(run.status);
  const freshness = syncFreshness(snapshot, realData, fullSyncAttestation);
  // Settings already wraps this panel in its Connection details disclosure.
  const DetailContainer = realData ? Fragment : Details;
  return (
    <section className="mt-8 rounded-lg border bg-card p-5" aria-label="Mock scan progress">
      <h2 className="text-xl font-semibold">Demo — mock scan progress</h2>
      {/* #87: one short status line by default; run states, retries and the #21 lines sit under Details. */}
      {state.unavailable ? (
        <p role="alert" className="text-sm">
          Progress is unavailable or the outcome is unknown. Saved data remains visible.{" "}
          <button className="underline" onClick={() => void controller?.reconnect()}>
            Reconnect
          </button>
        </p>
      ) : !state.current?.courseIds.length ? (
        <p className="text-sm">
          Select courses in{" "}
          <Link to="/settings" className="underline">
            Settings
          </Link>{" "}
          to start a mock run.
        </p>
      ) : run ? (
        <p className="text-sm">
          {active ? "Mock run in progress" : "Last mock run finished"}: {run.progress.completed} of{" "}
          {run.progress.total} courses done.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Demonstration only: nothing is read from Moodle.
        </p>
      )}
      <DetailContainer>
        <p>Demonstration only: this does not contact Moodle or refresh saved data.</p>
        {state.unavailable && <p>Reconnect and read back before retrying.</p>}
        {state.uncertain && (
          <p>
            An earlier request may have completed. Reconnect and read back; an explicit retry uses
            the same unresolved key.
          </p>
        )}
        {run && !state.unavailable && (
          <div>
            <p>
              Mock run: {run.status} · {run.progress.completed}/{run.progress.total} completed
            </p>
            <ul>
              {run.jobs.map((j) => (
                <li key={j.id}>
                  {snapshot.courses.find((c) => c.id === j.courseId)?.name ?? j.courseId}: {j.state}
                </li>
              ))}
            </ul>
          </div>
        )}
        {state.current?.lastFailedRun && (
          <p>
            Last failed mock attempt started:{" "}
            {friendlyInstant(
              state.current.lastFailedRun.createdAt * 1000,
              snapshot.settings.timezone,
            )}
          </p>
        )}
        {/* #21 AC2 lines stay verbatim. */}
        <p>{freshness.fullSync}</p>
        <p>{freshness.pageRefresh}</p>
        {freshness.courses.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </DetailContainer>
      <div className="mt-2 flex gap-3">
        <button
          className="rounded border px-3 py-1"
          disabled={state.busy || state.unavailable || !state.current?.courseIds.length || !!active}
          onClick={() => void controller?.start()}
        >
          {run && !active ? "Retry mock run" : "Start mock run"}
        </button>
        <button
          className="rounded border px-3 py-1"
          disabled={state.busy || state.unavailable || !active}
          onClick={() => void controller?.cancel()}
        >
          Cancel mock run
        </button>
      </div>
      <details className="mt-3 text-sm">
        <summary>Mock examples</summary>
        <p>
          Example — Partial: some courses completed, others remain incomplete. Retry the mock run.
        </p>
        <p>Example — Failed: a mock job failed. Retry the mock run.</p>
        <p>Example — Cancelled: the mock run was cancelled. Start another mock run.</p>
        <button
          className="underline"
          disabled={state.busy || state.unavailable || !state.current?.courseIds.length || !!active}
          onClick={() => void controller?.start()}
        >
          Retry a mock run
        </button>
        <p>
          Example — Signed out:{" "}
          <a className="underline" href="https://moodle.sdu.edu.kz/login/index.php">
            Sign in to SDU Moodle
          </a>
          , then retry when live scanning is available. This example does not describe your current
          session.
        </p>
      </details>
    </section>
  );
}
