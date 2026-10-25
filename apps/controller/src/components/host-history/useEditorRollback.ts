"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { EditorRollback } from "./RollbackNotice";

type Loaded<Host> = { host: Host; notice: EditorRollback; agentIds: number[] };
type Answer<Host> = { ok: true; rollback: Loaded<Host> | null } | { ok: false; message: string };

/**
 * The revision named by `?revision=`, read through an action: the edit page's layout, which holds
 * the editor across its sections, never sees the query string. Undefined while it loads; null with
 * none named, or one that is not this host's, and the editor opens on the stored host.
 */
export function useEditorRollback<Host>(
  load: (revisionId: number) => Promise<Answer<Host>>,
): Loaded<Host> | null | undefined {
  const raw = useSearchParams().get("revision");
  const revisionId = raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
  const [loaded, setLoaded] = useState<{ id: number; value: Loaded<Host> | null } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is what the read depends on.
  useEffect(() => {
    if (revisionId === null) return;
    let current = true;
    void load(revisionId).then((answer) => {
      if (!current) return;
      if (!answer.ok) toast.error(answer.message);
      setLoaded({ id: revisionId, value: answer.ok ? answer.rollback : null });
    });
    return () => {
      current = false;
    };
  }, [revisionId]);

  if (revisionId === null) return null;
  return loaded?.id === revisionId ? loaded.value : undefined;
}
