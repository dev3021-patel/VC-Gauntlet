import { App as DemoApp } from "./App";
import { LiveDebate } from "./LiveDebate";

export function RootApp() {
  const live = new URLSearchParams(window.location.search).get("mode") === "live";
  return <>
    <nav className="app-modes" aria-label="Experience">
      <a href="/?mode=demo" aria-current={!live ? "page" : undefined}>Demo · sample scenario</a>
      <a href="/?mode=live" aria-current={live ? "page" : undefined}>Live · AI committee</a>
    </nav>
    {live ? <LiveDebate /> : <DemoApp />}
  </>;
}
