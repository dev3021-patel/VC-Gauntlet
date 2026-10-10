#!/usr/bin/env python3
"""Verify the How to play button and panel layout at desktop and phone viewports.

Renders `src/styles.css` with mirrored signed-in HUD markup and asserts that:

- the How to play button is the first control-dock slot, at least 44 px tall,
  inside the viewport, and disjoint from every other HUD region in normal view
  and clean view (touch viewports include the virtual control pad);
- the rest of the control dock still clears the HUD;
- the open panel fits inside the viewport, its close and Got it buttons are at
  least 44 px and visible without scrolling the page or the panel, the page
  itself never becomes scrollable, and only the controls list scrolls (the
  outer panel and the objective stay fixed).

Update the mirrored markup whenever the dock, the panel, or a nearby HUD region
changes (see `.party/how-to-play.md`).
"""

import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parents[1]
# (width, height, touch) — touch emulates a coarse pointer, like phones and the Party app.
VIEWPORTS = ((1280, 720, False), (1024, 640, False), (390, 844, True), (375, 667, True), (844, 390, True))
MIN_TARGET = 44

HUD = """
    <header class="brand-panel"><div class="brand-mark"><span></span><span></span><span></span></div><div><p class="eyebrow">The shared frontier</p><h1>Party Conquest</h1></div></header>
    <aside class="world-badge" aria-label="World information"><span class="status-dot status-dot--connected"></span><span>World 01</span><span class="badge-divider"></span><span class="world-size">80 × 80 blocks</span><span class="badge-divider"></span><span class="backend-status">Synced · r12345</span></aside>
    <div class="navigation-help"><span class="desktop-help">Scroll to pan · ⌘/Ctrl + scroll to zoom · Middle-drag to pan</span><span class="mobile-help">Drag to pan · Pinch to zoom · Hold arrows to move</span></div>
"""

GAMEPLAY = """
    <div class="game-action-controls" role="group" aria-label="Player actions">
      <button class="avatar-change-control" type="button">Change avatar</button>
    </div>
"""

PAD = """
    <div class="virtual-controls" role="group" aria-label="Touch controls">
      <div class="virtual-dpad" role="group" aria-label="Movement">
        <button type="button" class="virtual-dpad-north"><span>▲</span></button>
        <button type="button" class="virtual-dpad-west"><span>◀</span></button>
        <button type="button" class="virtual-dpad-east"><span>▶</span></button>
        <button type="button" class="virtual-dpad-south"><span>▼</span></button>
      </div>
      <div class="virtual-actions" role="group" aria-label="Actions">
        <button type="button" class="virtual-action-fire"><span>FIRE</span></button>
      </div>
    </div>
"""


def dock(clean: bool) -> str:
    views = (
        '<button type="button" class="restore-ui"><span>▣</span><span>Restore UI</span></button>'
        if clean else
        '<button type="button"><span>◻</span><span>Clean view</span></button>'
    )
    return f"""
    <div class="control-dock">
      <button type="button" class="how-to-play-button how-to-play-button--highlight"><span>?</span><span>How to play</span></button>
      <nav class="view-controls" aria-label="View options">{views}<button type="button"><span>⤢</span><span>Fullscreen</span></button></nav>
      <nav class="map-controls" aria-label="Map navigation">
        <button type="button"><span>+</span></button><output>100%</output><button type="button"><span>−</span></button>
        <span class="control-divider"></span>
        <button type="button" class="fit-button"><span>◎</span><span>My player</span></button>
        <button type="button" class="fit-button"><span>⌗</span><span>Fit world</span></button>
      </nav>
    </div>
"""


PANEL = """
<div class="how-to-play-backdrop">
  <section class="how-to-play-panel" role="dialog" aria-modal="true">
    <header class="how-to-play-header"><div><p class="eyebrow">New to the frontier?</p><h2>How to play</h2></div><button type="button" class="how-to-play-close"><span>×</span></button></header>
    <div class="how-to-play-body">
      <section class="how-to-play-objective"><h3>Objective</h3><p>Roam the shared world and battle other players and mobs. The world never resets, so if you fall, rejoin and keep going.</p><p>You're an archer: your bow shoots an arrow up to 4 squares the way you're facing. Trees, walls, and water stop it. One arrow defeats a player; mobs take 3.</p></section>
      <section class="how-to-play-controls-section"><h3>Controls</h3><div class="how-to-play-controls-scroll" tabindex="0"><dl class="how-to-play-controls">{rows}</dl></div></section>
    </div>
    <footer class="how-to-play-footer"><p>Reopen this any time with <strong>How to play</strong> in the control dock.</p><button type="button" class="primary-button">Got it</button></footer>
  </section>
</div>
"""
ROW = '<div class="how-to-play-control"><dt><kbd>Space</kbd></dt><dd>Fire</dd></div>'

HUD_REGIONS = (
    ".brand-panel", ".world-badge", ".navigation-help", ".game-action-controls", ".virtual-dpad", ".virtual-actions",
)
DOCK_SLOTS = (".view-controls", ".map-controls")


def disjoint(first: dict[str, float], second: dict[str, float]) -> bool:
    return (
        first["x"] + first["width"] <= second["x"]
        or second["x"] + second["width"] <= first["x"]
        or first["y"] + first["height"] <= second["y"]
        or second["y"] + second["height"] <= first["y"]
    )


