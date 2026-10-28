import { useEffect, useRef } from "react";

// Browsers require their own dialog for closing/back navigation; internal links can be clearer.
export function useUnsavedWarning(dirty: boolean) {
  const leaving = useRef(false);
  useEffect(() => {
    if (!dirty) {
      leaving.current = false;
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      if (leaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return () => {
    if (!dirty) return true;
    if (!window.confirm("You have unsaved changes. Leave without saving?"))
      return false;
    leaving.current = true;
    // If navigation fails, later close/back attempts must still warn about this draft.
    window.setTimeout(() => {
      leaving.current = false;
    }, 1000);
    return true;
  };
}
