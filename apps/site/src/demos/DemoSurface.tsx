import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeContext, registerTheme } from "@astryxdesign/core/theme";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { LinkProvider } from "@astryxdesign/core/Link";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { IntlProvider } from "use-intl";
import messages from "@cpm/controller/messages/en.json";
import { DemoLink } from "./DemoLink";
import "./demo.css";

// The theme's CSS ships pre-built, so registering is all that is left to do and it is idempotent.
registerTheme(neutralTheme);

type Mode = "light" | "dark";

/** Whatever Starlight's theme select last chose. It writes `data-theme` on <html>, as Astryx does. */
function readMode(): Mode {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useStarlightMode(): Mode {
  const [mode, setMode] = useState<Mode>(readMode);

  useEffect(() => {
    const observer = new MutationObserver(() => setMode(readMode()));
    observer.observe(document.documentElement, {
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return mode;
}

/**
 * The slice of the app shell a demo needs: Astryx's theme surface and the real message catalog.
 * Not Astryx's `<Theme>`: the first in a tree syncs its attributes onto `<html>`, fighting
 * Starlight's colour mode and restyling the whole docs site.
 */
export function DemoSurface({ children }: { children: ReactNode }) {
  const mode = useStarlightMode();
  const theme = useMemo(() => ({ theme: neutralTheme, mode }), [mode]);

  return (
    <ThemeContext value={theme}>
      {/* A fixed zone, not the reader's: the demos render dates only as examples, and letting the
          server and the browser disagree about the zone would be a hydration mismatch. */}
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <InternationalizationProvider locale="en">
          <div
            className="cpm-demo"
            data-astryx-theme={neutralTheme.name}
            data-theme={mode}
            style={{ colorScheme: mode }}
          >
            {/* Every Astryx link renders through DemoLink, as next/link does by alias. */}
            <LinkProvider component={DemoLink}>{children}</LinkProvider>
          </div>
        </InternationalizationProvider>
      </IntlProvider>
    </ThemeContext>
  );
}
