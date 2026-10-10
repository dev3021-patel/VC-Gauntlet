import { App as CommitteeApp } from "./App";
import { LiveDebate } from "./LiveDebate";

export function RootApp() {
  const mode = new URLSearchParams(window.location.search).get("mode");
  const console = mode === "live" || mode === "console";
  return <>
    <nav className="app-modes" aria-label="Experience">
      <a href="/" aria-current={!console ? "page" : undefined}>Committee · five screens (live, demo on request)</a>
      <a href="/?mode=console" aria-current={console ? "page" : undefined}>Console · live transcript</a>
    </nav>
    {console ? <LiveDebate /> : <CommitteeApp />}
  </>;
}
