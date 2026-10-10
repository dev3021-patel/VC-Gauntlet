#!/usr/bin/env python3
"""Verify the virtual touch control pad layout at phone viewports.

Renders `src/styles.css` with mirrored touch-mode markup and asserts that every
pad button is at least 48 CSS pixels, stays inside the viewport, that the
touch-mode regions (pad, dock, caption, Player actions strip) do not
overlap each other or the fixed HUD, and that none of them covers the screen
centre where the camera keeps the local player. The How to play button must
be the first dock slot, keep its text label, be at least 44 px tall, and clear
every other region.
"""

import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parents[1]
VIEWPORTS = ((360, 780), (390, 844), (844, 390))
MIN_TARGET = 48
MIN_DOCK_TARGET = 44
PAD_BUTTONS = (
    ".virtual-dpad-north", ".virtual-dpad-south", ".virtual-dpad-west", ".virtual-dpad-east",
    ".virtual-action-fire",
)
REGIONS = (".how-to-play-button", ".virtual-dpad", ".virtual-actions", ".game-action-controls", ".control-dock", ".navigation-help", ".world-badge", ".brand-panel")
# Regions this layout positions in touch mode; only pairs involving one of these are checked.
OWNED = {".how-to-play-button", ".virtual-dpad", ".virtual-actions", ".game-action-controls", ".control-dock", ".navigation-help"}

MARKUP = """
<div id="root">
  <main class="map-viewport map-viewport--touch">
    <aside class="brand-panel"><h1>Party Conquest</h1></aside>
    <aside class="world-badge" aria-label="World information"><span>World 01</span><span class="backend-status">Synced · r1</span></aside>
    <div class="game-action-controls" role="group" aria-label="Player actions">
      <button class="avatar-change-control" type="button">Change avatar</button>
    </div>
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
    <div class="navigation-help"><span class="desktop-help">Scroll to pan</span><span class="mobile-help">Drag to pan · Pinch to zoom · Hold arrows to move</span></div>
    <div class="control-dock">
      <button type="button" class="how-to-play-button"><span class="control-icon">?</span><span>How to play</span></button>
      <nav class="view-controls" aria-label="View options">
        <button type="button"><span class="control-icon">◻</span><span>Clean view</span></button>
        <button type="button"><span class="control-icon">⤢</span><span>Fullscreen</span></button>
      </nav>
      <nav class="map-controls" aria-label="Map navigation">
        <button type="button"><span class="control-icon">+</span></button>
        <output>100%</output>
        <button type="button"><span class="control-icon">−</span></button>
        <span class="control-divider"></span>
        <button type="button" class="fit-button"><span class="control-icon">◎</span><span>My player</span></button>
        <button type="button" class="fit-button"><span class="control-icon">⌗</span><span>Fit world</span></button>
      </nav>
    </div>
  </main>
</div>
"""


def disjoint(first: dict[str, float], second: dict[str, float]) -> bool:
    return (
        first["x"] + first["width"] <= second["x"]
        or second["x"] + second["width"] <= first["x"]
        or first["y"] + first["height"] <= second["y"]
        or second["y"] + second["height"] <= first["y"]
    )


async def main(screenshot_dir: Path | None) -> None:
    styles = (ROOT / "src/styles.css").read_text()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        # Emulate a coarse pointer so the stylesheet's mobile breakpoint applies at every size.
        context = await browser.new_context(has_touch=True, is_mobile=True)
        page = await context.new_page()
        for width, height in VIEWPORTS:
            await page.set_viewport_size({"width": width, "height": height})
            await page.set_content(f'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>{styles}</style>{MARKUP}')
            for selector in PAD_BUTTONS:
                box = await page.locator(selector).bounding_box()
                assert box is not None, f"{selector} is not rendered at {width}x{height}"
                assert box["width"] >= MIN_TARGET and box["height"] >= MIN_TARGET, f"{selector} is under {MIN_TARGET}px at {width}x{height}: {box}"
                assert box["x"] >= 0 and box["y"] >= 0, f"{selector} starts outside {width}x{height}: {box}"
                assert box["x"] + box["width"] <= width and box["y"] + box["height"] <= height, f"{selector} exceeds {width}x{height}: {box}"
            first_slot = await page.evaluate("document.querySelector('.control-dock').firstElementChild.className")
            assert "how-to-play-button" in first_slot, f"How to play is not the first dock slot at {width}x{height}: {first_slot}"
            how_to_play = await page.locator(".how-to-play-button").bounding_box()
            label = await page.locator(".how-to-play-button > span:last-child").bounding_box()
            assert how_to_play is not None and how_to_play["height"] >= MIN_DOCK_TARGET, f"How to play is under {MIN_DOCK_TARGET}px at {width}x{height}: {how_to_play}"
            assert label is not None and label["width"] > 0, f"How to play lost its text label at {width}x{height}"
            boxes = {}
            for selector in REGIONS:
                box = await page.locator(selector).bounding_box()
                if selector == ".navigation-help" and box is None:
                    continue  # hidden on landscape phones in touch mode
                assert box is not None, f"{selector} is not rendered at {width}x{height}"
                assert box["x"] >= 0 and box["y"] >= 0, f"{selector} starts outside {width}x{height}: {box}"
                assert box["x"] + box["width"] <= width and box["y"] + box["height"] <= height, f"{selector} exceeds {width}x{height}: {box}"
                boxes[selector] = box
            # Only pairs involving a region this layout positions are checked; the help
            # caption and dock placement predate the pad and are covered elsewhere.
            names = list(boxes)
            for index, first in enumerate(names):
                for second in names[index + 1:]:
                    if first not in OWNED and second not in OWNED:
                        continue
                    # The button is a dock slot, so it sits inside the dock by design.
                    if {first, second} == {".how-to-play-button", ".control-dock"}:
                        continue
                    assert disjoint(boxes[first], boxes[second]), f"{first} overlaps {second} at {width}x{height}: {boxes[first]} vs {boxes[second]}"
            # The camera centres the local player, so nothing owned may cover the screen centre.
            centre = (width / 2, height / 2)
            for selector, box in boxes.items():
                if selector not in OWNED:
                    continue
                covers = box["x"] <= centre[0] <= box["x"] + box["width"] and box["y"] <= centre[1] <= box["y"] + box["height"]
                assert not covers, f"{selector} covers the screen centre at {width}x{height}: {box}"
            if screenshot_dir:
                screenshot_dir.mkdir(parents=True, exist_ok=True)
                await page.screenshot(path=str(screenshot_dir / f"touch-controls-{width}x{height}.png"))
            print(f"{width}x{height}: pad targets are at least {MIN_TARGET}px, How to play leads the dock, and regions are pairwise disjoint")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1]) if len(sys.argv) > 1 else None))