def inside(box: dict[str, float], width: float, height: float) -> bool:
    return box["x"] >= 0 and box["y"] >= 0 and box["x"] + box["width"] <= width and box["y"] + box["height"] <= height


async def boxes_for(page, selectors):
    found = {}
    for selector in selectors:
        locator = page.locator(selector)
        if await locator.count() == 0:
            continue
        box = await locator.bounding_box()
        if box is not None:  # hidden regions (e.g. the landscape touch caption) have no box
            found[selector] = box
    return found


async def check_hud(page, width, height, touch, clean, styles):
    viewport_class = "map-viewport" + (" map-viewport--touch" if touch else "") + (" map-viewport--clean" if clean else "")
    content = ("" if clean else HUD) + GAMEPLAY + (PAD if touch else "") + dock(clean)
    await page.set_content(f'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>{styles}</style><div id="root"><main class="game-shell"><section class="{viewport_class}">{content}</section></main></div>')
    label = f"{width}x{height}{' clean' if clean else ''}"
    first = await page.evaluate("document.querySelector('.control-dock').firstElementChild.className")
    assert "how-to-play-button" in first, f"How to play is not the first dock slot at {label}: {first}"
    button = await page.locator(".how-to-play-button").bounding_box()
    assert button is not None, f"How to play is not rendered at {label}"
    assert button["height"] >= MIN_TARGET, f"How to play is under {MIN_TARGET}px tall at {label}: {button}"
    assert inside(button, width, height), f"How to play leaves the viewport at {label}: {button}"
    text = await page.locator(".how-to-play-button > span:last-child").bounding_box()
    assert text is not None and text["width"] > 0, f"How to play label is hidden at {label}"
    hud = await boxes_for(page, HUD_REGIONS)
    slots = await boxes_for(page, DOCK_SLOTS)
    for selector, box in {**hud, **slots}.items():
        assert disjoint(button, box), f"How to play overlaps {selector} at {label}: {button} vs {box}"
    for slot, box in slots.items():
        assert inside(box, width, height), f"{slot} leaves the viewport at {label}: {box}"
        for selector, other in hud.items():
            assert disjoint(box, other), f"{slot} overlaps {selector} at {label}: {box} vs {other}"
    return label


async def check_panel(page, width, height, styles):
    await page.set_content(f'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>{styles}</style><div id="root"><main class="game-shell"><section class="map-viewport"></section></main></div>{PANEL.format(rows=ROW * 6)}')
    panel = await page.locator(".how-to-play-panel").bounding_box()
    assert panel is not None and inside(panel, width, height), f"panel leaves the viewport at {width}x{height}: {panel}"
    for selector in (".how-to-play-close", ".how-to-play-footer .primary-button"):
        box = await page.locator(selector).bounding_box()
        assert box is not None, f"{selector} is not rendered at {width}x{height}"
        assert box["height"] >= MIN_TARGET and box["width"] >= MIN_TARGET, f"{selector} is under {MIN_TARGET}px at {width}x{height}: {box}"
        assert inside(box, width, height), f"{selector} is off screen at {width}x{height}: {box}"
        assert inside({**box, "x": box["x"] - panel["x"], "y": box["y"] - panel["y"]}, panel["width"], panel["height"]), f"{selector} is clipped by the panel at {width}x{height}"
    scroll = await page.evaluate("[document.scrollingElement.scrollHeight, document.scrollingElement.scrollWidth]")
    assert scroll[0] <= height and scroll[1] <= width, f"the page scrolls with the panel open at {width}x{height}: {scroll}"
    # The outer panel is fixed: only the controls list scrolls, and the objective stays fully visible.
    body = await page.evaluate("(() => { const b = document.querySelector('.how-to-play-body'); return [b.scrollHeight, b.clientHeight] })()")
    assert body[0] <= body[1] + 1, f"the panel body overflows instead of the controls list at {width}x{height}: {body}"
    objective = await page.locator(".how-to-play-objective").bounding_box()
    scroller = await page.locator(".how-to-play-controls-scroll").bounding_box()
    assert objective is not None and objective["y"] + objective["height"] <= scroller["y"], f"objective is clipped at {width}x{height}"
    assert scroller["height"] >= 72, f"the controls list has no room to scroll at {width}x{height}: {scroller}"
    return await page.evaluate("(() => { const s = document.querySelector('.how-to-play-controls-scroll'); return s.scrollHeight > s.clientHeight })()")


async def main(screenshot_dir: Path | None) -> None:
    styles = (ROOT / "src/styles.css").read_text()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        for width, height, touch in VIEWPORTS:
            context = await browser.new_context(viewport={"width": width, "height": height}, has_touch=touch, is_mobile=touch)
            page = await context.new_page()
            for clean in (False, True):
                label = await check_hud(page, width, height, touch, clean, styles)
                if screenshot_dir:
                    screenshot_dir.mkdir(parents=True, exist_ok=True)
                    await page.screenshot(path=str(screenshot_dir / f"how-to-play-dock-{label.replace(' ', '-')}.png"))
            body_scrolls = await check_panel(page, width, height, styles)
            if screenshot_dir:
                await page.screenshot(path=str(screenshot_dir / f"how-to-play-panel-{width}x{height}.png"))
            print(f"{width}x{height}: button clears the HUD in normal and clean view; panel fits{' (controls list scrolls)' if body_scrolls else ''}")
            await context.close()
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1]) if len(sys.argv) > 1 else None))
