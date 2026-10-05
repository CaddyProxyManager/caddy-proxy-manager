import { type ReactNode, useMemo, useSyncExternalStore } from "react";
import { ThemeContext, registerTheme } from "@astryxdesign/core/theme";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { LinkProvider } from "@astryxdesign/core/Link";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { StandalonePage } from "@cpm/controller/src/components/ui/standalone-page";
import { IntlProvider } from "use-intl";
import { messages } from "./catalog";
import { DemoLink } from "./DemoLink";
import "./demo.css";

// The theme's CSS ships pre-built, so registering is all that is left to do and it is idempotent.
registerTheme(neutralTheme);

type Mode = "light" | "dark";

/** Whatever Starlight's theme select last chose. It writes `data-theme` on <html>, as Astryx does. */
function readMode(): Mode {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/**
 * Dark on the server, then the reader's mode right after hydrating. Read straight into the first
 * client render, a light reader's demo kept the server's `data-theme="dark"`: React leaves a
 * mismatched attribute as the server wrote it, so light pages showed dark-mode text.
 */
function useStarlightMode(): Mode {
  return useSyncExternalStore(subscribe, readMode, () => "dark");
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
            <LinkProvider component={DemoLink}>
              <StandalonePage value={false}>{children}</StandalonePage>
            </LinkProvider>
          </div>
        </InternationalizationProvider>
      </IntlProvider>
    </ThemeContext>
  );
}
