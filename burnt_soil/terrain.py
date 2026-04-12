from __future__ import annotations

import math
import random


class Terrain:
    def __init__(self, width: int, height: int, seed: int | None = None) -> None:
        self.width = width
        self.height = height
        self.random = random.Random(seed)
        self.heights = self._generate_heights()

    def _generate_heights(self) -> list[int]:
        base = int(self.height * 0.62)
        heights: list[int] = []
        phase_a = self.random.uniform(0.0, math.tau)
        phase_b = self.random.uniform(0.0, math.tau)
        phase_c = self.random.uniform(0.0, math.tau)
        for x in range(self.width):
            contour = (
                math.sin((x / self.width) * math.tau * 1.35 + phase_a) * 82
                + math.sin((x / self.width) * math.tau * 3.2 + phase_b) * 27
                + math.cos((x / self.width) * math.tau * 6.1 + phase_c) * 14
            )
            noise = self.random.randint(-10, 10)
            height = int(base + contour + noise)
            heights.append(max(int(self.height * 0.35), min(self.height - 85, height)))

        for _ in range(5):
            smoothed = heights[:]
            for x in range(2, self.width - 2):
                smoothed[x] = int(
                    (
                        heights[x - 2]
                        + (heights[x - 1] * 2)
                        + (heights[x] * 3)
                        + (heights[x + 1] * 2)
                        + heights[x + 2]
                    )
                    / 9
                )
            heights = smoothed
        return heights

    def surface_y(self, x: float) -> int:
        index = max(0, min(self.width - 1, int(x)))
        return self.heights[index]

    def is_solid(self, x: float, y: float) -> bool:
        if x < 0 or x >= self.width:
            return False
        return y >= self.surface_y(x)

    def make_landing_pad(self, center_x: int, half_width: int) -> None:
        left = max(0, center_x - half_width)
        right = min(self.width - 1, center_x + half_width)
        target_height = min(self.heights[left:right + 1])
        for x in range(left, right + 1):
            self.heights[x] = target_height

        feather = 20
        for offset in range(1, feather + 1):
            blend = offset / feather
            if left - offset >= 0:
                self.heights[left - offset] = int(
                    self.heights[left - offset] * blend + target_height * (1.0 - blend)
                )
            if right + offset < self.width:
                self.heights[right + offset] = int(
                    self.heights[right + offset] * blend + target_height * (1.0 - blend)
                )

    def carve_circle(self, center: tuple[int, int], radius: int) -> tuple[int, int]:
        cx, cy = center
        left = max(0, cx - radius)
        right = min(self.width - 1, cx + radius)
        radius_sq = radius * radius
        for x in range(left, right + 1):
            dx = x - cx
            remainder = radius_sq - (dx * dx)
            if remainder <= 0:
                continue
            depth = int(math.sqrt(remainder))
            bottom = min(self.height - 1, cy + depth)
            if self.heights[x] < bottom:
                self.heights[x] = bottom

        self._relax(left, right)
        return left, right

    def _relax(self, left: int, right: int) -> None:
        left = max(1, left - 10)
        right = min(self.width - 2, right + 10)
        for _ in range(18):
            for x in range(left, right):
                delta_left = self.heights[x] - self.heights[x - 1]
                if delta_left > 9:
                    shift = (delta_left - 9) // 2 + 1
                    self.heights[x - 1] += shift
                    self.heights[x] -= shift

                delta_right = self.heights[x] - self.heights[x + 1]
                if delta_right > 9:
                    shift = (delta_right - 9) // 2 + 1
                    self.heights[x + 1] += shift
                    self.heights[x] -= shift

    def polygon(self) -> list[tuple[int, int]]:
        points = [(0, self.height)]
        points.extend((x, y) for x, y in enumerate(self.heights))
        points.append((self.width - 1, self.height))
        return points