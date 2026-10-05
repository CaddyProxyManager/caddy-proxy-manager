"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { HostEditorOptions } from "@/lib/proxy-hosts/editor-options";
import { hostEditorOptionsAction } from "./actions";

/**
 * The pickers' options, read once the first time `wanted` turns true and kept for the page's life.
 * `onFailed` closes whatever was waiting for them.
 */
export function useHostEditorOptions(
  wanted: boolean,
  onFailed: () => void,
): HostEditorOptions | null {
  const [options, setOptions] = useState<HostEditorOptions | null>(null);
  const reading = useRef(false);
  const failed = useRef(onFailed);
  failed.current = onFailed;

  const read = useCallback(() => {
    if (reading.current) return;
    reading.current = true;
    void hostEditorOptionsAction().then((result) => {
      if (result.ok) {
        setOptions(result.options);
        return;
      }
      // Asked again the next time something wants them.
      reading.current = false;
      toast.error(result.message);
      failed.current();
    });
  }, []);

  useEffect(() => {
    if (wanted && !options) read();
  }, [wanted, options, read]);

  return options;
}
