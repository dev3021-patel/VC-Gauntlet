#!/usr/bin/env python3
"""Verify that the bottom-right Player actions (Change avatar) stay inside the viewport."""

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parents[1]
VIEWPORTS = ((375, 667), (1280, 720))
SELECTORS = (".avatar-change-control",)


def disjoint(first: dict[str, float], second: dict[str, float]) -> bool:
    return (
        first["x"] + first["width"] <= second["x"]
        or second["x"] + second["width"] <= first["x"]
        or first["y"] + first["height"] <= second["y"]
        or second["y"] + second["height"] <= first["y"]
    )


async def main() -> None:
    styles = (ROOT / "src/styles.css").read_text()
    markup = """
      <main class="map-viewport">
        <div class="game-action-controls" role="group" aria-label="Player actions">
          <button class="avatar-change-control" type="button">Change avatar</button>
        </div>
      </main>
    """

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        page = await browser.new_page()
        for width, height in VIEWPORTS:
            await page.set_viewport_size({"width": width, "height": height})
            await page.set_content(f"<style>{styles}</style>{markup}")
            boxes = {}
            for selector in SELECTORS:
                box = await page.locator(selector).bounding_box()
                assert box is not None, f"{selector} is not rendered at {width}x{height}"
                assert box["x"] >= 0 and box["y"] >= 0, f"{selector} starts outside {width}x{height}: {box}"
                assert box["x"] + box["width"] <= width, f"{selector} exceeds viewport width at {width}x{height}: {box}"
                assert box["y"] + box["height"] <= height, f"{selector} exceeds viewport height at {width}x{height}: {box}"
                boxes[selector] = box

            for index, first_selector in enumerate(SELECTORS):
                for second_selector in SELECTORS[index + 1 :]:
                    assert disjoint(boxes[first_selector], boxes[second_selector]), (
                        f"{first_selector} overlaps {second_selector} at {width}x{height}: "
                        f"{boxes[first_selector]} vs {boxes[second_selector]}"
                    )

            z_index = await page.locator(".game-action-controls").evaluate(
                "element => getComputedStyle(element).zIndex"
            )
            assert z_index == "5", f"unexpected action stack z-index at {width}x{height}: {z_index}"
            print(f"{width}x{height}: {len(SELECTORS)} action bound(s) visible inside the viewport")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
